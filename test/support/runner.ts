import type { PgMember, Platform } from "@bjornpagen/testing/pg"
import type { Need, NeedFailed as NeedFailedError, WorkerIndex } from "@bjornpagen/testing/property"
import { NeedFailed } from "@bjornpagen/testing/property"
import {
	DatabasePrefix,
	PgCluster,
	type PgSession,
	type Statements
} from "@bjornpagen/testing/resources"
import { Context, Effect, Layer, Option, type Scope } from "effect"
import { fixtureNeedBudget } from "#test/support/budgets.ts"
import { overTls } from "#test/support/cluster.ts"
import { pgCluster } from "#test/support/env.ts"
import { type SqlError, textSession } from "#test/support/pg.ts"
import { type BudgetedCluster, budgeted, connectionBudget } from "#test/support/substrate/budget.ts"
import { connectionsPerWorker } from "#test/support/substrate/connections.ts"
import { superuserClient } from "#test/support/substrate/shared.ts"

/**
 * grizzle's services for the toolchain's runner (`toolchain-test`, test.config.ts): its local cluster (pg.config.ts) as
 * the cluster every database need of a property clones from (@bjornpagen/testing/resources PgCluster), and the worker's
 * connection budget on each member it reaches (WorkerBudgets).
 *
 * A worker reaches one member of the cluster for its life (PgCluster memberOf), and every connection it opens on the
 * member draws from its one budget there, the toolchain's owner and builder sessions (`connect`) as much as a case's
 * substrate, sessions and psql writers: so a worker holds at most the connections its member was sized for
 * (connections.ts connectionsPerWorker), and one past them is a defect of the test that asked, never a wait.
 */
declare module "@bjornpagen/testing/property" {
	interface RunnerServices {
		readonly cluster: PgCluster
		readonly budgets: WorkerBudgets
	}
}

/**
 * The worker's connection budget on each member of the cluster it reaches, of connectionsPerWorker permits (budget.ts
 * ConnectionBudget): made the first time it is asked for on a member and kept for the worker's life, every later ask
 * answering the same, so every opener of the worker on a member draws from one count.
 */
export class WorkerBudgets extends Context.Service<
	WorkerBudgets,
	Readonly<{ on: (member: PgMember) => Effect.Effect<BudgetedCluster, NeedFailedError> }>
>()("grizzle-workspace/test/support/runner/WorkerBudgets") {}

/** The worker's budget on `member` (WorkerBudgets): what every connection the worker opens there draws from. */
export const memberBudget = (
	member: PgMember
): Effect.Effect<BudgetedCluster, NeedFailedError, WorkerBudgets> =>
	Effect.flatMap(WorkerBudgets, (budgets) => budgets.on(member))

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
 * `gz_c_<owner>_<n>` for a clone, apart from a bench's or a child's own gz_t_ databases, which shared.ts sweeps.
 */
const prefix = DatabasePrefix("gz_")

/**
 * The budgets of one worker, by member name (WorkerBudgets on), each made the first time it is asked for, over the
 * member as grizzle reaches it (cluster.ts overTls): a member of no TLS fails the need that reached it.
 */
const workerBudgets = (): Context.Service.Shape<typeof WorkerBudgets> => {
	const budgets = new Map<string, BudgetedCluster>()
	return {
		on: (member) =>
			Effect.suspend(() =>
				Option.match(Option.fromUndefinedOr(budgets.get(member.name)), {
					onSome: Effect.succeed,
					onNone: () =>
						Effect.mapBoth(overTls(member), {
							onFailure: (refused) =>
								NeedFailed.make({ need: "grizzle cluster", message: refused.message }),
							onSuccess: (reached) => {
								const budget = budgeted(reached, connectionBudget(connectionsPerWorker))
								budgets.set(member.name, budget)
								return budget
							}
						})
				})
			)
	}
}

/**
 * A session as the owner, grizzle_dev, in `database` on `member`, drawing one of the worker's budget's permits (from
 * `budgets`) for its life: what the toolchain creates, clones, drops and builds templates with. It reads every value as
 * the server's text (pg.ts textSession), as the toolchain's sessions answer, whatever a statement's column types; each
 * statement's backend is the case's own work, as every session's is.
 */
const ownerSession =
	(budgets: Context.Service.Shape<typeof WorkerBudgets>) =>
	(member: PgMember, database: string): Effect.Effect<PgSession, NeedFailedError, Scope.Scope> =>
		Effect.gen(function* () {
			const cluster = yield* budgets.on(member)
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
				query: (sql, params) =>
					Effect.mapError(
						connection.queryValues(sql, params),
						clusterFailed(`${sql} in ${database}`)
					)
			}
		})

/**
 * A session as the member's bootstrap superuser, the account, in `database` on `member` (shared.ts
 * superuserClient), drawing one of the worker's budget's permits (from `budgets`) for its life: what the toolchain
 * remakes in a clone that only a superuser may be sure to make.
 */
const superuserSession =
	(budgets: Context.Service.Shape<typeof WorkerBudgets>) =>
	(member: PgMember, database: string): Effect.Effect<Statements, NeedFailedError, Scope.Scope> =>
		Effect.gen(function* () {
			const cluster = yield* budgets.on(member)
			const statements = yield* Effect.mapError(
				superuserClient(cluster, database, "grizzle-resources superuser"),
				clusterFailed(`a superuser's session in ${database} on member ${member.name}`)
			)
			return {
				query: (sql, params) =>
					Effect.mapError(statements.query(sql, params), clusterFailed(`${sql} in ${database}`))
			}
		})

/**
 * The runner layer test.config.ts provides: PgCluster over grizzle's local cluster (pg.config.ts), the worker's own
 * member brought up the first time a need reaches it, and no other (PgCluster.layer reads nothing as it builds; the
 * member, where it is absent, is settled by its own unit), templates built from its template, the toolchain's owner
 * sessions and advisory locks in the owner's own database (ownerSession), and its bootstrap superuser's sessions
 * (superuserSession); and the worker's budgets (WorkerBudgets), which the owner's sessions and every substrate of the
 * worker draw from.
 */
export const grizzleCluster: Layer.Layer<PgCluster | WorkerBudgets, never, Platform | WorkerIndex> =
	Layer.unwrap(
		Effect.sync(() => {
			const budgets = workerBudgets()
			return Layer.merge(
				PgCluster.layer({
					prefix,
					cluster: pgCluster,
					connect: ownerSession(budgets),
					superuser: superuserSession(budgets)
				}),
				Layer.succeed(WorkerBudgets, budgets)
			)
		})
	)

/**
 * The worker's own cluster service, as a need: what a search nested in a case runs its needs on (searchInline under
 * Effect.provideContext), so they draw on the worker's connection budget rather than a budget of their own, which would
 * let the worker hold past what its member was sized for.
 */
export const workerCluster: Need<Context.Context<PgCluster | WorkerBudgets>> = {
	key: "grizzle worker cluster",
	budget: fixtureNeedBudget,
	runNeeds: [],
	open: Effect.map(Effect.context<PgCluster | WorkerBudgets>(), Effect.succeed)
}
