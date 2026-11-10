import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { set } from "@grizzle/testing/oracle"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result as EffectResult
} from "effect"
import { memberOps, variantOf } from "#adapter/db/handles.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import { explainMember } from "#adapter/served/explain.ts"
import type { Plan } from "#adapter/types/db.ts"
import type { Prologue } from "#adapter/wire/batch.ts"
import type { Session, SessionPool } from "#adapter/wire/session.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { Item, Seat, Shop, Stock, uuidOf } from "#test/pg/reads/shop.ts"
import { installed } from "#test/pg/reads/support.ts"
import {
	assert,
	assertVariant,
	defined,
	nonEmpty,
	throwsRefused,
	unorderedEqual
} from "#test/support/assert.ts"
import { exactValue, valueHash } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, a2, t2, t4, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { explainedTextBound } from "#test/support/staged.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap, type WireWindow } from "#test/support/wire-tap.ts"

import { regex } from "arkregex"
/**
 * A schema no Db of the suite opens, holding Work's TaskNote: a ChangeSet over it is over no level of any role here.
 */
const Elsewhere = schema("Elsewhere", { TaskNote: W.TaskNote }, [])

/** Every node of a plan tree, depth first. */
const nodes = (plan: Plan): ReadonlyArray<Plan> => [plan, ...Arr.flatMap(plan.children, nodes)]

/** A Plan carries exactly its public fields, recursively, each estimate a finite number. */
const estimateOnly = (plan: Plan): void => {
	unorderedEqual(Rec.keys(plan), ["children", "node", "rows", "startupCost", "totalCost", "width"])
	assert.equal(typeof plan.node, "string")
	assert.deepEqual(
		Arr.filter(
			[plan.startupCost, plan.totalCost, plan.rows, plan.width],
			(n) => !Number.isFinite(n)
		),
		[]
	)
	for (const child of plan.children) {
		estimateOnly(child)
	}
}

/** A tapped pool of one session for `credentials`, warmed so a window holds one call's traffic. */
const tappedPool = (credentials: Credentials) =>
	Effect.gen(function* () {
		const { cluster } = yield* Substrate
		const tap = makeTap(cluster)
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

/**
 * The statements with a plan a window sent: every Execute but a utility statement's and the prologue's two, which fence
 * and enter the Db's role and are no statements of the call's, each Execute naming its statement by its Bind, whose
 * text is the Parse of that name the session last sent, in this window or an earlier one.
 */
const plannedStatements = (tap: Tap, window: WireWindow, prologue: Prologue): number => {
	const parsed = new Map<string, string>()
	for (const message of tap.since(0).frontend) {
		if (message.type === "P") {
			parsed.set(message.name, message.text)
		}
	}
	let bound = ""
	let count = 0
	for (const message of window.frontend) {
		if (message.type === "P") {
			parsed.set(message.name, message.text)
		}
		if (message.type === "B") {
			bound = message.name
		}
		if (message.type !== "E") {
			continue
		}
		const text = defined(parsed.get(bound), "a parsed statement")
		if (
			text !== prologue.fence.sql &&
			text !== prologue.enter.sql &&
			!regex("^\\s*CREATE\\b", "i").test(text) &&
			!regex("^\\s*ANALYZE\\b", "i").test(text)
		) {
			count++
		}
	}
	return count
}

/** The traffic of `effect`, and its value. */
const observe = <A, E, R>(tap: Tap, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const mark = tap.mark()
		const value = yield* effect
		return { value, window: tap.since(mark) }
	})

type QueryFeature =
	| "a plain read"
	| "a union"
	| "fused attachments"
	| "nested attachments"
	| "a relation parameter"

const queryFeatures: Arr.NonEmptyReadonlyArray<QueryFeature> = [
	"a plain read",
	"a union",
	"fused attachments",
	"nested attachments",
	"a relation parameter"
]

interface QueryCase {
	readonly read: QueryFeature
	readonly pick: number
}

const queryCaseGen: Gen<QueryCase> = (source) => ({
	read: source.draw(element(queryFeatures)),
	pick: source.draw(int(0, 7))
})

type ChangeFeature =
	| "a generated addition"
	| "an insert"
	| "a put"
	| "a delete"
	| "two strata"
	| "a read-back"
	| "a read-back joining a stored relation"
	| "a refused apply"

/** One ChangeSet stratum's operations over Shop, drawn. */
type ShopOp =
	| { readonly kind: "seat"; readonly label: number }
	| { readonly kind: "item"; readonly id: number; readonly qty: number }
	| {
			readonly kind: "put stock"
			readonly id: number
			readonly label: number
			readonly qty: number
	  }
	| { readonly kind: "delete stock"; readonly id: number }

const labels = ["old", "new", "aisle", "bin"] as const

const label = int(0, labels.length - 1)
const shopId = int(1, 3)

const shopOpGen: Gen<ShopOp> = oneOf<ShopOp>([
	map(label, (n) => ({ kind: "seat", label: n })),
	(source) => ({ kind: "item", id: source.draw(shopId), qty: source.draw(int(0, 9)) }),
	(source) => ({
		kind: "put stock",
		id: source.draw(shopId),
		label: source.draw(label),
		qty: source.draw(int(0, 9))
	}),
	map(shopId, (id) => ({ kind: "delete stock", id }))
])

/** A drawn ChangeSet: one or two strata of operations, and what it reads back. */
interface ChangeCase {
	readonly strata: ReadonlyArray<ReadonlyArray<ShopOp>>
	readonly readBack: "none" | "seats and stock" | "stock joined"
}

const changeCaseGen: Gen<ChangeCase> = (source) => ({
	strata: source.draw(array(array(shopOpGen, { min: 1, max: 3 }), { min: 1, max: 2 })),
	readBack: source.draw(element(["none", "seats and stock", "stock joined"] as const))
})

/**
 * A drawn ChangeSet of note inserts, up to four over three tasks and three texts, over Work or over a schema no role of
 * the Db holds.
 */
interface RefusalCase {
	readonly foreign: boolean
	readonly notes: ReadonlyArray<{ readonly task: number; readonly text: number }>
}

const refusalCaseGen: Gen<RefusalCase> = (source) => ({
	foreign: source.draw(boolean),
	notes: source.draw(
		array((note) => ({ task: note.draw(int(0, 2)), text: note.draw(int(0, 2)) }), {
			min: 1,
			max: 4
		})
	)
})

type RefusalFeature = "compile" | "encode" | "explained"

/**
 * What explain makes of a refusal case: a ChangeSet over no level of the Db's role does not compile; one whose notes
 * share a task with different texts is a same-key pair host normalization refuses; any other is explained.
 */
const refusalOf = (c: RefusalCase): RefusalFeature =>
	c.foreign
		? "compile"
		: Arr.some(c.notes, (a) => Arr.some(c.notes, (b) => a.task === b.task && a.text !== b.text))
			? "encode"
			: "explained"

/** A box, the owner of an ordered family of parts whose bodies are bytes, as pantry's import nests its entries. */
const Box = relation("Box", { id: uuid, parts: drawnField(natural) }, ["id"])
const Part = relation("Part", { box: uuid, at: drawnField(natural), body: bytes }, ["box", "at"])
const Boxes = schema("Boxes", { Box, Part }, [ordered(on(Part, "box", "at"), fin(Box, "parts"))])

/** A pool whose sessions hold the message bound `limit`, as a server whose bound is below the protocol's does. */
const boundPool = (pool: SessionPool, limit: number): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({ ...session, messageMaxBytes: limit }))
})

/** A part body's length as a share of the session's bound, in thousandths of `boundWhole`. */
const boundWhole = 1_000

type BoundFeature = "a body past the bound" | "bodies within the bound"

/** A box's parts, each body's length a share of the session's bound: within it, or past it by up to the bound again. */
interface BoundCase {
	readonly shares: Arr.NonEmptyReadonlyArray<number>
}

const boundCaseGen: Gen<BoundCase> = (source) => ({
	shares: nonEmpty(
		source.draw(array(int(1, 2 * boundWhole), { min: 1, max: 4 })),
		"a box holds a part"
	)
})

/** Each search's budget beside its suite, draw and features. */
const budget = {
	literal: Formatter.format,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/**
 * Explain on PostgreSQL 19: one estimate-only Plan per statement the call it explains would emit, nothing executed,
 * and each refusal at its stage before any session is leased. Every program is a workload member of the login's served
 * file, explained as explainMember explains it (adapter/served/explain.ts) with the call it would run. It lives under
 * test/pg/reads beside the read suite.
 *
 * The oracle of "one plan per statement" is the call itself: each case runs on a Db whose pool of one session is
 * tapped (test/support/wire-tap.ts), explains the program, then runs it, and the plans must number exactly the
 * statements that run sent which have a plan, every Execute on the wire but a carrier's CREATE TEMPORARY TABLE and its
 * ANALYZE (utility statements PostgreSQL never plans). As properties:
 *
 * - a read drawn over the worked example's Work (a plain read, a heterogeneous union, fused attachments, nested
 *   pipelined attachments, a relation parameter of drawn ids), each a served member, is explained one plan per
 *   statement its execute sends;
 * - a ChangeSet drawn over the Shop fixture (one or two strata of generated additions, inserts, puts and deletes,
 *   with or without read-backs of delta.added and delta.removed, one joining a delta carrier with a stored relation), a
 *   change member whose first stratum's rows are the call's facts and whose second's are query members over the call's
 *   relation parameters, is explained one plan per plannable statement its apply sends, in a transaction that is
 *   rolled back: no fact written, no identity sequence advanced, which EXPLAIN ANALYZE would have done; a read-back
 *   joining a delta carrier plans the empty, analyzed carrier at one row, as the apply does;
 * - a served ChangeSet inserting a box with its parts nested, each part's body a drawn share of the session's message
 *   bound, within it or past it, on a session whose bound is planted at the longest Parse message of the texts explain
 *   sends of the write, each planned one as its EXPLAIN (test/support/staged.ts explainedTextBound), as a server whose
 *   bound is below the protocol's holds it: explain plans it exactly where the application of the same call on the
 *   same session writes it, each cutting its executions under the session's bound (apply/run.ts sessionTransport);
 * - every Plan is estimate-only: node type, costs, rows and width, nothing else;
 * - drawn notes over Work, or a ChangeSet over a schema no role of the Db holds, are refused as a model of the host's
 *   refusals says: a ChangeSet over no level of the role's schema where its workload is built, MalformedDescription, a
 *   same-key pair host normalization refuses ReadError{encode}, each found before a session is leased, and any other
 *   is explained, executing nothing. No number of facts is refused: a statement's Bind message past
 *   PostgreSQL's message limit is the one resource refusal, a unit test's (test/unit/adapter/bind.test.ts), since a
 *   gibibyte of parameters is no case to send.
 */
export const explainSuite = (): void => {
	layer(Substrate.layer)("db.explain", (it) => {
		it.effect(
			"explains a drawn read one estimate-only plan per statement its execute sends",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {}
						})
						const accountTasks = query(W.Work)
							.rule((r) => {
								const { id, name } = v(W.Account, "account")
								return r
									.match(W.Account, { id, name })
									.where(r.eq(id, r.param("account", uuid)))
									.find({ id, name })
							})
							.attach(
								"tasks",
								(a) =>
									query(W.Work)
										.rule((r) => {
											const { id, kind } = v(W.Task, "task")
											return r.match(W.Task, { id, account: a.id, kind }).find({ id, kind })
										})
										.attach(
											"note",
											(t) =>
												query(W.Work).rule((r) => {
													const { note } = v(W.TaskNote, "taskNote")
													return r.match(W.TaskNote, { task: t.id, note }).find({ note })
												}),
											"option"
										),
								"array"
							)
						return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
							Effect.gen(function* () {
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								const members = yield* load({
									plainRead: W.automaticBudget,
									union: W.taskPayloads,
									fused: W.taskCards,
									nested: accountTasks,
									relationParameter: W.tasksById
								})
								const reads = {
									"a plain read": { member: "plainRead", params: () => ({}) },
									"a union": { member: "union", params: () => ({}) },
									"fused attachments": {
										member: "fused",
										params: (pick: number) => ({ account: pick % 2 === 0 ? a1 : a2 })
									},
									"nested attachments": {
										member: "nested",
										params: (pick: number) => ({ account: pick % 2 === 0 ? a1 : a2 })
									},
									"a relation parameter": {
										member: "relationParameter",
										params: (pick: number) => ({
											ids: Arr.map([t2, t4, tMissing].slice(0, pick % 4), (id) => ({ id }))
										})
									}
								} as const
								return yield* explore(
									{
										oracle: { kind: "unstated" },
										...budget,
										suite: "reads/explain queries",
										draw: drawn(queryCaseGen),
										kept: [],
										runs: 20,
										coverage: required<QueryFeature>(queryFeatures, { cases: 20, sense: notesOnly })
									},
									(c, notes) =>
										Effect.gen(function* () {
											const read = reads[c.read]
											const params = read.params(c.pick)
											const program = member(members, read.member)
											const plans = yield* explainMember(context, program, {
												kind: "params",
												params
											})
											const executed = yield* observe(
												tap,
												Effect.flatMap(
													memberOps(context, program).ops.execute(params),
													(result) => result.collect
												)
											)
											assert.equal(
												plans.length,
												plannedStatements(tap, executed.window, context.prologue),
												"one plan per statement"
											)
											for (const plan of plans) {
												estimateOnly(plan)
											}
											notes.note(c.read)
										})
								)
							})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"explains a drawn ChangeSet one estimate-only plan per plannable statement its apply sends, executing nothing",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const s = yield* Substrate
						const o = yield* installed(Shop, {}, { label: "real", extensions: [], programs: {} })
						const sequence = o.installed.installation.names.sequence("Seat", "no")
						const lastValue = () =>
							s.admin.queryValues(
								`SELECT last_value::text, is_called FROM "${sequence.schema}"."${sequence.name}"`,
								[]
							)
						const state = () =>
							Effect.all([
								tableState(o.installed, Seat),
								tableState(o.installed, Stock),
								tableState(o.installed, Item),
								lastValue()
							])
						/**
						 * A later stratum's members, each a query member over a relation parameter of the call, since a
						 * call's facts name one array member per op and relation: the first stratum's.
						 */
						const seatsFrom = query(o.schema).rule((r) => {
							const rows = r.relation("seats", { label: Seat.fields.label })
							const { label } = v(Seat, "seat")
							return r.match(rows, { label }).find({ label })
						})
						const itemsFrom = query(o.schema).rule((r) => {
							const rows = r.relation("items", {
								id: Item.fields.id,
								label: Item.fields.label,
								qty: Item.fields.qty
							})
							const { id, label, qty } = v(Item, "item")
							return r.match(rows, { id, label, qty }).find({ id, label, qty })
						})
						const stockFrom = (name: "puts" | "deletes") =>
							query(o.schema).rule((r) => {
								const rows = r.relation(name, {
									id: Stock.fields.id,
									label: Stock.fields.label,
									qty: Stock.fields.qty
								})
								const { id, label, qty } = v(Stock, "stock")
								return r.match(rows, { id, label, qty }).find({ id, label, qty })
							})
						return yield* withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
							Effect.gen(function* () {
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								return yield* explore(
									{
										oracle: { kind: "unstated" },
										...budget,
										/** Nothing executed: no fact written, the sequence not advanced. */
										suite: "reads/explain changesets",
										draw: drawn(changeCaseGen),
										kept: [],
										runs: 40,
										coverage: required<ChangeFeature>(
											[
												"a generated addition",
												"an insert",
												"a put",
												"a delete",
												"two strata",
												"a read-back",
												"a read-back joining a stored relation"
											],
											{ cases: 40, sense: notesOnly }
										)
									},
									(c, notes) =>
										Effect.gen(function* () {
											/**
											 * A stratum's operations, each kind's facts together: a stratum is a set of changes, one fact per
											 * key of each kind (a same-key pair is the refusal property's below).
											 */
											const strata = Arr.map(c.strata, (drawnOps) => {
												const ops = Arr.filter(
													drawnOps,
													(op, i) =>
														op.kind === "seat" ||
														Option.contains(
															Arr.findFirstIndex(
																drawnOps,
																(other) =>
																	other.kind === op.kind && "id" in other && other.id === op.id
															),
															i
														)
												)
												const seats = Arr.flatMap(ops, (op) =>
													op.kind === "seat" ? [{ label: defined(labels[op.label]) }] : []
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
													op.kind === "delete stock"
														? [{ id: uuidOf(op.id), label: "old", qty: 0n }]
														: []
												)
												if (seats.length > 0) {
													notes.note("a generated addition")
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
											const firstStratum = ChangeSet.empty(o.schema)
												.insert(Seat, [])
												.insert(Item, [])
												.put(Stock, [])
												.delete(Stock, [])
											const sequenced =
												second === undefined
													? firstStratum
													: ChangeSet.sequence(
															firstStratum,
															ChangeSet.empty(o.schema)
																.insert(Seat, seatsFrom)
																.insert(Item, itemsFrom)
																.put(Stock, stockFrom("puts"))
																.delete(Stock, stockFrom("deletes"))
														)
											if (second !== undefined) {
												notes.note("two strata")
											}
											const changes =
												c.readBack === "none"
													? sequenced
													: c.readBack === "stock joined"
														? sequenced.read("stock", (d) =>
																query(o.schema).rule((r) => {
																	const { id, label, qty } = v(Stock, "stock")
																	return r
																		.match(d.added(Stock), { id })
																		.match(Stock, { id, label, qty })
																		.find({ id, label, qty })
																})
															)
														: sequenced.read("seats", (d) =>
																query(o.schema)
																	.rule((r) => {
																		const { no, label } = v(Seat, "seat")
																		return r
																			.match(d.added(Seat), { no, label })
																			.find({ side: "added", no, label })
																	})
																	.rule((r) => {
																		const { no, label } = v(Seat, "seat")
																		return r
																			.match(d.removed(Seat), { no, label })
																			.find({ side: "removed", no, label })
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
											const loaded = yield* load({ changes })
											const change = member(loaded, "changes")
											const before = yield* state()
											const plans = yield* explainMember(context, change, {
												kind: "facts",
												facts,
												params
											})
											const after = yield* state()
											assert.deepEqual(
												exactValue(after, before),
												Option.none(),
												"explain executes nothing"
											)
											for (const plan of plans) {
												estimateOnly(plan)
											}
											const ops = memberOps(context, change)
											assertVariant(
												ops,
												"kind",
												"facts",
												"a ChangeSet of array members takes its call's facts"
											)
											const applied = yield* observe(
												tap,
												Effect.result(ops.ops.apply(facts, params))
											)
											assert.equal(
												plans.length,
												plannedStatements(tap, applied.window, context.prologue),
												"one plan per statement"
											)
											if (applied.value._tag === "Failure") {
												notes.note("a refused apply")
											}
											if (c.readBack !== "none") {
												notes.note("a read-back")
											}
											if (c.readBack === "stock joined") {
												/** The empty, analyzed carrier, planned at one row as the apply plans it. */
												const readBack = defined(plans.at(-1), "a read-back plan")
												nonEmpty(
													Arr.filter(nodes(readBack), (n) => n.node === "Seq Scan" && n.rows === 1),
													"the read-back plans its carrier at one row"
												)
												notes.note("a read-back joining a stored relation")
											}
										})
								)
							})
						)
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"refuses a drawn ChangeSet at compile or encode before any session as its model says, and explains every other, executing nothing",
			(test) =>
				searched(
					test,
					Effect.gen(function* () {
						const o = yield* installed(W.Work, workFacts, {
							label: "real",
							extensions: [],
							programs: {}
						})
						const before = yield* tableState(o.installed, W.TaskNote)
						const explored = yield* withServedDb(
							o.installed,
							o.server.roles.app,
							{},
							({ ctx, load }) =>
								Effect.gen(function* () {
									/** The notes member, each call's facts; a ChangeSet over Elsewhere is refused where its workload is built. */
									const loaded = yield* load({
										notes: ChangeSet.empty(o.schema).insert(W.TaskNote, [])
									})
									const notesMember = member(loaded, "notes")
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
									const tasks = [t2, t4, tMissing] as const
									return yield* explore(
										{
											...budget,
											suite: "reads/explain refusals",
											draw: drawn(refusalCaseGen),
											kept: [],
											runs: 20,
											coverage: required<RefusalFeature>(["compile", "encode", "explained"], {
												cases: 20,
												sense: notesOnly
											}),
											oracle: {
												kind: "specification",
												name: "host normalization's same-key refusal and the write scope's, both before any session"
											}
										},
										(c, notes) =>
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
													explainMember(counting, notesMember, {
														kind: "facts",
														facts: { insert: { TaskNote: facts } },
														params: {}
													})
												)
												switch (expected) {
													case "explained": {
														assertVariant(
															explained,
															"_tag",
															"Success",
															"a ChangeSet the host admits"
														)
														for (const plan of explained.success) {
															estimateOnly(plan)
														}
														break
													}
													case "encode": {
														assertVariant(
															explained,
															"_tag",
															"Failure",
															"a ChangeSet the host refuses"
														)
														const refusal = explained.failure
														assertInstanceOf(refusal, ReadFailure)
														assert.equal(refusal.stage, expected)
														assert.equal(refusal.reason._tag, "LawRejected")
														assert.equal(leases.count, leased, "no session leased")
														break
													}
												}
												notes.note(expected)
											})
									)
								})
						)
						const after = yield* tableState(o.installed, W.TaskNote)
						assert.deepEqual(set(valueHash, exactValue)(after, before), Option.none())
						return explored
					}).pipe(Effect.scoped)
				)
		)

		it.effect(
			"explains a served ChangeSet under its session's message bound, as its application cuts it",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const o = yield* installed(Boxes, {}, { label: "boxes", extensions: [], programs: {} })
						return yield* withServedDb(
							o.installed,
							o.server.roles.app,
							{},
							({ ctx: served, load }) =>
								Effect.gen(function* () {
									const members = yield* load({ boxes: ChangeSet.empty(o.schema).insert(Box, []) })
									const boxes = member(members, "boxes")
									if (boxes.kind !== "change") {
										return assert.fail("a ChangeSet loads as a change member")
									}
									const limit = explainedTextBound(
										variantOf(served, boxes.variants).entry.program.flight
									)
									const bound = { ...served, pool: boundPool(served.pool, limit) }
									const handle = memberOps(bound, boxes)
									if (handle.kind !== "facts") {
										return assert.fail("a ChangeSet with array members loads as a facts handle")
									}
									let next = 0
									return yield* explore(
										{
											oracle: {
												kind: "second-implementation",
												name: "the application of the same call on the same session, which cuts under its bound"
											},
											...budget,
											suite: "reads/explain session bound",
											draw: drawn(boundCaseGen),
											kept: [],
											runs: 12,
											coverage: required<BoundFeature>(
												["a body past the bound", "bodies within the bound"],
												{ cases: 12, sense: notesOnly }
											)
										},
										(c, notes) =>
											Effect.gen(function* () {
												next += 1
												const lengths = Arr.map(c.shares, (share) =>
													Math.floor((limit * share) / boundWhole)
												)
												notes.note(
													Arr.some(lengths, (n) => n > limit)
														? "a body past the bound"
														: "bodies within the bound"
												)
												const facts = {
													insert: {
														Box: [
															{
																id: uuidOf(next),
																parts: Arr.map(lengths, (n) => ({ body: new Uint8Array(n) }))
															}
														]
													}
												}
												const explained = yield* Effect.result(
													explainMember(bound, boxes, { kind: "facts", facts, params: {} })
												)
												const applied = yield* Effect.result(handle.ops.apply(facts, {}))
												assert.equal(
													EffectResult.isSuccess(explained),
													EffectResult.isSuccess(applied),
													`explain under a session bound of ${limit} bytes of bodies ${Formatter.format(lengths)} plans exactly where the application writes: ${Formatter.format(explained)} beside ${Formatter.format(applied)}`
												)
												if (EffectResult.isSuccess(explained)) {
													for (const plan of explained.success) {
														estimateOnly(plan)
													}
												}
											})
									)
								})
						)
					}).pipe(Effect.scoped)
				)
		)
	})
}
