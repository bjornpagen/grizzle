/**
 * One round trip per public call, observed on the protocol through the tap (test/support/wire-tap.ts).
 *
 * Each call runs on an opened Db whose pool is one tapped session, warmed first, so a window holds one call's traffic
 * alone: a read's or a write's Db opened through its login's served layer, the session its pool's, a refresh's on its
 * served Db's context over a tapped pool of its own. The oracle is the contract (README "One call, one transaction, one
 * round trip or two" and "Deploying": Db.open contacts nothing): every call is exactly one round trip and one
 * transaction, read by its frame (test/support/wire-tap.ts frameOf: the isolation its BEGIN names, READ ONLY or not,
 * COMMIT or ROLLBACK, whatever the spelling), its session idle at its end, and no CancelRequest sent. Properties:
 *
 * - reads: a read's once, a key's once of a present or absent key, a paged read's window (from the start or the end,
 *   or after or before a key an earlier window delivered, drawn sizes) and a member's explain, over a plain read, a
 *   heterogeneous union, fused and pipelined attachments and an ordered page with an attachment, are each one round
 *   trip in a SERIALIZABLE READ ONLY transaction that commits, an EXPLAIN's rolling back;
 * - writes: a change member of note inserts, puts and deletes, with or without a read-back that attaches, applied or
 *   explained, is one round trip in a SERIALIZABLE transaction that commits, an EXPLAIN's rolling back, a call with
 *   nothing to write among them;
 * - refreshes: a refresh member's call, on its view as the last refresh left it or emptied first as a migration that
 *   recreates it leaves it, is one round trip in a SERIALIZABLE transaction that commits, and leaves its view populated;
 * - open: one to three Dbs opened through the login's own served layer put nothing on the wire, and a first call of
 *   one of them is the request's one round trip in its transaction.
 *
 * Features: each read kind over one part or several, a window from an end and from a key; once, explain, a read-back
 * and nothing to write; a refresh of an unpopulated and of a populated view; each first call and several Dbs opened.
 *
 * Plants (~/.cache/grizzle-release/BR13/plants): round-trips-read-write.patch (a read's transaction opened READ
 * WRITE), round-trips-commit-flight.patch (a call's COMMIT sent in a flight of its own),
 * round-trips-refresh-frame.patch (a refresh opened READ ONLY); ~/.cache/grizzle-release/EXPLAIN/plants/rollback-dropped.patch
 * (an explain's transaction committed).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { memberCalls } from "#adapter/db/handles.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { ServedLogin } from "#adapter/types/layer.ts"
import type { Anchor, CallError, KeyedList, RowKey, Window } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { arm, query, v } from "#compiler/public/query.ts"
import {
	type AnyLogin,
	derived,
	login,
	relation,
	role,
	schema,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { paged, refresh } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { installed } from "#test/pg/reads/support.ts"
import { ordinarySession } from "#test/support/ambient.ts"
import { assert, defined } from "#test/support/assert.ts"
import { answered, oneOf, rowsOf, writeOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, t4, t5, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { type Installed, installMigrated as install } from "#test/support/install-migrate.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import { member, servedFixture, withServedDb } from "#test/support/served-db.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	frameOf,
	makeTap,
	type Tap,
	type TransactionFrame,
	type WireWindow
} from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, testVerify } from "#test/support/worlds.ts"

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
	const Edu = schema(name, [Sitting], [])
	const StudentWeekly = derived.materialized(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student, week }).find({ student, week, sittings: r.count() })
		})
	)
	const Reports = schema.extend(Edu, `${name}_1`, [StudentWeekly], [])
	const refresher = role(Reports, "refresher", wholeEntriesOf(Reports), {
		refresh: ["StudentWeekly"]
	})
	return { StudentWeekly, Reports, refresher, server: login(Reports, "server", [refresher]) }
}

/**
 * The layer of `login`, served over `installed` as servedFixture serves it, its pool one session of `credentials`
 * whose every byte passes through `tap`.
 */
const tappedLayer = <L extends AnyLogin>(
	installed: Installed,
	credentials: Credentials,
	login: ServedLogin<L>,
	tap: Tap
) =>
	sourcedDbLayer(installed, {
		...clusterConnection(installed.cluster, installed.database, credentials.password),
		transport: tap.transport,
		pool: { ...clusterPool, min: 1, max: 1 },
		login,
		verify: testVerify
	})

/** A window's anchor in its direction: the start or the end, or after or before a key an earlier window delivered. */
const anchorOf = (key: Option.Option<RowKey>, forward: boolean): Anchor =>
	Option.match(key, {
		onNone: (): Anchor => (forward ? { kind: "start" } : { kind: "end" }),
		onSome: (at): Anchor => (forward ? { kind: "after", key: at } : { kind: "before", key: at })
	})

/** The keys of a window's rows, in order: what a later window is anchored after or before. */
const keysOf = <Row extends object>(window: KeyedList<Row>): ReadonlyArray<RowKey> =>
	Arr.map([...window.entries()], (entry) => entry.key)

const readCallKinds = ["read", "key", "explain", "page"] as const

/**
 * What a read call met: a read of one part or of several, each one statement (lower/shapes/index.ts PartedStatement),
 * and a window from the start or the end, or anchored at a key an earlier window delivered.
 */
type ReadCallFeature =
	| `${"read" | "explain"} ${"one part" | "several parts"}`
	| "key one part"
	| `page ${"from an end" | "from a key"}`

/**
 * A drawn read call: its kind, the query it reads (a page's ordered query), a present or absent key, a window's
 * direction, size and anchor among the keys earlier windows delivered.
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

const firstCallKinds = ["key", "read", "write"] as const
type FirstCallFeature = (typeof firstCallKinds)[number] | "several Dbs opened"

/** Dbs opened in one request and the first call one of them makes. */
interface FirstCall {
	readonly opens: number
	readonly caller: number
	readonly call: (typeof firstCallKinds)[number]
	readonly present: boolean
}

/**
 * One to three Dbs opened in one request, and the first call one of them makes: a key's once of a present or absent
 * key, a read's once, or a write's once with nothing to write, which sends its transaction all the same.
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

type WriteCallFeature = "once" | "explain" | "a read-back that attaches" | "nothing to write"

/**
 * A drawn write call: notes inserted, put or deleted, none among them (a call with nothing to write, which still sends
 * its transaction), with or without a read-back, written once or explained.
 */
const writeCallsGen = array(
	(source) => ({
		kind: source.draw(element(["once", "explain"] as const)),
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
					const fixture = yield* servedFixture(
						o.installed,
						fullWorld(s, {
							oneRelation: reads.automaticTasksFor,
							headingGroups: payloads,
							fusedAttachments: reads.taskCards,
							pipelinedAttachment: accountTaskNotes,
							task: W.Task,
							budgets: paged(budgets),
							noted: paged(noted)
						}).server
					)
					const substrate = yield* Substrate
					const tap = makeTap(substrate.cluster)
					return yield* Effect.gen(function* () {
						/**
						 * The Db every case calls, whose session's startup is its first call, before the cases, outside every
						 * window.
						 */
						const db = yield* Db.open(fixture.login.roles.app, {})
						yield* oneOf(db.workload.task.once({ params: { id: t1 }, facts: {} }))
						/**
						 * Each read query: whether its statement is one part or several, a heading group or a pipelined
						 * attachment each a part of its own; its once; and its estimate-only explain of the same input.
						 */
						const queries = {
							"one relation": {
								parts: "one part",
								once: Effect.asVoid(
									db.workload.oneRelation.once({ params: { account: a1 }, facts: {} })
								),
								explain: Effect.asVoid(
									db.workload.oneRelation.explain({ params: { account: a1 }, facts: {} })
								)
							},
							"heading groups": {
								parts: "several parts",
								once: Effect.asVoid(db.workload.headingGroups.once({ params: {}, facts: {} })),
								explain: Effect.asVoid(db.workload.headingGroups.explain({ params: {}, facts: {} }))
							},
							"fused attachments": {
								parts: "one part",
								once: Effect.asVoid(
									db.workload.fusedAttachments.once({ params: { account: a1 }, facts: {} })
								),
								explain: Effect.asVoid(
									db.workload.fusedAttachments.explain({ params: { account: a1 }, facts: {} })
								)
							},
							"a pipelined attachment": {
								parts: "several parts",
								once: Effect.asVoid(
									db.workload.pipelinedAttachment.once({ params: {}, facts: {} })
								),
								explain: Effect.asVoid(
									db.workload.pipelinedAttachment.explain({ params: {}, facts: {} })
								)
							}
						} as const
						/** Each ordered query's window over the account's tasks, as the keys of its rows. */
						const pages = {
							budgets: (window: Window) =>
								Effect.map(
									db.workload.budgets.once({ params: { account: a1 }, facts: {}, window }),
									keysOf
								),
							noted: (window: Window) =>
								Effect.map(
									db.workload.noted.once({ params: { account: a1 }, facts: {}, window }),
									keysOf
								)
						}
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
										"read one part",
										"read several parts",
										"explain one part",
										"explain several parts",
										"key one part",
										"page from an end",
										"page from a key"
									],
									{ cases: 40, sense: notesOnly }
								),
								caseHang
							},
							(calls, notes) =>
								Effect.gen(function* () {
									/** The keys each ordered query's windows delivered: a key anchors only its own query's windows. */
									const delivered: Readonly<Record<"budgets" | "noted", Array<RowKey>>> = {
										budgets: [],
										noted: []
									}
									for (const call of calls) {
										const target = queries[call.query]
										const edges = delivered[call.page]
										const anchor =
											edges.length === 0
												? Option.none<RowKey>()
												: Option.some(defined(edges[pickIndex(call.anchor, edges.length)]))
										const effect: Effect.Effect<
											ReadonlyArray<RowKey>,
											CallError | ReadError
										> = call.kind === "read"
											? Effect.as(target.once, [])
											: call.kind === "key"
												? Effect.as(
														db.workload.task.once({
															params: { id: call.present ? t1 : tMissing },
															facts: {}
														}),
														[]
													)
												: call.kind === "explain"
													? Effect.as(target.explain, [])
													: pages[call.page]({
															anchor: anchorOf(anchor, call.forward),
															size: call.size
														})
										const seen = yield* observe(tap, effect)
										assertFlight(
											call.kind,
											seen.window,
											call.kind === "explain" ? serializable("read only", "rollback") : readFrame
										)
										notes.note(
											call.kind === "page"
												? Option.isSome(anchor)
													? "page from a key"
													: "page from an end"
												: call.kind === "key"
													? "key one part"
													: `${call.kind} ${target.parts}`
										)
										for (const key of seen.value) {
											edges.push(key)
										}
									}
									assert.equal(tap.cancels(), 0)
								})
						)
					}).pipe(withLayer(tappedLayer(o.installed, o.installed.as(o.server), fixture.login, tap)))
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
					const fixture = yield* servedFixture(
						o.installed,
						fullWorld(s, {
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
						}).server
					)
					const substrate = yield* Substrate
					const tap = makeTap(substrate.cluster)
					const tasks = [t1, t4, t5] as const
					return yield* Effect.gen(function* () {
						/**
						 * The Db every case calls, whose session's startup is its first call, with nothing to write, before the
						 * cases, outside every window.
						 */
						const db = yield* Db.open(fixture.login.roles.app, {})
						yield* answered(
							db.workload.plain.once({
								params: {},
								facts: { insert: { TaskNote: [] }, put: { TaskNote: [] }, delete: { TaskNote: [] } }
							})
						)
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
									["once", "explain", "a read-back that attaches", "nothing to write"],
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
										/** The call's input: the drawn notes under the op it writes, every other op's none. */
										const input = {
											params: {},
											facts: {
												insert: { TaskNote: call.op === "insert" ? facts : [] },
												put: { TaskNote: call.op === "put" ? facts : [] },
												delete: { TaskNote: call.op === "delete" ? facts : [] }
											}
										}
										if (call.readBack) {
											notes.note("a read-back that attaches")
										}
										if (call.notes.length === 0) {
											notes.note("nothing to write")
										}
										if (call.kind === "explain") {
											const seen = yield* observe(
												tap,
												call.readBack
													? db.workload.readBack.explain(input)
													: db.workload.plain.explain(input)
											)
											assertFlight(
												"explain of a change member",
												seen.window,
												serializable("read write", "rollback")
											)
										} else {
											const seen = yield* observe(
												tap,
												Effect.result(
													answered(
														call.readBack
															? db.workload.readBack.once(input)
															: db.workload.plain.once(input)
													)
												)
											)
											assertFlight(call.kind, seen.window, writeFrame)
										}
										notes.note(call.kind)
									}
									assert.equal(tap.cancels(), 0)
								})
						)
					}).pipe(withLayer(tappedLayer(o.installed, o.installed.as(o.server), fixture.login, tap)))
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
					const tappedLayer = sourcedDbLayer(o.installed, {
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
						yield* oneOf(warm.workload.task.once({ params: { id: t1 }, facts: {} }))
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
									const dbs = yield* Effect.forEach(
										upTo(c.opens, (i) => i + 1),
										() => Db.open(o.served.login.roles.app, {})
									)
									const opened = tap.since(mark)
									assert.equal(opened.events.length, 0, "Db.open writes and reads nothing")
									if (c.opens > 1) {
										notes.note("several Dbs opened")
									}
									const db = defined(dbs[pickIndex(c.caller, dbs.length)], "an opened Db")
									switch (c.call) {
										case "key":
											yield* oneOf(
												db.workload.task.once({
													params: { id: c.present ? t1 : tMissing },
													facts: {}
												})
											)
											break
										case "read":
											yield* rowsOf(
												db.workload.tasksFor.once({ params: { account: a1 }, facts: {} })
											)
											break
										case "write":
											yield* answered(db.workload.nothing.once({ params: {}, facts: {} }))
											break
									}
									assertFlight(
										`Db.open and a first ${c.call}`,
										tap.since(mark),
										c.call === "write" ? writeFrame : readFrame
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
								const refreshing = writeOnce(
									memberCalls({ ...ctx, pool }, member(loaded, "studentWeekly"))
								)({ params: {}, facts: {} })
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
												const refreshed = yield* observe(tap, refreshing)
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
