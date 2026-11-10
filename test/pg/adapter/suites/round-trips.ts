import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { memberOps } from "#adapter/db/handles.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import { DbLayer } from "#adapter/public/layer.ts"
import { explainMember } from "#adapter/served/explain.ts"
import type { CursorError } from "#compiler/core/errors.ts"
import { isRecord } from "#compiler/core/record.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { arm, query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"
import { paged, refresh } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, assertVariant, defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t4, t5, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { installMigrated as install } from "#test/support/install-migrate.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	frontendCount,
	makeTap,
	queryTexts,
	type Tap,
	type WireWindow
} from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

const readFraming = ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", "COMMIT"] as const
const writeFraming = ["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"] as const
/** A Db transaction's prologue (adapter/wire/batch.ts Prologue): the fence's ledger lock, then the guard's SELECT. */
const prologueStatements = 2

/** The traffic of `effect`, and its value. */
const observe = <A, E, R>(tap: Tap, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const mark = tap.mark()
		const value = yield* effect
		return { value, window: tap.since(mark) }
	})

/** `window` is `roundTrips` round trips framed by `framing`. */
const assertFlights = (
	label: string,
	window: WireWindow,
	roundTrips: number,
	framing: ReadonlyArray<string>
) => {
	assert.equal(window.roundTrips, roundTrips, `${label}: round trips`)
	assert.deepEqual(queryTexts(window), framing, `${label}: framing`)
	assert.deepEqual(window.backend.at(-1), { type: "Z", status: "I" }, `${label}: ends idle`)
}

/** A derived relation over one base relation, the role that refreshes it, and its login. */
const derivedFixture = (name: string) => {
	const Sitting = relation("Sitting", { id: uuid, student: uuid, week: pg.integer }, ["id"])
	const Edu = schema(name, { Sitting }, [])
	const StudentWeekly = derived.materialized(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student, week }).find({ student, week, sittings: r.count() })
		})
	)
	const Reports = schema.extend(Edu, `${name}_1`, { StudentWeekly }, [])
	const refresher = role(Reports, "refresher", wholeEntriesOf(Reports), {
		refresh: ["StudentWeekly"]
	})
	return { StudentWeekly, Reports, refresher, server: login(Reports, "server", [refresher]) }
}

const readCallKinds = ["execute", "get", "explain", "page"] as const
type ReadCallFeature = `${(typeof readCallKinds)[number]} ${"one statement" | "several statements"}`

/**
 * A drawn read call: its kind, the query it reads (a page's ordered query), a present or absent key, a page's
 * direction, size and anchor among the edges earlier pages delivered.
 */
const readCallsGen = array(
	(source) => ({
		kind: source.draw(element(readCallKinds)),
		query: source.draw(
			element([
				"one statement",
				"heading groups",
				"fused attachments",
				"a pipelined attachment"
			] as const)
		),
		page: source.draw(element(["budgets", "noted"] as const)),
		present: source.draw(boolean),
		forward: source.draw(boolean),
		size: source.draw(int(1, 4)),
		anchor: source.draw(pickGen)
	}),
	{ min: 1, max: 6 }
)

const firstCallKinds = ["get", "execute", "apply"] as const
type FirstCallFeature = (typeof firstCallKinds)[number] | "several Dbs opened"

/** Dbs opened in one request and the first call one of them makes. */
interface FirstCall {
	readonly opens: number
	readonly caller: number
	readonly call: (typeof firstCallKinds)[number]
	readonly present: boolean
}

/**
 * One to three Dbs opened in one request, and the first call one of them makes: a get of a present or absent key, an
 * execute, or an apply with nothing to write, which sends its transaction all the same.
 */
const firstCallsGen: Gen<FirstCall> = (source) => ({
	opens: source.draw(int(1, 3)),
	caller: source.draw(pickGen),
	call: source.draw(element(firstCallKinds)),
	present: source.draw(boolean)
})

/** Up to three notes, each at a task none of the others is at, of a drawn text. */
const notesGen: Gen<ReadonlyArray<{ readonly task: number; readonly text: number }>> = (source) =>
	Arr.map(source.draw(shuffled([0, 1, 2], { min: 0, max: 3 })), (task) => ({
		task,
		text: source.draw(int(0, 2))
	}))

type WriteCallFeature = "apply" | "explain" | "a read-back that attaches" | "nothing to write"

/**
 * A drawn write call: notes inserted, put or deleted, none among them (a call with nothing to write, which still sends
 * its transaction), with or without a read-back, applied or explained.
 */
const writeCallsGen = array(
	(source) => ({
		kind: source.draw(element(["apply", "explain"] as const)),
		op: source.draw(element(["insert", "put", "delete"] as const)),
		notes: source.draw(notesGen),
		readBack: source.draw(boolean)
	}),
	{ min: 1, max: 4 }
)

type RefreshFeature = "a refresh of an unpopulated view" | "a refresh of a populated view"

/**
 * A drawn program of refreshes, each run on the view as the last left it or emptied first, `WITH NO DATA`, the
 * unpopulated state a migration that recreates the view leaves.
 */
const refreshesGen = array(boolean, { min: 1, max: 4 })

/**
 * One round trip per public call, observed on the protocol through the tap (test/support/wire-tap.ts).
 *
 * Each call runs on an opened Db whose pool is tapped: the Db's own context with a pool of one session whose every
 * byte the tap records, warmed first, so a window holds one call's traffic alone. The contract (README, "Transactions
 * and concurrency" and "Reading") is the oracle of every drawn call: exactly one round trip, the session
 * idle at its end, no cancel; every read, of one statement or of several (heading groups, pipelined attachments, a
 * page's rows and its opposite-flag probe), in one SERIALIZABLE READ ONLY transaction that commits; every write and
 * refresh in one SERIALIZABLE transaction that commits; an EXPLAIN in one that rolls back; and each of them behind the
 * Db's prologue (adapter/wire/batch.ts Prologue), the fence's ledger lock and the guard that enters the Db's role, so a
 * flight executes its statements and two more. Db.open sends nothing at all, so a request's first call is its first
 * round trip.
 * The framing is read from the flight's simple Query texts, the statement count from its Executes. As properties:
 *
 * - drawn reads over the worked example, each a member of the login's served workload: a read's execute, a key's get of
 *   a present or absent key, a member's explain (adapter/served/explain.ts), and walks of a paged member's page
 *   requests (first, last, after and before an earlier edge, drawn sizes), over a plain read, a heterogeneous union,
 *   fused and pipelined attachments and an ordered page with an attachment;
 * - drawn writes: a change member of note inserts, puts and deletes, with or without a read-back that attaches, each
 *   call's facts, applied or explained; a call with nothing to write sends its transaction all the same, its frame
 *   alone, so even it meets the fence;
 * - drawn programs of refreshes through a refresh member of the workload, each on its view as the last refresh left it
 *   or emptied first as a migration that recreates it leaves it, so the server chooses the plain and the concurrent form, read from pg_class before each
 *   call, and every refresh leaves its view populated;
 * - drawn requests through the login's own served layer, its pool's one session tapped: one to three Dbs opened,
 *   during which the wire carries nothing, and a first call of one of them (a key's get, a read's execute, an apply of
 *   a change member with nothing to write), one round trip in its transaction.
 */
export const roundTripSuite = (): void => {
	layer(Substrate.layer, { excludeTestServices: true })("one round trip per public call", (it) => {
		/**
		 * A tapped pool of one session for `credentials`, warmed, which a served Db's members run on.
		 *
		 * The session's startup, outside every window.
		 */
		const tappedPool = (credentials: Credentials) =>
			Effect.gen(function* () {
				const substrate = yield* Substrate
				const tap = makeTap(substrate.cluster)
				const pool = yield* poolFor(credentials, {
					...defaultPool,
					transport: { kind: "given", transport: tap.transport },
					pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
				})
				yield* Effect.scoped(
					Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
				)
				return { pool, tap }
			})

		it.effect(
			"every drawn read, page and EXPLAIN of a query is one round trip, framed as its statements say",
			(testContext) =>
				searched(
					testContext,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {}
						})
						const s = o.schema
						const reads = W.workReads(s)
						const payloads = query(s)
							.rule((r) => {
								const { id, account } = v(W.Task, "task")
								const { budget } = v(W.AutomaticTask, "automaticTask")
								return r
									.match(W.Task, { id, account, kind: "Automatic" })
									.match(W.AutomaticTask, { task: id, budget })
									.find({ id, account, kind: W.Kind.handle("Automatic"), budget })
							})
							.rule((r) => {
								const { id, account } = v(W.Task, "task")
								const { operator } = v(W.ManualTask, "manualTask")
								return r
									.match(W.Task, { id, account, kind: "Manual" })
									.match(W.ManualTask, { task: id, operator })
									.find({ id, account, kind: W.Kind.handle("Manual"), operator })
							})
						/** An attachment whose child has an attachment of its own stays pipelined. */
						const accountTaskNotes = query(s)
							.rule((r) => {
								const { id, name } = v(W.Account, "account")
								return r.match(W.Account, { id, name }).find({ id, name })
							})
							.attach(
								"tasks",
								(a) =>
									query(s)
										.rule((r) => {
											const { id, kind } = v(W.Task, "task")
											return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
										})
										.attach(
											"note",
											(t) =>
												query(s).rule((r) => {
													const { note } = v(W.TaskNote, "taskNote")
													return r.match(W.TaskNote, { task: t.id, note }).find({ note })
												}),
											"option"
										),
								"array"
							)
						/** Ordered pages: one statement each, and one whose attachment computes the page again. */
						const budgets = query(s)
							.rule((r) => {
								const { id } = v(W.Task, "task")
								const { budget } = v(W.AutomaticTask, "automaticTask")
								return r
									.match(W.Task, {
										id,
										account: r.param("account", W.Task.fields.account),
										kind: "Automatic"
									})
									.match(W.AutomaticTask, { task: id, budget })
									.find({ id, budget })
							})
							.orderBy(["budget", "desc"], ["id", "asc"])
						const noted = query(s)
							.rule((r) => {
								const { id } = v(W.Task, "task")
								return r
									.match(W.Task, { id, account: r.param("account", W.Task.fields.account) })
									.find({ id })
							})
							.attach(
								"notes",
								(t) =>
									query(s).rule((r) => {
										const { note } = v(W.TaskNote, "taskNote")
										return r.match(W.TaskNote, { task: t.id, note }).find({ note })
									}),
								"option"
							)
							.orderBy(["id", "asc"])
						const queries = {
							"one statement": { member: "oneStatement", params: { account: a1 } },
							"heading groups": { member: "headingGroups", params: {} },
							"fused attachments": { member: "fusedAttachments", params: { account: a1 } },
							"a pipelined attachment": { member: "pipelinedAttachment", params: {} }
						} as const
						return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load({
									oneStatement: reads.automaticTasksFor,
									headingGroups: payloads,
									fusedAttachments: reads.taskCards,
									pipelinedAttachment: accountTaskNotes,
									task: W.Task,
									budgets: paged(budgets),
									noted: paged(noted)
								})
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								const ops = (name: string) => memberOps(context, member(loaded, name)).ops
								return yield* explore(
									{
										oracle: { kind: "unstated" },
										suite: "adapter/round-trips reads",
										draw: drawn(readCallsGen),
										literal: Formatter.format,
										kept: [],
										runs: 40,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 16,
										coverage: required<ReadCallFeature>(
											[
												...Arr.map(readCallKinds, (k): ReadCallFeature => `${k} one statement`),
												...Arr.flatMap(readCallKinds, (k): ReadonlyArray<ReadCallFeature> =>
													k === "get" ? [] : [`${k} several statements`]
												)
											],
											{ cases: 40, sense: notesOnly }
										),
										caseHang
									},
									(calls, notes) =>
										Effect.gen(function* () {
											/**
											 * The cursors each ordered query's pages delivered: a cursor continues only its own query.
											 *
											 * The handle's compilation is outside the call's window.
											 */
											const delivered: Readonly<Record<"budgets" | "noted", Array<string>>> = {
												budgets: [],
												noted: []
											}
											for (const call of calls) {
												const target = queries[call.query]
												const edges = delivered[call.page]
												const anchor =
													edges.length === 0
														? Option.none<string>()
														: Option.some(defined(edges[pickIndex(call.anchor, edges.length)]))
												const effect: Effect.Effect<unknown, ReadError | CursorError> =
													call.kind === "execute"
														? Effect.flatMap(
																ops(target.member).execute(target.params),
																(r) => r.collect
															)
														: call.kind === "get"
															? ops("task").get({ id: call.present ? t1 : tMissing })
															: call.kind === "explain"
																? explainMember(context, member(loaded, target.member), {
																		kind: "params",
																		params: target.params
																	})
																: ops(call.page).page(
																		{ account: a1 },
																		Option.match(anchor, {
																			onNone: () =>
																				call.forward ? { first: call.size } : { last: call.size },
																			onSome: (cursor) =>
																				call.forward
																					? { first: call.size, after: cursor }
																					: { last: call.size, before: cursor }
																		})
																	)
												const seen = yield* observe(tap, effect)
												/** The prologue is two Executes more than the call's own statements. */
												const statements = frontendCount(seen.window, "E") - prologueStatements
												assert.ok(statements >= 1, `${call.kind}: statements behind the prologue`)
												assertFlights(
													call.kind,
													seen.window,
													1,
													call.kind === "explain"
														? ["BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY", "ROLLBACK"]
														: readFraming
												)
												notes.note(
													statements > 1
														? `${call.kind} several statements`
														: `${call.kind} one statement`
												)
												if (
													call.kind === "page" &&
													isRecord(seen.value) &&
													Arr.isArray(seen.value["edges"])
												) {
													for (const edge of seen.value["edges"]) {
														if (isRecord(edge) && typeof edge["cursor"] === "string") {
															edges.push(edge["cursor"])
														}
													}
												}
											}
											assert.equal(tap.cancels(), 0)
										})
								)
							})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"every drawn write and EXPLAIN of a change member is one round trip in its transaction",
			(testContext) =>
				searched(
					testContext,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {}
						})
						const s = o.schema
						/** The notes a call inserts, puts and deletes, each its own facts, and its read-back. */
						const plain = ChangeSet.empty(s)
							.insert(W.TaskNote, [])
							.put(W.TaskNote, [])
							.delete(W.TaskNote, [])
						return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load({
									plain,
									/**
									 * A read-back that attaches an alternatives arm, computing its parents' rows after the writes.
									 */
									readBack: plain.read("cards", () =>
										query(s)
											.rule((r) => {
												const { id, kind } = v(W.Task, "task")
												return r.match(W.Task, { id, kind }).find({ id, kind })
											})
											.attach(
												"automatic",
												(t) =>
													query(s).rule((r) => {
														const { budget } = v(W.AutomaticTask, "automaticTask")
														return r.match(W.AutomaticTask, { task: t.id, budget }).find({ budget })
													}),
												arm("kind", "Automatic")
											)
									)
								})
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								const tasks = [t1, t4, t5] as const
								return yield* explore(
									{
										oracle: { kind: "unstated" },
										suite: "adapter/round-trips writes",
										draw: drawn(writeCallsGen),
										literal: Formatter.format,
										kept: [],
										runs: 30,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 16,
										coverage: required<WriteCallFeature>(
											["apply", "explain", "a read-back that attaches", "nothing to write"],
											{ cases: 30, sense: notesOnly }
										),
										caseHang
									},
									(calls, notes) =>
										Effect.gen(function* () {
											for (const call of calls) {
												const facts = Arr.map(call.notes, (n) => ({
													task: defined(tasks[n.task]),
													note: `note ${n.text}`
												}))
												/** The call's facts: the drawn notes under the op it writes, every other op's none. */
												const called = {
													insert: { TaskNote: call.op === "insert" ? facts : [] },
													put: { TaskNote: call.op === "put" ? facts : [] },
													delete: { TaskNote: call.op === "delete" ? facts : [] }
												}
												const change = member(loaded, call.readBack ? "readBack" : "plain")
												if (call.readBack) {
													notes.note("a read-back that attaches")
												}
												if (call.notes.length === 0) {
													notes.note("nothing to write")
												}
												if (call.kind === "explain") {
													const seen = yield* observe(
														tap,
														explainMember(context, change, {
															kind: "facts",
															facts: called,
															params: {}
														})
													)
													assertFlights("explain of a change member", seen.window, 1, [
														"BEGIN ISOLATION LEVEL SERIALIZABLE",
														"ROLLBACK"
													])
												} else {
													const ops = memberOps(context, change)
													assertVariant(
														ops,
														"kind",
														"facts",
														"a write member takes its call's facts"
													)
													const seen = yield* observe(tap, Effect.result(ops.ops.apply(called, {})))
													assertFlights(call.kind, seen.window, 1, writeFraming)
												}
												notes.note(call.kind)
											}
											assert.equal(tap.cancels(), 0)
										})
								)
							})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"Db.open sends nothing, so a fresh Db's first call is the request's one round trip",
			(testContext) =>
				searched(
					testContext,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {
								task: W.Task,
								tasksFor: W.workReads(W.Work).automaticTasksFor,
								nothing: ChangeSet.empty(W.Work)
							}
						})
						const substrate = yield* Substrate
						const tap = makeTap(substrate.cluster)
						/** The login's own served layer, every byte of its pool's one session through the tap. */
						const tappedLayer = DbLayer.make({
							...clusterConnection(
								o.installed.cluster,
								o.installed.database,
								o.installed.as(o.server).password
							),
							transport: tap.transport,
							pool: { ...clusterPool, min: 1, max: 1 },
							login: o.served.login,
							verify: testVerify
						})
						return yield* Effect.gen(function* () {
							/** The session's startup, outside every window: a call of a Db opened before the cases. */
							const warm = yield* Db.open(o.served.login.roles.app, {})
							yield* warm.workload.task.get({ id: t1 })
							return yield* explore(
								{
									oracle: {
										kind: "specification",
										name: "README Deploying: Db.open contacts nothing, and each call is one round trip"
									},
									suite: "adapter/round-trips open",
									draw: drawn(firstCallsGen),
									literal: Formatter.format,
									kept: [],
									runs: 30,
									shrink: completeShrink,
									concurrency: 1,
									steerEvery: 16,
									coverage: required<FirstCallFeature>([...firstCallKinds, "several Dbs opened"], {
										cases: 30,
										sense: notesOnly
									}),
									caseHang
								},
								(c, notes) =>
									Effect.gen(function* () {
										const mark = tap.mark()
										const dbs = yield* Effect.forEach(Arr.range(1, c.opens), () =>
											Db.open(o.served.login.roles.app, {})
										)
										const opened = tap.since(mark)
										assert.equal(opened.events.length, 0, "Db.open writes and reads nothing")
										if (c.opens > 1) {
											notes.note("several Dbs opened")
										}
										const db = defined(dbs[pickIndex(c.caller, dbs.length)], "an opened Db")
										switch (c.call) {
											case "get":
												yield* db.workload.task.get({ id: c.present ? t1 : tMissing })
												break
											case "execute":
												yield* Effect.flatMap(
													db.workload.tasksFor.execute({ account: a1 }),
													(r) => r.collect
												)
												break
											case "apply":
												yield* db.workload.nothing.apply({})
												break
										}
										assertFlights(
											`Db.open and a first ${c.call}`,
											tap.since(mark),
											1,
											c.call === "apply" ? writeFraming : readFraming
										)
										notes.note(c.call)
										assert.equal(tap.cancels(), 0)
									})
							)
						}).pipe(withLayer(tappedLayer))
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"every drawn refresh through a refresh member is one round trip, its view unpopulated or populated, its choice made in the server",
			(testContext) =>
				searched(
					testContext,
					Effect.gen(function* () {
						const s = yield* Substrate
						const installation = yield* install(derivedFixture("Edu").Reports, {
							ambient: ordinarySession,
							extensions: [],
							label: "trips",
							logins: [derivedFixture("Edu").server]
						})
						const fixture = derivedFixture(installation.schema)
						const view = printObjectName(installation.names.relation("StudentWeekly"))
						/** pg_class.relispopulated of the view, read as the owner. */
						const populated = Effect.map(
							s.admin.queryValues(
								"SELECT c.relispopulated FROM pg_catalog.pg_class AS c WHERE c.oid = $1::regclass",
								[view]
							),
							(rows) => rows[0]?.[0] === true
						)
						return yield* withServedDb(
							installation,
							fixture.server.roles.refresher,
							{},
							({ ctx, load }) =>
								Effect.gen(function* () {
									const loaded = yield* load({ studentWeekly: refresh([fixture.StudentWeekly]) })
									const { pool, tap } = yield* tappedPool(installation.as(fixture.server))
									const refreshing = memberOps(
										{ ...ctx, pool },
										member(loaded, "studentWeekly")
									).ops
									return yield* explore(
										{
											oracle: { kind: "unstated" },
											suite: "adapter/round-trips refresh",
											draw: drawn(refreshesGen),
											literal: Formatter.format,
											kept: [],
											runs: 6,
											shrink: completeShrink,
											concurrency: 1,
											steerEvery: 16,
											coverage: required<RefreshFeature>(
												["a refresh of an unpopulated view", "a refresh of a populated view"],
												{ cases: 8, sense: notesOnly }
											),
											caseHang
										},
										(refreshes, notes) =>
											Effect.gen(function* () {
												for (const emptied of refreshes) {
													if (emptied) {
														yield* s.admin.query(
															`REFRESH MATERIALIZED VIEW ${view} WITH NO DATA`,
															[]
														)
													}
													const before = yield* populated
													const refreshed = yield* observe(tap, refreshing.refresh)
													assertFlights(
														before ? "refresh, populated" : "refresh, unpopulated",
														refreshed.window,
														1,
														writeFraming
													)
													const after = yield* populated
													assert.ok(after, "a refresh leaves its view populated")
													notes.note(
														before
															? "a refresh of a populated view"
															: "a refresh of an unpopulated view"
													)
												}
												assert.equal(tap.cancels(), 0)
											})
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
