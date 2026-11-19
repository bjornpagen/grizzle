/**
 * One round trip per public call, observed on the protocol through the tap (test/support/wire-tap.ts).
 *
 * Each call runs on an opened Db whose pool is one tapped session, warmed first, so a window holds one call's traffic
 * alone: a read's or a write's Db opened through its login's served layer, the session its pool's, a refresh's on its
 * served Db's context over a tapped pool of its own. The oracle is the contract (README "One call, one transaction, one
 * round trip or two" and "Deploying": Db.open contacts nothing): every call is exactly one round trip and one
 * transaction, read by its frame (test/support/wire-tap.ts frameOf: the isolation its BEGIN names, READ ONLY or not,
 * DEFERRABLE or not, COMMIT or ROLLBACK, whatever the spelling), its session idle at its end, and no CancelRequest sent.
 * Properties:
 *
 * - reads: a read's once, a key's once of a present or absent key, a paged read's window (from the start or the end,
 *   or after or before a key an earlier window delivered, drawn sizes) and a member's explain, over a plain read, a
 *   heterogeneous union, fused and pipelined attachments and an ordered page with an attachment, each of a plain member
 *   or of its deferrable(...) one, are each one round trip in a SERIALIZABLE READ ONLY transaction, DEFERRABLE exactly
 *   for a deferrable member, that commits, an EXPLAIN's rolling back;
 * - writes: a change member of note inserts, puts and deletes, with or without a read-back that attaches, applied or
 *   explained, is one round trip in a SERIALIZABLE transaction that commits, an EXPLAIN's rolling back, a call with
 *   nothing to write among them;
 * - refreshes: a refresh member's call, on its view as the last refresh left it or emptied first as a migration that
 *   recreates it leaves it, is one round trip in a SERIALIZABLE transaction that commits, and leaves its view populated;
 * - open: one to three Dbs opened through the login's own served layer put nothing on the wire, and a first call of
 *   one of them is the request's one round trip in its transaction.
 *
 * Features: each read kind over one part or several, a window from an end and from a key, each call kind of a deferrable
 * member; once, explain, a read-back
 * and nothing to write; a refresh of an unpopulated and of a populated view; each first call and several Dbs opened.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Option } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import type { ReadError } from "#adapter/errors/execution.ts"
import { Db } from "#adapter/public/db.ts"
import type { CallError, RowKey, Window } from "#compiler/live/index.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { arm, query, v } from "#compiler/public/query.ts"
import { refresh } from "#compiler/public/workload.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	anchorOf,
	assertFlight,
	derivedFixture,
	type FirstCallFeature,
	firstCallKinds,
	firstCallsGen,
	freshDbInstall,
	freshDbTemplate,
	keysOf,
	observe,
	type ReadCallFeature,
	readCallsGen,
	readFrame,
	readsInstall,
	readsTemplate,
	refreshesGen,
	type RefreshFeature,
	serializable,
	tappedLayer,
	tappedPool,
	tasks,
	tripsTemplate,
	type WriteCallFeature,
	writeCallsGen,
	writeFrame
} from "#test/pg/adapter/round-trips.fixtures.ts"
import { openedIn, workSeatInstall, workSeatTemplate } from "#test/pg/reads/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import { answered, oneOf, rowsOf, writeOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { sourcedDbLayer } from "#test/support/live-layer.ts"
import { clusterConnection, clusterPool } from "#test/support/pg.ts"
import { pickIndex } from "#test/support/pick.ts"
import { member, openServedDb, servedFixture } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { makeTap } from "#test/support/wire-tap.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { fullWorld, testVerify } from "#test/support/worlds.ts"

/**
 * One round trip per public call every drawn read, page and EXPLAIN of a query is one round trip, framed as its statements say.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/adapter/round-trips.test.ts at 8ad8d5b2c).
 */
export const oneRoundTripPerPublicCallEveryDrawnReadPageAndEXPLAINOfAQueryIsOneRoundTripFramedAsItsStatementsSay =
	property.explore(readCallsGen, {
		needs: { seated: Substrate.seat(readsTemplate) },
		situations: [
			"read one part",
			"read several parts",
			"explain one part",
			"explain several parts",
			"key one part",
			"page from an end",
			"page from a key",
			"deferrable read",
			"deferrable key",
			"deferrable explain",
			"deferrable page"
		] satisfies ReadonlyArray<Reached<ReadCallFeature>>,
		check:
			({ seated }, notes: Case<ReadCallFeature>) =>
			(calls) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(W.Work, workFacts, readsInstall, taken)
							const fixture = o.served
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
										explain: Effect.asVoid(
											db.workload.headingGroups.explain({ params: {}, facts: {} })
										)
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
								/** Each read query's deferrable member, as `queries` holds its plain one. */
								const deferredQueries = {
									"one relation": {
										once: Effect.asVoid(
											db.workload.deferredOneRelation.once({ params: { account: a1 }, facts: {} })
										),
										explain: Effect.asVoid(
											db.workload.deferredOneRelation.explain({
												params: { account: a1 },
												facts: {}
											})
										)
									},
									"heading groups": {
										once: Effect.asVoid(
											db.workload.deferredHeadingGroups.once({ params: {}, facts: {} })
										),
										explain: Effect.asVoid(
											db.workload.deferredHeadingGroups.explain({ params: {}, facts: {} })
										)
									},
									"fused attachments": {
										once: Effect.asVoid(
											db.workload.deferredFusedAttachments.once({
												params: { account: a1 },
												facts: {}
											})
										),
										explain: Effect.asVoid(
											db.workload.deferredFusedAttachments.explain({
												params: { account: a1 },
												facts: {}
											})
										)
									},
									"a pipelined attachment": {
										once: Effect.asVoid(
											db.workload.deferredPipelinedAttachment.once({ params: {}, facts: {} })
										),
										explain: Effect.asVoid(
											db.workload.deferredPipelinedAttachment.explain({ params: {}, facts: {} })
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
								/** Each ordered query's deferrable window, as `pages` holds its plain one. */
								const deferredPages = {
									budgets: (window: Window) =>
										Effect.map(
											db.workload.deferredBudgets.once({
												params: { account: a1 },
												facts: {},
												window
											}),
											keysOf
										),
									noted: (window: Window) =>
										Effect.map(
											db.workload.deferredNoted.once({
												params: { account: a1 },
												facts: {},
												window
											}),
											keysOf
										)
								}
								/** A task's key read, of its plain member or its deferrable one. */
								const keyRead = (deferred: boolean, present: boolean) => {
									const input = { params: { id: present ? t1 : tMissing }, facts: {} }
									return deferred
										? db.workload.deferredTask.once(input)
										: db.workload.task.once(input)
								}

								/** The keys each ordered query's windows delivered: a key anchors only its own query's windows. */
								const delivered: Readonly<Record<"budgets" | "noted", Array<RowKey>>> = {
									budgets: [],
									noted: []
								}
								for (const call of calls) {
									const target = queries[call.query]
									const member = call.deferrable ? deferredQueries[call.query] : target
									const windows = call.deferrable ? deferredPages : pages
									const edges = delivered[call.page]
									const anchor =
										edges.length === 0
											? Option.none<RowKey>()
											: Option.some(defined(edges[pickIndex(call.anchor, edges.length)]))
									const effect: Effect.Effect<
										ReadonlyArray<RowKey>,
										CallError | ReadError
									> = call.kind === "read"
										? Effect.as(member.once, [])
										: call.kind === "key"
											? Effect.as(keyRead(call.deferrable, call.present), [])
											: call.kind === "explain"
												? Effect.as(member.explain, [])
												: windows[call.page]({
														anchor: anchorOf(anchor, call.forward),
														size: call.size
													})
									const seen = yield* observe(tap, effect)
									assertFlight(
										call.kind,
										seen.window,
										serializable(
											"read only",
											call.deferrable,
											call.kind === "explain" ? "rollback" : "commit"
										)
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
									if (call.deferrable) {
										notes.note(`deferrable ${call.kind}`)
									}
									for (const key of seen.value) {
										edges.push(key)
									}
								}
								assert.equal(tap.cancels(), 0)
							}).pipe(
								withLayer(tappedLayer(o.installed, o.installed.as(o.server), fixture.login, tap))
							)
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "README: one call, one SERIALIZABLE READ ONLY transaction, DEFERRABLE for a deferrable member, one round trip"
		},
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})

/**
 * One round trip per public call every drawn write and EXPLAIN of a change member is one round trip in its transaction.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/adapter/round-trips.test.ts at 8ad8d5b2c).
 */
export const oneRoundTripPerPublicCallEveryDrawnWriteAndEXPLAINOfAChangeMemberIsOneRoundTripInItsTransaction =
	property.explore(writeCallsGen, {
		needs: { seated: Substrate.seat(workSeatTemplate) },
		situations: [
			"once",
			"explain",
			"a read-back that attaches",
			"nothing to write"
		] satisfies ReadonlyArray<Reached<WriteCallFeature>>,
		check:
			({ seated }, notes: Case<WriteCallFeature>) =>
			(calls) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(W.Work, workFacts, workSeatInstall, taken)
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
							return yield* Effect.gen(function* () {
								/**
								 * The Db every case calls, whose session's startup is its first call, with nothing to write, before the
								 * cases, outside every window.
								 */
								const db = yield* Db.open(fixture.login.roles.app, {})
								yield* answered(
									db.workload.plain.once({
										params: {},
										facts: {
											insert: { TaskNote: [] },
											put: { TaskNote: [] },
											delete: { TaskNote: [] }
										}
									})
								)

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
											serializable("read write", false, "rollback")
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
							}).pipe(
								withLayer(tappedLayer(o.installed, o.installed.as(o.server), fixture.login, tap))
							)
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "README: one call, one SERIALIZABLE transaction, one round trip"
		},
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: []
	})

/**
 * One round trip per public call Db.open sends nothing, so a fresh Db's first call is the request's one round trip.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/adapter/round-trips.test.ts at 8ad8d5b2c).
 */
export const oneRoundTripPerPublicCallDbOpenSendsNothingSoAFreshDbsFirstCallIsTheRequestsOneRoundTrip =
	property.explore(firstCallsGen, {
		needs: { seated: Substrate.seat(freshDbTemplate) },
		situations: [...firstCallKinds, "several Dbs opened"] satisfies ReadonlyArray<
			Reached<FirstCallFeature>
		>,
		check:
			({ seated }, notes: Case<FirstCallFeature>) =>
			(c) =>
				Effect.flatMap(seated, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const o = yield* openedIn(W.Work, workFacts, freshDbInstall, taken)
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
										yield* rowsOf(db.workload.tasksFor.once({ params: { account: a1 }, facts: {} }))
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
							}).pipe(withLayer(tappedLayer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "README Deploying: Db.open contacts nothing, and each call is one round trip"
		},
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: []
	})

/**
 * One round trip per public call every drawn refresh through a refresh member is one round trip, its view unpopulated or populated, its choice made in the server.
 *
 * Its pre-conversion budget: runs 6, coverage cases 8 (test/pg/adapter/round-trips.test.ts at 8ad8d5b2c).
 */
export const oneRoundTripPerPublicCallEveryDrawnRefreshThroughARefreshMemberIsOneRoundTripItsViewUnpopulatedOrPopulatedItsChoiceMadeInTheServer =
	property.explore(refreshesGen, {
		needs: { reports: Substrate.freshOf(tripsTemplate) },
		situations: [
			"a refresh of an unpopulated view",
			"a refresh of a populated view"
		] satisfies ReadonlyArray<Reached<RefreshFeature>>,
		check:
			({ reports }, notes: Case<RefreshFeature>) =>
			(refreshes) =>
				Effect.flatMap(reports, ({ substrate: seat, value: installation }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
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
							const { ctx, load } = yield* openServedDb(
								installation,
								fixture.server.roles.refresher,
								{}
							)
							const loaded = yield* load({ studentWeekly: refresh([fixture.StudentWeekly]) })
							const { pool, tap } = yield* tappedPool(installation.as(fixture.server))
							const refreshing = writeOnce(
								onceCalls({ ...ctx, pool }, member(loaded, "studentWeekly"))
							)({ params: {}, facts: {} })

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
									before ? "a refresh of a populated view" : "a refresh of an unpopulated view"
								)
							}
							assert.equal(tap.cancels(), 0)
						}).pipe(Effect.scoped),
						Substrate,
						seat
					)
				),
		oracle: {
			kind: "specification",
			name: "README: a refresh is one SERIALIZABLE transaction in one round trip, its view populated after"
		},
		budget: { runs: 6, steered: 8 },
		kept: [],
		kills: []
	})
