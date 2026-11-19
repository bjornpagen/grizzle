import type { PgMember, Platform } from "@bjornpagen/testing/pg"
import type { Need, NeedFailed as NeedFailedError } from "@bjornpagen/testing/property"
import { NeedFailed } from "@bjornpagen/testing/property"
import { DatabasePrefix, PgCluster, type PgSession } from "@bjornpagen/testing/resources"
import { Context, Deferred, Effect, Layer, Option, Scope } from "effect"
import { pgCluster } from "#test/support/env.ts"
import { type PgConnection, type SqlError, textSession } from "#test/support/pg.ts"
import { type Lease, leaseOn } from "#test/support/substrate/shared.ts"

/**
 * grizzle's services for the toolchain's runner (`toolchain-test`, test.config.ts): its local cluster (pg.config.ts) as
 * the cluster every database need of a property clones from (@bjornpagen/testing/resources PgCluster), and the worker's
 * lease on each member it reaches (WorkerLeases).
 *
 * A worker reaches one member of the cluster for its life, worker i of a run member i mod K (PgCluster memberOf), and
 * takes one connection lease there (substrate/shared.ts takeLease over the member's substrate_lease tables) the first
 * time a need of its reaches the member: every connection the worker opens on the member draws from the lease's budget,
 * the toolchain's owner and builder sessions (`connect`) as much as a case's substrate, sessions and psql writers. So
 * the workers of every run on the cluster hold at most the connections its members were sized for, as the Vitest
 * files' leases do beside them.
 */
declare module "@bjornpagen/testing/property" {
	interface RunnerServices {
		readonly cluster: PgCluster
		readonly leases: WorkerLeases
	}
}

declare module "@bjornpagen/testing/resources" {
	interface PgSession {
		/**
		 * The owner's connection the session runs on (ownerSession), for grizzle's code over the same session: it reads every
		 * value as the server's text (pg.ts textSession).
		 */
		readonly connection: PgConnection
	}
}

/**
 * The worker's lease on each member of the cluster it reaches, with the budget it grants and the backend that holds it
 * (shared.ts leaseOn): taken the first time it is asked for on a member and held for the worker's life, so a worker
 * whose needs never reach a member never leases there.
 */
export class WorkerLeases extends Context.Service<
	WorkerLeases,
	Readonly<{ on: (member: PgMember) => Effect.Effect<Lease, NeedFailedError> }>
>()("grizzle-workspace/test/support/runner/WorkerLeases") {}

/** The worker's lease on `member` (WorkerLeases): what every connection the worker opens there draws from. */
export const memberLease = (
	member: PgMember
): Effect.Effect<Lease, NeedFailedError, WorkerLeases> =>
	Effect.flatMap(WorkerLeases, (leases) => leases.on(member))

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
 * `gz_c_<owner>_<n>` for a clone, apart from the Vitest tier's gz_t_ and gz_shared_ databases, which
 * shared.ts sweeps.
 */
const prefix = DatabasePrefix("gz_")

/**
 * The leases of one worker, by member name (WorkerLeases on): each taken in `scope`, the worker's, the first time it is
 * asked for on its member, every later ask awaiting the same.
 */
const workerLeases = (scope: Scope.Scope): Context.Service.Shape<typeof WorkerLeases> => {
	const leases = new Map<string, Deferred.Deferred<Lease, NeedFailedError>>()
	return {
		on: (member) =>
			Effect.suspend(() =>
				Option.match(Option.fromUndefinedOr(leases.get(member.name)), {
					onSome: Deferred.await,
					onNone: () => {
						const leased = Deferred.makeUnsafe<Lease, NeedFailedError>()
						leases.set(member.name, leased)
						return Effect.andThen(
							Deferred.into(
								Effect.mapError(
									Scope.provide(leaseOn(member), scope),
									clusterFailed(`the connection lease on member ${member.name}`)
								),
								leased
							),
							Deferred.await(leased)
						)
					}
				})
			)
	}
}

/**
 * A session as the owner, grizzle_dev, in `database` on `member`, drawing one of the worker's lease's permits (from
 * `leases`) for its life: what the toolchain creates, clones, drops and builds templates with. It reads every value as
 * the server's text (pg.ts textSession), as the toolchain's sessions answer, whatever a statement's column types.
 */
const ownerSession =
	(leases: Context.Service.Shape<typeof WorkerLeases>) =>
	(member: PgMember, database: string): Effect.Effect<PgSession, NeedFailedError, Scope.Scope> =>
		Effect.gen(function* () {
			const { cluster } = yield* leases.on(member)
			const connection = yield* Effect.mapError(
				textSession(cluster, {
					database,
					username: member.owner,
					password: cluster.password,
					applicationName: Option.some("grizzle-resources owner")
				}),
				clusterFailed(`a session in ${database} on member ${member.name}`)
			)
			return {
				connection,
				query: (sql, params) =>
					Effect.mapError(
						connection.queryValues(sql, params),
						clusterFailed(`${sql} in ${database}`)
					)
			}
		})

/**
 * The runner layer test.config.ts provides: PgCluster over grizzle's local cluster (pg.config.ts), made and started the
 * first time a need reaches it (PgCluster.layer reads nothing as it builds), templates built from its template, the
 * toolchain's owner sessions and advisory locks in the owner's own database, every session the owner's (ownerSession);
 * and the worker's leases (WorkerLeases), which the owner's sessions and every substrate of the worker draw from.
 */
export const grizzleCluster: Layer.Layer<PgCluster | WorkerLeases, never, Platform> = Layer.unwrap(
	Effect.gen(function* () {
		const scope = yield* Effect.scope
		const leases = workerLeases(scope)
		return Layer.merge(
			PgCluster.layer({ prefix, cluster: pgCluster, connect: ownerSession(leases) }),
			Layer.succeed(WorkerLeases, leases)
		)
	})
)

/**
 * The worker's own cluster service, as a need: what a search nested in a case runs its needs on (searchInline under
 * Effect.provideContext), so they draw on the worker's connection lease rather than a lease of their own, which a run
 * whose every worker holds one could leave the nested search waiting for.
 */
export const workerCluster: Need<Context.Context<PgCluster | WorkerLeases>> = {
	key: "grizzle worker cluster",
	open: Effect.map(Effect.context<PgCluster | WorkerLeases>(), Effect.succeed)
}
