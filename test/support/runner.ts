import type { NeedFailed as NeedFailedError } from "@bjornpagen/testing/property"
import { NeedFailed } from "@bjornpagen/testing/property"
import {
	DatabasePrefix,
	PgCluster,
	type PgMember,
	type PgSession
} from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Layer, Option, Scope } from "effect"
import { readFamily } from "#pg/family.ts"
import { type LocalCluster, localCluster } from "#pg/local-cluster.ts"
import { type InitializedClusterShape, readCluster } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { type PgConnection, session, type SqlError } from "#test/support/pg.ts"
import type { BudgetedCluster } from "#test/support/substrate/budget.ts"
import { leaseOn } from "#test/support/substrate/shared.ts"

/**
 * grizzle's services for the toolchain's runner (`toolchain-test`, test.config.ts): the local cluster family as the
 * cluster every database need of a property clones from (@bjornpagen/testing/resources PgCluster).
 *
 * A worker reaches one member of the family for its life, worker i of a run member i mod K (PgCluster memberOf), and
 * takes one connection lease there (substrate/shared.ts takeLease over the cluster's substrate_lease tables) the first
 * time a need of its reaches the member: every connection the worker opens on the member draws from the lease's budget,
 * the toolchain's owner and builder sessions (`connect`) as much as a case's substrate, sessions and psql writers. So
 * the workers of every run on a family hold at most the connections the members were sized for, as the Vitest files'
 * leases do beside them.
 */
declare module "@bjornpagen/testing/property" {
	interface RunnerServices {
		readonly cluster: PgCluster
	}
}

declare module "@bjornpagen/testing/resources" {
	interface PgMember {
		/** What scripts/pg/init.sh made of the member: its port, socket, CA certificates and owner password. */
		readonly initialized: InitializedClusterShape
		/**
		 * The worker's lease on the member with the budget it grants (shared.ts leaseOn), taken the first time it is asked
		 * for and held for the worker's life.
		 */
		readonly leased: Effect.Effect<BudgetedCluster, NeedFailedError>
	}
	interface PgSession {
		/** The owner's connection the session runs on (ownerSession), for grizzle's code over the same session. */
		readonly connection: PgConnection
	}
}

/**
 * A statement's failure as the need `need` failed by it: what the need was doing, and the server's report (its SQLSTATE
 * and message) or the connection's.
 */
export const sqlNeedFailed = (need: string, doing: string) => (error: SqlError) =>
	NeedFailed.make({
		need,
		message: `${doing}: ${
			error.reason._tag === "ServerError"
				? `${error.reason.fields.code} ${error.reason.fields.message}`
				: error.reason.message
		}`
	})

/** A failure of the cluster's own machinery, as sqlNeedFailed names it. */
const clusterFailed = (doing: string) => sqlNeedFailed("grizzle cluster", doing)

/**
 * The prefix of every database the toolchain names on grizzle's clusters: `gz_tpl_<digest>` for a template and
 * `gz_c_<owner>_<n>` for a clone, apart from the Vitest tier's gz_t_, gz_doctor_ and gz_shared_ databases, which
 * shared.ts sweeps.
 */
const prefix = DatabasePrefix("gz_")

/**
 * A member as this worker reaches it: named by its port, with its files, and its lease taken in `scope`, the worker's,
 * once (Effect.cached), so a worker whose needs never reach the member never leases there.
 */
const memberOf = (
	initialized: InitializedClusterShape,
	scope: Scope.Scope
): Effect.Effect<PgMember> =>
	Effect.map(
		Effect.cached(
			Effect.mapBoth(Scope.provide(leaseOn(initialized), scope), {
				onSuccess: (lease) => lease.cluster,
				onFailure: clusterFailed(`the connection lease on member ${initialized.port}`)
			})
		),
		(leased): PgMember => ({ name: String(initialized.port), initialized, leased })
	)

/**
 * The family GRIZZLE_PG_CLUSTER names, as its family file records it (packages/pg/src/family.ts readFamily), each
 * member read from its state directory: an unrecorded family or an uninitialised member fails every need that reaches
 * the cluster, naming the command that makes it.
 */
const membersOf = (
	scope: Scope.Scope
): Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, NeedFailedError, FileSystem.FileSystem> =>
	Effect.mapError(
		Effect.gen(function* () {
			const family = yield* readFamily(localCluster)
			const read = (member: LocalCluster) =>
				Effect.flatMap(readCluster(member), (initialized) => memberOf(initialized, scope))
			const first = yield* read(Arr.headNonEmpty(family.members))
			const rest = yield* Effect.forEach(Arr.tailNonEmpty(family.members), read)
			return Arr.prepend(rest, first)
		}),
		(failure) => NeedFailed.make({ need: "grizzle cluster", message: failure.message })
	)

/**
 * A session as the owner, grizzle_dev, in `database` on `member`, drawing one of the worker's lease's permits for its
 * life: what the toolchain creates, clones, drops and builds templates with. Its statements cast every column they read
 * to text, so each value arrives as the server's text.
 */
const ownerSession = (
	member: PgMember,
	database: string
): Effect.Effect<PgSession, NeedFailedError, Scope.Scope> =>
	Effect.gen(function* () {
		const cluster = yield* member.leased
		const connection = yield* Effect.mapError(
			session(cluster, {
				database,
				username: pgPin.devRole,
				password: cluster.devPassword,
				applicationName: Option.some("grizzle-resources owner")
			}),
			clusterFailed(`a session in ${database} on member ${member.name}`)
		)
		return {
			connection,
			query: (sql, params) =>
				Effect.mapError(connection.queryValues(sql, params), clusterFailed(`${sql} in ${database}`))
		}
	})

/**
 * The runner layer test.config.ts provides: PgCluster over the family, its members read the first time a need asks
 * (PgCluster.layer reads nothing as it builds), templates built from grizzle_template, the toolchain's owner sessions and
 * advisory locks in the owner's own database, every session the owner's (ownerSession).
 */
export const grizzleCluster: Layer.Layer<PgCluster, never, FileSystem.FileSystem> = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const scope = yield* Effect.scope
		return PgCluster.layer({
			prefix,
			members: Effect.provideService(membersOf(scope), FileSystem.FileSystem, fs),
			base: pgPin.templateDatabase,
			maintenance: pgPin.devRole,
			connect: ownerSession
		})
	})
)
