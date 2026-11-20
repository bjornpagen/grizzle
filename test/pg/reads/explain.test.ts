/**
 * Explain on PostgreSQL 19: a served member's explain (adapter/served/explain.ts, through its handle's operations,
 * adapter/db/handles.ts memberExplains) plans exactly the named prepared statements the call it explains would send,
 * each under its served name, decodes each plan into the typed Plan whose every node names what it reads by the login's
 * served file, writes nothing, and refuses each call the host refuses at its stage before any session is leased.
 *
 * The oracle of "the statements the call sends" is the call itself: each case runs on a Db whose pool of one session is
 * tapped (test/support/wire-tap.ts), explains the program, then runs it, and the plans must be exactly the statements
 * that run sent which have a plan, every Execute on the wire but a carrier's CREATE TEMPORARY TABLE and its ANALYZE
 * (utility statements PostgreSQL never plans), in order: each plan under the name its statement was bound by, and each
 * EXPLAIN explain sent over exactly that statement's served text (sql/emit.ts explainOf). The oracle of what a node
 * reads is the catalog and the installation's names: a relation of the member's footprint, the relations its program
 * names (schema/walk.ts queryUses for a read; the Shop relations a ChangeSet writes and reads back), and an index the
 * catalog holds on that relation's table (physical/ddl/names.ts InstallNames relation). As properties:
 *
 * - a read drawn over the worked example's Work (a plain read, a heterogeneous union, fused attachments, nested
 *   pipelined attachments, a relation parameter of drawn ids), each a served member, is explained, and analyzed under
 *   EXPLAIN ANALYZE, one plan per statement its execute sends, under its name, over its text, every node reading within
 *   the footprint;
 * - a ChangeSet drawn over the Shop fixture (one or two strata of inserts, puts and deletes,
 *   with or without read-backs of delta.added and delta.removed, one joining Item's added facts with Stock), a
 *   change member whose first stratum's rows are the call's facts and whose second's are query members over the call's
 *   relation parameters, is explained one plan per plannable statement its apply sends, under its name, over its text,
 *   in a transaction that is rolled back: no fact written, which EXPLAIN ANALYZE would have done; a read-back rides
 *   the statement that makes its delta, so no plan reads a carrier but a staged member slot's, the call's own facts
 *   that two statements read (write/program/slot-carriers.ts);
 * - a served ChangeSet inserting a box with its parts nested, each part's body a drawn share of the session's message
 *   bound, within it or past it, and among the cases bodies each within it and together past it, which the application
 *   cuts across executions, on a session whose bound is planted at the longest Parse message of the texts explain
 *   sends of the write, each planned one as its EXPLAIN (test/support/staged.ts explainedTextBound), as a server whose
 *   bound is below the protocol's holds it: explain plans it exactly where the application of the same call on the
 *   same session writes it, each cutting its executions under the session's bound (apply/run.ts sessionTransport);
 * - every Plan holds exactly its public fields, its estimates finite, and an ExecutedPlan its actuals beside them;
 * - drawn notes over Work, or a ChangeSet over a schema no role of the Db holds, are refused as a model of the host's
 *   refusals says: a ChangeSet over no level of the role's schema where its workload is built, MalformedDescription, a
 *   same-key pair host normalization refuses ReadFailure{encode, InputRejected} witnessed by the key it states twice,
 *   as the call's apply answers invariant-rejected (adapter/errors/failures.ts InputRejected), each found before a
 *   session is leased, and any other is explained, executing nothing. No number of facts is refused: a statement's Bind message past
 *   PostgreSQL's message limit is the one resource refusal, a unit test's (test/unit/adapter/bind.test.ts), since a
 *   gibibyte of parameters is no case to send.
 *
 * An explain whose transaction commits instead of rolling back leaves the database's state as a ROLLBACK does, since an
 * estimate-only explain runs nothing but a carrier's CREATE TEMPORARY TABLE ... ON COMMIT DROP and its ANALYZE and an
 * analyzed read runs READ ONLY, so no state here witnesses it: test/pg/adapter/round-trips.test.ts, which reads each
 * explain's transaction off the wire, catches it.
 */
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result as EffectResult } from "effect"
import { memberExplains, onceCalls, variantOf } from "#adapter/db/handles.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { type ParamMap } from "#compiler/plan/common.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	analyzing,
	boundCases,
	type BoundFeature,
	boundFeatureOf,
	boundPool,
	boundWhole,
	Box,
	Boxes,
	catalogIndexes,
	changeCaseGen,
	type ChangeFeature,
	Elsewhere,
	estimateOnly,
	estimating,
	executedShape,
	explainBoxesInstall,
	explainBoxesTemplate,
	explainShopInstall,
	explainShopTemplate,
	footprintOf,
	labels,
	laterStratum,
	nodes,
	observe,
	ofTheServed,
	plannedStatements,
	queryCaseGen,
	type QueryFeature,
	queryFeatures,
	readExplains,
	readsWithin,
	refusalCaseGen,
	type RefusalFeature,
	refusalOf,
	tappedPool,
	workPrograms,
	workReads,
	notesUnchanged
} from "#test/pg/reads/explain.fixtures.ts"
import { Item, Seat, Shop, Stock, uuidOf } from "#test/pg/reads/shop.ts"
import { openedIn, workSeatInstall, workSeatTemplate } from "#test/pg/reads/support.ts"
import { throwsRefused } from "#test/support/assert.ts"
import { answered, readOnce } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { t2, t4, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { flightSlotCarriers, textsNaming } from "#test/support/slot-carriers.ts"
import { explainedTextBound } from "#test/support/staged.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Explains and analyzes a drawn read: its execute's statements, by name and text, read within its footprint, each case
 * on the worker's seat of Work with its facts loaded, opening its own tapped Db.
 *
 * Its pre-conversion budget: runs 20, coverage cases 20 (test/pg/reads/explain.test.ts at d1a6ae9ac).
 */
export const explainsAndAnalyzesADrawnReadItsExecutesStatementsByNameAndTextReadWithinItsFootprint =
	property.explore(queryCaseGen, {
		needs: { seated: Substrate.seat(workSeatTemplate) },
		situations: queryFeatures satisfies ReadonlyArray<Reached<QueryFeature>>,
		check:
			({ seated }, notes: Case<QueryFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(seated, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(W.Work, workFacts, workSeatInstall, taken)
								const indexes = yield* catalogIndexes
								const tableOf = (relation: string) =>
									o.installed.installation.names.relation(relation)
								const { ctx, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								const { members, tables } = yield* loadWithTables(workPrograms)
								const read = workReads[c.read]
								const params = read.params(c.pick)
								const program = member(members, read.member)
								const explains = readExplains(memberExplains(context, tables, program))
								const plans = yield* observe(tap, explains.explain({ params, facts: {} }))
								const analyzed = yield* observe(tap, explains.explainAnalyze({ params, facts: {} }))
								const executed = yield* observe(
									tap,
									readOnce(onceCalls(context, program))({ params, facts: {} })
								)
								const sent = plannedStatements(tap, executed.window, context.prologue)
								ofTheServed(
									plans.value,
									sent,
									plannedStatements(tap, plans.window, context.prologue),
									estimating
								)
								ofTheServed(
									analyzed.value,
									sent,
									plannedStatements(tap, analyzed.window, context.prologue),
									analyzing
								)
								const footprint = footprintOf(workPrograms[read.member])
								for (const plan of plans.value) {
									estimateOnly(plan.plan)
									readsWithin(plan.plan, footprint, tableOf, indexes)
								}
								for (const plan of analyzed.value) {
									executedShape(plan.plan)
									assert.ok(
										Number.isFinite(plan.planningMs) && Number.isFinite(plan.executionMs),
										"an analyzed statement's times"
									)
								}
								notes.note(c.read)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the execution of the same call on a tapped session: one plan per plannable statement it sent, under its name, over its text; and the catalog's indexes of the footprint's tables"
		},
		show: Formatter.format,
		budget: { runs: 20, steered: 20 },
		kept: [],
		kills: []
	})

/**
 * Explains a drawn ChangeSet: its apply's plannable statements, by name and text, within its footprint, executing
 * nothing, each case on the worker's seat of the Shop fixture, opening its own tapped Db, its apply's rows emptied after
 * it.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/reads/explain.test.ts at d1a6ae9ac).
 */
export const explainsADrawnChangeSetItsApplysPlannableStatementsByNameAndTextWithinItsFootprintExecutingNothing =
	property.explore(changeCaseGen, {
		needs: { shop: Substrate.seat(explainShopTemplate) },
		situations: [
			"a seat inserted",
			"an insert",
			"a put",
			"a delete",
			"two strata",
			"a read-back",
			"a read-back joining a stored relation"
		] satisfies ReadonlyArray<Reached<ChangeFeature>>,
		check:
			({ shop }, notes: Case<ChangeFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(shop, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Shop, {}, explainShopInstall, taken)
								const state = () =>
									Effect.all([
										tableState(o.installed, Seat),
										tableState(o.installed, Stock),
										tableState(o.installed, Item)
									])
								const indexes = yield* catalogIndexes
								const tableOf = (relation: string) =>
									o.installed.installation.names.relation(relation)
								/** The relations every drawn ChangeSet writes and reads back. */
								const footprint: ReadonlySet<string> = new Set(["Seat", "Item", "Stock"])
								const { ctx, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								/** A stratum's operations, each kind's facts together. */
								const strata = Arr.map(c.strata, (ops) => {
									const seats = Arr.flatMap(ops, (op) =>
										op.kind === "seat"
											? [{ no: BigInt(op.id), label: defined(labels[op.label]) }]
											: []
									)
									const items = Arr.flatMap(ops, (op) =>
										op.kind === "item"
											? [{ id: uuidOf(op.id), label: "bin", qty: BigInt(op.qty) }]
											: []
									)
									const puts = Arr.flatMap(ops, (op) =>
										op.kind === "put stock"
											? [
													{
														id: uuidOf(op.id),
														label: defined(labels[op.label]),
														qty: BigInt(op.qty)
													}
												]
											: []
									)
									const deletes = Arr.flatMap(ops, (op) =>
										op.kind === "delete stock" ? [{ id: uuidOf(op.id), label: "old", qty: 0n }] : []
									)
									if (seats.length > 0) {
										notes.note("a seat inserted")
									}
									if (items.length > 0) {
										notes.note("an insert")
									}
									if (puts.length > 0) {
										notes.note("a put")
									}
									if (deletes.length > 0) {
										notes.note("a delete")
									}
									return { seats, items, puts, deletes }
								})
								const [first, second] = strata
								const written = defined(first, "a first stratum")
								/** The first stratum's array members, each a call's facts. */
								const firstStratum = ChangeSet.empty(Shop)
									.insert(Seat, [])
									.insert(Item, [])
									.put(Stock, [])
									.delete(Stock, [])
								const sequenced =
									second === undefined
										? firstStratum
										: ChangeSet.sequence(firstStratum, laterStratum)
								if (second !== undefined) {
									notes.note("two strata")
								}
								const changes =
									c.readBack === "none"
										? sequenced
										: c.readBack === "items joined"
											? sequenced.read("items", (d) =>
													query(Shop).rule((r) => {
														const { id, label, qty } = v(Stock, "stock")
														return r
															.match(d.added(Item), { id })
															.match(Stock, { id, label, qty })
															.find({ id, label, qty })
													})
												)
											: sequenced.read("items", (d) =>
													query(Shop)
														.rule((r) => {
															const { id, label, qty } = v(Item, "item")
															return r
																.match(d.added(Item), { id, label, qty })
																.find({ side: "added", id, label, qty })
														})
														.rule((r) => {
															const { id, label, qty } = v(Item, "item")
															return r
																.match(d.removed(Item), { id, label, qty })
																.find({ side: "removed", id, label, qty })
														})
												)
								const facts = {
									insert: { Seat: written.seats, Item: written.items },
									put: { Stock: written.puts },
									delete: { Stock: written.deletes }
								}
								const params: ParamMap =
									second === undefined
										? {}
										: {
												seats: second.seats,
												items: second.items,
												puts: second.puts,
												deletes: second.deletes
											}
								const loaded = yield* loadWithTables({ changes })
								const change = member(loaded.members, "changes")
								const explains = memberExplains(context, loaded.tables, change)
								assertVariant(
									explains,
									"kind",
									"change",
									"a ChangeSet of array members explains with its call's facts"
								)
								const before = yield* state()
								const plans = yield* observe(tap, explains.explain({ params, facts }))
								const after = yield* state()
								assert.deepEqual(
									exactValue(after, before),
									Option.none(),
									"explain executes nothing"
								)
								for (const plan of plans.value) {
									estimateOnly(plan.plan)
									readsWithin(plan.plan, footprint, tableOf, indexes)
								}
								const calls = onceCalls(context, change)
								assertVariant(
									calls,
									"shape",
									"write",
									"a ChangeSet of array members takes its call's facts"
								)
								const applied = yield* observe(
									tap,
									Effect.result(answered(calls.once({ params, facts })))
								)
								ofTheServed(
									plans.value,
									plannedStatements(tap, applied.window, context.prologue),
									plannedStatements(tap, plans.window, context.prologue),
									estimating
								)
								if (applied.value._tag === "Failure") {
									notes.note("a refused apply")
								}
								if (c.readBack !== "none") {
									assertVariant(change, "kind", "change", "the changes member is a ChangeSet's")
									const flight = variantOf(context, change.variants).entry.program
									const staged = flightSlotCarriers(flight)
									assert.deepEqual(
										Arr.filter(
											flight.statements,
											(s) => s.step.kind === "carrier" && !staged.has(s.step.carrier)
										),
										[],
										"a read-back rides the statement that makes its delta: every carrier the flight creates is a staged member slot's"
									)
									const naming = textsNaming(flight, staged)
									assert.deepEqual(
										Arr.filter(
											Arr.flatMap(plans.value, (p) =>
												naming.has(p.statement) ? [] : nodes(p.plan)
											),
											(n) => n.on.kind === "carrier"
										),
										[],
										"a read-back rides the statement that makes its delta: no plan reads a carrier but a staged member slot's statements"
									)
									notes.note("a read-back")
								}
								if (c.readBack === "items joined") {
									notes.note("a read-back joining a stored relation")
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the application of the same call on a tapped session: one plan per plannable statement it sent, under its name, over its text, and the state before it unchanged by the explain; and the catalog's indexes of the footprint's tables"
		},
		show: Formatter.format,
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})

/**
 * Refuses a drawn ChangeSet at compile or encode before any session as its model says, and explains every other,
 * executing nothing: the notes table as each case found it, each case on the worker's seat of Work with its facts loaded.
 *
 * Its pre-conversion budget: runs 20, coverage cases 20 (test/pg/reads/explain.test.ts at d1a6ae9ac), whose one check of
 * the notes table after every case is each case's own.
 */
export const refusesADrawnChangeSetAtCompileOrEncodeBeforeAnySessionAsItsModelSaysAndExplainsEveryOther =
	property.explore(refusalCaseGen, {
		needs: { seated: Substrate.seat(workSeatTemplate) },
		situations: ["compile", "encode", "explained"] satisfies ReadonlyArray<Reached<RefusalFeature>>,
		check:
			({ seated }, notes: Case<RefusalFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(seated, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(W.Work, workFacts, workSeatInstall, taken)
								const { ctx, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								/** The notes member, each call's facts; a ChangeSet over Elsewhere is refused where its workload is built. */
								const loaded = yield* loadWithTables({
									notes: ChangeSet.empty(o.schema).insert(W.TaskNote, [])
								})
								const notesMember = member(loaded.members, "notes")
								/** The explain over a pool that counts its leases: every refusal is found on the host. */
								const leases = { count: 0 }
								const counting = {
									...ctx,
									pool: {
										...ctx.pool,
										lease: Effect.suspend(() => {
											leases.count++
											return ctx.pool.lease
										})
									}
								}
								const notesExplains = memberExplains(counting, loaded.tables, notesMember)
								if (notesExplains.kind !== "change") {
									return assert.fail("a ChangeSet of array members explains with its call's facts")
								}
								const tasks = [t2, t4, tMissing] as const
								yield* notesUnchanged(
									o.installed,
									Effect.gen(function* () {
										const facts = Arr.map(c.notes, (n) => ({
											task: defined(tasks[n.task]),
											note: `note ${n.text}`
										}))
										const leased = leases.count
										const expected = refusalOf(c)
										if (expected === "compile") {
											throwsRefused(
												() =>
													workload(o.server.roles.app.role, {
														foreign: ChangeSet.empty(Elsewhere).insert(
															Elsewhere.relations.TaskNote,
															[]
														)
													}),
												"MalformedDescription",
												"a ChangeSet over Elsewhere, no level of the role's schema"
											)
											assert.equal(leases.count, leased, "no session leased")
											notes.note(expected)
											return
										}
										const explained = yield* Effect.result(
											notesExplains.explain({
												params: {},
												facts: { insert: { TaskNote: facts } }
											})
										)
										switch (expected) {
											case "explained": {
												assertVariant(explained, "_tag", "Success", "a ChangeSet the host admits")
												for (const plan of explained.success) {
													estimateOnly(plan.plan)
												}
												break
											}
											case "encode": {
												assertVariant(explained, "_tag", "Failure", "a ChangeSet the host refuses")
												const refusal = explained.failure
												assert.ok(refusal instanceof ReadFailure)
												assert.equal(refusal.stage, expected)
												assertVariant(
													refusal.reason,
													"_tag",
													"InputRejected",
													"host normalization's same-key refusal"
												)
												const witness = refusal.reason.witness
												assertVariant(witness, "kind", "key", "the key the call states twice")
												assert.equal(witness.relation, "TaskNote")
												assert.ok(
													Arr.some(c.notes, (a) =>
														Arr.some(
															c.notes,
															(b) =>
																a.task === b.task &&
																a.text !== b.text &&
																witness.values["task"] === tasks[a.task]
														)
													),
													`the witness ${Formatter.format(witness)} names a task stated with two notes`
												)
												assert.equal(leases.count, leased, "no session leased")
												break
											}
										}
										notes.note(expected)
									})
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "host normalization's same-key refusal and the write scope's, both before any session"
		},
		show: Formatter.format,
		budget: { runs: 20, steered: 20 },
		kept: [],
		kills: []
	})

/**
 * Explains a served ChangeSet under its session's message bound, as its application cuts it, each case on the worker's
 * seat of the Boxes fixture, its box emptied after it.
 *
 * Its pre-conversion budget: runs 12, coverage cases 12 (test/pg/reads/explain.test.ts at d1a6ae9ac).
 */
export const explainsAServedChangeSetUnderItsSessionsMessageBoundAsItsApplicationCutsIt =
	property.explore(boundCases, {
		needs: { boxes: Substrate.seat(explainBoxesTemplate) },
		situations: [
			"a body past the bound",
			"bodies within the bound together",
			"bodies within the bound, together past it"
		] satisfies ReadonlyArray<Reached<BoundFeature>>,
		check:
			({ boxes: seat }, notes: Case<BoundFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(seat, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Boxes, {}, explainBoxesInstall, taken)
								const { ctx: served, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const loaded = yield* loadWithTables({
									boxes: ChangeSet.empty(o.schema).insert(Box, [])
								})
								const boxes = member(loaded.members, "boxes")
								if (boxes.kind !== "change") {
									return assert.fail("a ChangeSet loads as a change member")
								}
								const limit = explainedTextBound(variantOf(served, boxes.variants).entry.program)
								const bound = { ...served, pool: boundPool(served.pool, limit) }
								const handle = onceCalls(bound, boxes)
								if (handle.shape !== "write") {
									return assert.fail("a ChangeSet with array members loads as a write handle")
								}
								const explains = memberExplains(bound, loaded.tables, boxes)
								if (explains.kind !== "change") {
									return assert.fail(
										"a ChangeSet with array members explains with its call's facts"
									)
								}
								const lengths = Arr.map(c.shares, (share) =>
									Math.floor((limit * share) / boundWhole)
								)
								notes.note(boundFeatureOf(c.shares))
								const facts = {
									insert: {
										Box: [
											{
												id: uuidOf(1),
												parts: Arr.map(lengths, (n) => ({ body: new Uint8Array(n) }))
											}
										]
									}
								}
								const explained = yield* Effect.result(explains.explain({ params: {}, facts }))
								const applied = yield* Effect.result(answered(handle.once({ params: {}, facts })))
								assert.equal(
									EffectResult.isSuccess(explained),
									EffectResult.isSuccess(applied),
									`explain under a session bound of ${limit} bytes of bodies ${Formatter.format(lengths)} plans exactly where the application writes: ${Formatter.format(explained)} beside ${Formatter.format(applied)}`
								)
								if (EffectResult.isSuccess(explained)) {
									for (const plan of explained.success) {
										estimateOnly(plan.plan)
									}
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the application of the same call on the same session, which cuts under its bound"
		},
		show: Formatter.format,
		budget: { runs: 12, steered: 12 },
		kept: [],
		kills: []
	})
