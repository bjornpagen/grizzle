/**
 * One round trip per public call, observed on the protocol through the tap (test/support/wire-tap.ts).
 *
 * Each call runs on an opened Db whose pool is one tapped session, warmed first, so a window holds one call's traffic
 * alone. The oracle is the contract (README "One call, one transaction, one round trip or two" and "Deploying": Db.open
 * contacts nothing): every call is exactly one round trip and one transaction, read by its frame (test/support/wire-tap.ts
 * frameOf: the isolation its BEGIN names, READ ONLY or not, COMMIT or ROLLBACK, whatever the spelling), its session idle
 * at its end, and no CancelRequest sent. Properties:
 *
 * - reads: a read's execute, a key's get of a present or absent key, a page request (first, last, after and before an
 *   edge an earlier page delivered, drawn sizes) and a member's explain, over a plain read, a heterogeneous union, fused
 *   and pipelined attachments and an ordered page with an attachment, are each one round trip in a SERIALIZABLE READ
 *   ONLY transaction that commits, an EXPLAIN's rolling back;
 * - writes: a change member of note inserts, puts and deletes, with or without a read-back that attaches, applied or
 *   explained, is one round trip in a SERIALIZABLE transaction that commits, an EXPLAIN's rolling back, a call with
 *   nothing to write among them;
 * - refreshes: a refresh member's call, on its view as the last refresh left it or emptied first as a migration that
 *   recreates it leaves it, is one round trip in a SERIALIZABLE transaction that commits, and leaves its view populated;
 * - open: one to three Dbs opened through the login's own served layer put nothing on the wire, and a first call of
 *   one of them is the request's one round trip in its transaction.
 *
 * Features: each read kind over one part or several, a page alone and with its probe; apply, explain, a read-back and
 * nothing to write; a refresh of an unpopulated and of a populated view; each first call and several Dbs opened.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): round-trips-read-write.patch (a read's transaction opened READ WRITE),
 * round-trips-commit-flight.patch (COMMIT sent in a flight of its own), round-trips-refresh-frame.patch (a refresh
 * opened READ ONLY).
 */
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
	frameOf,
	makeTap,
	type Tap,
	type TransactionFrame,
	type WireWindow
} from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { testVerify } from "#test/support/worlds.ts"

/** A transaction the contract fixes: SERIALIZABLE, read-only or not, and how it ends. */
const serializable = (
	access: "read only" | "read write",
	end: "commit" | "rollback"
): TransactionFrame => ({ kind: "framed", isolation: "SERIALIZABLE", access, end })

/** A read's transaction: SERIALIZABLE READ ONLY, committed. */
const readFrame = serializable("read only", "commit")
/** A write's or a refresh's transaction: SERIALIZABLE, committed. */
const writeFrame = serializable("read write", "commit")

/** The traffic of `effect`, and its value. */
const observe = <A, E, R>(tap: Tap, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const mark = tap.mark()
		const value = yield* effect
		return { value, window: tap.since(mark) }
	})

/** `window` is one round trip, one transaction of `frame`, and leaves its session idle. */
const assertFlight = (label: string, window: WireWindow, frame: TransactionFrame) => {
	assert.equal(window.roundTrips, 1, `${label}: round trips`)
	assert.deepEqual(frameOf(window), frame, `${label}: its transaction`)
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

/**
 * What a read call met: a read of one part or of several, each one statement (lower/shapes/index.ts PartedStatement),
 * and a page alone or with its probe, the one read whose flight sends a second statement.
 */
type ReadCallFeature =
	| `${"execute" | "explain"} ${"one part" | "several parts"}`
	| "get one part"
	| `page ${"alone" | "with its probe"}`

/**
 * A drawn read call: its kind, the query it reads (a page's ordered query), a present or absent key, a page's
 * direction, size and anchor among the edges earlier pages delivered.
 */
const readCallsGen = array(
	(source) => ({
		kind: source.draw(element(readCallKinds)),
		query: source.draw(
			element([
				"one relation",
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
					/** Ordered pages: one of one part, and one whose attachment is a part over the page it holds. */
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
					/**
					 * Each read query, and whether its statement is one part or several: a heading group or a pipelined
					 * attachment each a part of its own.
					 */
					const queries = {
						"one relation": { member: "oneRelation", params: { account: a1 }, parts: "one part" },
						"heading groups": { member: "headingGroups", params: {}, parts: "several parts" },
						"fused attachments": {
							member: "fusedAttachments",
							params: { account: a1 },
							parts: "one part"
						},
						"a pipelined attachment": {
							member: "pipelinedAttachment",
							params: {},
							parts: "several parts"
						}
					} as const
					return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
						Effect.gen(function* () {
							const loaded = yield* load({
								oneRelation: reads.automaticTasksFor,
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
									oracle: {
										kind: "specification",
										name: "README: one call, one SERIALIZABLE READ ONLY transaction, one round trip"
									},
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
											"execute one part",
											"execute several parts",
											"explain one part",
											"explain several parts",
											"get one part",
											"page alone",
											"page with its probe"
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
											const probed = call.kind === "page" && Option.isSome(anchor)
											assertFlight(
												call.kind,
												seen.window,
												call.kind === "explain" ? serializable("read only", "rollback") : readFrame
											)
											notes.note(
												call.kind === "page"
													? probed
														? "page with its probe"
														: "page alone"
													: call.kind === "get"
														? "get one part"
														: `${call.kind} ${target.parts}`
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
									oracle: {
										kind: "specification",
										name: "README: one call, one SERIALIZABLE transaction, one round trip"
									},
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
												assertFlight(
													"explain of a change member",
													seen.window,
													serializable("read write", "rollback")
												)
											} else {
												const ops = memberOps(context, change)
												assertVariant(ops, "kind", "facts", "a write member takes its call's facts")
												const seen = yield* observe(tap, Effect.result(ops.ops.apply(called, {})))
												assertFlight(call.kind, seen.window, writeFrame)
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
									assertFlight(
										`Db.open and a first ${c.call}`,
										tap.since(mark),
										c.call === "apply" ? writeFrame : readFrame
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
								const refreshing = memberOps({ ...ctx, pool }, member(loaded, "studentWeekly")).ops
								return yield* explore(
									{
										oracle: {
											kind: "specification",
											name: "README: a refresh is one SERIALIZABLE transaction in one round trip, its view populated after"
										},
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
													yield* s.admin.query(`REFRESH MATERIALIZED VIEW ${view} WITH NO DATA`, [])
												}
												const before = yield* populated
												const refreshed = yield* observe(tap, refreshing.refresh)
												assertFlight(
													before ? "refresh, populated" : "refresh, unpopulated",
													refreshed.window,
													writeFrame
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
