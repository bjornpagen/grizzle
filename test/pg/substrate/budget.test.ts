/**
 * The lease's connection budget (test/support/substrate/budget.ts) bounds what a test file holds on the cluster at
 * once: every connection test support opens draws one of its permits for its life, and past its width an open is
 * refused at once with LeaseBudgetExhausted, before any connection is sent, never waiting.
 *
 * A case draws a small width and a file's demand under it, opened in order and each held to the case's end: raw
 * sessions (substrate/session.ts openSession), psql writers (substrate.ts psqlWriter), and DbLayers, each with a pool of
 * its own and a number of calls at once through it, every call a Db of the login's role reading every account. The
 * case's budget is drawn from the file's (LeaseBudget within), and every opener reaches the cluster through it, as
 * every opener of the file reaches it through the file's. A holder outside the case's budget locks the table the reads
 * read, so each call that gets a session holds it, blocked, until the case releases the lock: a pool's demand is then
 * exactly its calls, which nothing else makes deterministic. Every opener of the case logs in as a role of the case's
 * own (a probe role, the login's role), so the backends the file holds for the case are those pg_stat_activity lists
 * for those roles: every backend the openers recorded, and any no opener recorded.
 *
 * The oracle is the budget's contract. After each demand settles (each raw session and psql writer returned, each
 * call refused or blocked on the holder's lock), the case's backends are exactly the demand so far up to the width:
 * none past it, and every connection within it opened. Each opener past the width failed with LeaseBudgetExhausted
 * naming the width, as a defect, and of a pool's calls exactly those past the width did. Once the holder lets go, every
 * call that held a session reads every account.
 *
 * Features: demand within the width, demand past it, a refused raw session, psql writer and pool call, a pool's calls
 * split by the width, several pools in one case, every kind of opener in one case, and the permit of a login the server
 * refused drawn again by a later opener: the refused login draws a permit to connect and must give it back at once.
 *
 * Plants (~/.cache/grizzle-release/LEASEBUDGET/plants): transport-without-permit.patch (the cluster's transport opens
 * its sockets without drawing a permit), failed-open-keeps-permit.patch (a session's permit held for its scope even when
 * its connect fails).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Function,
	Layer,
	Option,
	Order,
	Record as Rec,
	Redacted,
	Ref,
	Result
} from "effect"
import { Db } from "#adapter/public/db.ts"
import { query, v } from "#compiler/public/query.ts"
import { login, role, schema } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert } from "#test/support/assert.ts"
import { rowsOf } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { workFacts } from "#test/support/fixtures/golden/work.ts"
import { installGenerated, loadMigrated } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { servedGenerated } from "#test/support/served-db.ts"
import { budgeted, LeaseBudgetExhausted } from "#test/support/substrate/budget.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import { openSession } from "#test/support/substrate/session.ts"
import { ownerSession, psqlWriter, rolePsql, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { testVerify } from "#test/support/worlds.ts"

/**
 * One opener of a file's demand: a raw session, a raw session whose login the server refuses (a wrong password), a psql
 * writer, or a pool and the calls it serves at once.
 */
type Demand =
	| { readonly kind: "raw session" }
	| { readonly kind: "refused login" }
	| { readonly kind: "psql writer" }
	| { readonly kind: "pool"; readonly max: number; readonly calls: number }

interface BudgetCase {
	readonly width: number
	readonly demands: Arr.NonEmptyReadonlyArray<Demand>
}

const demandGen: Gen<Demand> = weighted<Demand>([
	[1, () => ({ kind: "raw session" })],
	[1, () => ({ kind: "refused login" })],
	[1, () => ({ kind: "psql writer" })],
	[
		2,
		(source) => {
			const max = source.draw(int(1, 3))
			return { kind: "pool", max, calls: source.draw(int(1, max)) }
		}
	]
])

const caseGen: Gen<BudgetCase> = (source) => ({
	width: source.draw(int(1, 4)),
	demands: [source.draw(demandGen), ...source.draw(array(demandGen, { min: 0, max: 4 }))]
})

/**
 * The connections a demand holds once it settles, within the width or past it: a refused login holds none, the permit
 * it drew given back as the server refuses it.
 */
const demandOf = (demand: Demand): number => {
	switch (demand.kind) {
		case "pool":
			return demand.calls
		case "refused login":
			return 0
		case "raw session":
		case "psql writer":
			return 1
	}
}

type BudgetFeature =
	| "demand within the width"
	| "demand past the width"
	| "a refused raw session"
	| "a refused login's permit drawn again"
	| "a refused psql writer"
	| "a refused pool call"
	| "a pool's calls split by the width"
	| "several pools"
	| "every kind of opener"

const budgetFeatures: Arr.NonEmptyReadonlyArray<BudgetFeature> = [
	"demand within the width",
	"demand past the width",
	"a refused raw session",
	"a refused login's permit drawn again",
	"a refused psql writer",
	"a refused pool call",
	"a pool's calls split by the width",
	"several pools",
	"every kind of opener"
]

/** The installation's login and its one role, whose workload reads every account. */
const worldsOver = (Work: W.WorkNamed<string>) => {
	const reader = role(Work, "reader", { Account: W.Account })
	const accounts = query(reader).rule((r) => {
		const { id, name } = v(reader.relations.Account, "account")
		return r.match(reader.relations.Account, { id, name }).find({ id })
	})
	return login(Work, "web", [reader], { workload: [workload(reader, { accounts })] })
}

/** The case's backends, as pg_stat_activity lists them in the database: all of them, and those waiting on a lock. */
const backendsQuery = `SELECT count(*)::int4, (count(*) FILTER (WHERE a.wait_event_type = 'Lock'))::int4
FROM pg_catalog.pg_stat_activity AS a
WHERE a.datname = pg_catalog.current_database() AND a.usename = ANY ($1::text[])`

/** The password no role has, which the server refuses at authentication. */
const wrongPassword = "not-the-password"

/** Whether a session's failure is the server's refusal of its password (28P01). */
const refusedLogin = (error: unknown): boolean => pgErrorFields(error)?.code === "28P01"

/** Whether an opener's failure is LeaseBudgetExhausted naming `width`, as a defect. */
const exhaustedAt = (cause: Cause.Cause<unknown>, width: number): boolean =>
	Result.match(Cause.findDefect(cause), {
		onFailure: () => false,
		onSuccess: (defect) => defect instanceof LeaseBudgetExhausted && defect.width === width
	})

layer(Layer.merge(Substrate.layer, NodeServices.layer))("the lease's connection budget", (it) => {
	it.effect(
		"holds a file's backends to its width, opens all demand within it, and refuses each opener past it at once",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					const workAt = (name: string) =>
						schema(name, Rec.values(W.Work.relations), W.Work.statements)
					const generated = yield* installGenerated(
						(name) => ({ schema: workAt(name), logins: [worldsOver(workAt(name))] }),
						{ label: "budget", ambient: ordinarySession }
					)
					const installed = generated.installed
					yield* loadMigrated(installed, workFacts)
					const web = worldsOver(workAt(installed.declared))
					const served = servedGenerated(generated, web)
					const table = namesOf(installed).table(W.Account)
					const probeSchema = yield* substrate.schema({ create: false, label: "budget" })
					const probe = yield* substrate.role(probeSchema, "probe")
					const roles = [probe.role, installed.as(web).role]
					const accountIds = Arr.sort(
						Arr.map(workFacts.Account, (a) => a.id),
						Order.String
					)
					const backends = Effect.map(
						substrate.admin.queryValues(backendsQuery, [roles]),
						([row]) => ({ all: Number(row?.[0]), waiting: Number(row?.[1]) })
					)
					/** Returns once none of the case's backends is left, the last case's pools and writers ended. */
					const untilGone = Effect.gen(function* () {
						while ((yield* backends).all > 0) {
							yield* Effect.yieldNow
						}
					})
					const read = Effect.gen(function* () {
						const db = yield* Db.open(served.login.roles.reader, {})
						const rows = yield* rowsOf(db.workload.accounts.once({ params: {}, facts: {} }))
						return Arr.sort(
							Arr.map(rows, (row) => row.id),
							Order.String
						)
					})
					const runCase = (x: BudgetCase, note: (f: BudgetFeature) => void) =>
						Effect.gen(function* () {
							yield* untilGone
							const scope = yield* Effect.scope
							const within = yield* substrate.cluster.budget.within(x.width)
							const cluster = budgeted(substrate.cluster, within)
							const holder = yield* substrate.session({ ...ownerSession(), label: "holder" })
							yield* holder.begin
							yield* holder.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`, [])
							/** Every pool call, as it ended: refused, or (once the holder lets go) read. */
							const calls = yield* Ref.make<
								ReadonlyArray<Exit.Exit<ReadonlyArray<string>, unknown>>
							>([])
							let callFibers: ReadonlyArray<Fiber.Fiber<void>> = []
							let demanded = 0
							/**
							 * The demand that needs the permit of the last login refused within the width: reached, the permit
							 * the refusal drew came back and was drawn again.
							 */
							let refusedWithin = 0
							let poolCalls = 0
							for (const demand of x.demands) {
								const free = Math.max(0, x.width - demanded)
								const refusedHere = Math.max(0, demandOf(demand) - free)
								switch (demand.kind) {
									case "raw session": {
										const opened = yield* Effect.exit(
											openSession(cluster, {
												database: installed.database,
												credentials: probe,
												label: "budget probe"
											})
										)
										assert.ok(
											refusedHere === 0
												? Exit.isSuccess(opened)
												: Exit.isFailure(opened) && exhaustedAt(opened.cause, x.width),
											`a raw session with ${free} of ${x.width} permits free: ${Formatter.format(opened)}`
										)
										if (refusedHere > 0) {
											note("a refused raw session")
										}
										break
									}
									case "refused login": {
										const opened = yield* Effect.exit(
											openSession(cluster, {
												database: installed.database,
												credentials: { role: probe.role, password: Redacted.make(wrongPassword) },
												label: "budget refused"
											})
										)
										assert.ok(
											free === 0
												? Exit.isFailure(opened) && exhaustedAt(opened.cause, x.width)
												: Exit.isFailure(opened) &&
														Option.exists(Cause.findErrorOption(opened.cause), refusedLogin),
											`a refused login with ${free} of ${x.width} permits free: ${Formatter.format(opened)}`
										)
										if (free > 0) {
											refusedWithin = Math.max(refusedWithin, demanded + 1)
										}
										break
									}
									case "psql writer": {
										const opened = yield* Effect.exit(
											psqlWriter(cluster, installed.database, substrate.admin, rolePsql(probe))
										)
										assert.ok(
											refusedHere === 0
												? Exit.isSuccess(opened)
												: Exit.isFailure(opened) && exhaustedAt(opened.cause, x.width),
											`a psql writer with ${free} of ${x.width} permits free: ${Formatter.format(opened)}`
										)
										if (refusedHere > 0) {
											note("a refused psql writer")
										}
										break
									}
									case "pool": {
										const context = yield* Layer.buildWithScope(
											sourcedDbLayer(installed, {
												...clusterConnection(
													cluster,
													installed.database,
													installed.as(web).password
												),
												pool: { ...clusterPool, max: demand.max },
												login: served.login,
												verify: testVerify
											}),
											scope
										)
										const forked = yield* Effect.forEach(
											upTo(demand.calls, Function.identity),
											() =>
												Effect.forkScoped(
													Effect.flatMap(
														Effect.exit(Effect.provideContext(read, context)),
														(exit) => Ref.update(calls, (ended) => Arr.append(ended, exit))
													)
												)
										)
										callFibers = Arr.appendAll(callFibers, forked)
										poolCalls += demand.calls
										while ((yield* backends).waiting + (yield* Ref.get(calls)).length < poolCalls) {
											yield* Effect.yieldNow
										}
										const ended = yield* Ref.get(calls)
										const refused = Arr.filter(
											ended,
											(exit) => Exit.isFailure(exit) && exhaustedAt(exit.cause, x.width)
										)
										assert.equal(
											ended.length,
											refused.length,
											`a pool call ended other than refused while the holder held the lock: ${Formatter.format(ended)}`
										)
										if (refusedHere > 0) {
											note("a refused pool call")
											if (refusedHere < demand.calls) {
												note("a pool's calls split by the width")
											}
										}
										break
									}
								}
								demanded += demandOf(demand)
								const held = yield* backends
								assert.equal(
									held.all,
									Math.min(demanded, x.width),
									`the case's backends once ${demanded} connections were asked of a width of ${x.width}`
								)
							}
							const refusedCalls = (yield* Ref.get(calls)).length
							yield* holder.rollback
							yield* Fiber.joinAll(callFibers)
							const ended = yield* Ref.get(calls)
							const readCalls = Arr.drop(ended, refusedCalls)
							for (const exit of readCalls) {
								assert.ok(
									Exit.isSuccess(exit),
									`a pool call that held a session: ${Formatter.format(exit)}`
								)
								if (Exit.isSuccess(exit)) {
									assert.deepEqual(exit.value, accountIds, "a pool call reads every account")
								}
							}
							note(demanded > x.width ? "demand past the width" : "demand within the width")
							if (refusedWithin > 0 && demanded >= Math.max(refusedWithin, x.width)) {
								note("a refused login's permit drawn again")
							}
							if (Arr.filter(x.demands, (d) => d.kind === "pool").length > 1) {
								note("several pools")
							}
							if (
								Arr.every(["raw session", "psql writer", "pool"] as const, (kind) =>
									Arr.some(x.demands, (d) => d.kind === kind)
								)
							) {
								note("every kind of opener")
							}
						})
					return yield* explore(
						{
							suite: "substrate/budget",
							draw: drawn(caseGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the budget's contract: the demand up to the width opens, every opener past it is refused naming the width"
							},
							coverage: required<BudgetFeature>(budgetFeatures, { cases: 32, sense: notesOnly }),
							kept: [],
							runs: 32,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(x, c) => Effect.scoped(runCase(x, (f) => c.note(f)))
					)
				}).pipe(Effect.scoped)
			)
	)
})
