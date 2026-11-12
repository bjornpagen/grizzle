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
 * - a ChangeSet drawn over the Shop fixture (one or two strata of generated additions, inserts, puts and deletes,
 *   with or without read-backs of delta.added and delta.removed, one joining Item's added facts with Stock), a
 *   change member whose first stratum's rows are the call's facts and whose second's are query members over the call's
 *   relation parameters, is explained one plan per plannable statement its apply sends, under its name, over its text,
 *   in a transaction that is rolled back: no fact written, no identity sequence advanced, which EXPLAIN ANALYZE would
 *   have done; a read-back rides the statement that makes its delta, so no plan reads a carrier;
 * - a served ChangeSet inserting a box with its parts nested, each part's body a drawn share of the session's message
 *   bound, within it or past it, on a session whose bound is planted at the longest Parse message of the texts explain
 *   sends of the write, each planned one as its EXPLAIN (test/support/staged.ts explainedTextBound), as a server whose
 *   bound is below the protocol's holds it: explain plans it exactly where the application of the same call on the
 *   same session writes it, each cutting its executions under the session's bound (apply/run.ts sessionTransport);
 * - every Plan holds exactly its public fields, its estimates finite, and an ExecutedPlan its actuals beside them;
 * - drawn notes over Work, or a ChangeSet over a schema no role of the Db holds, are refused as a model of the host's
 *   refusals says: a ChangeSet over no level of the role's schema where its workload is built, MalformedDescription, a
 *   same-key pair host normalization refuses ReadError{encode}, each found before a session is leased, and any other
 *   is explained, executing nothing. No number of facts is refused: a statement's Bind message past
 *   PostgreSQL's message limit is the one resource refusal, a unit test's (test/unit/adapter/bind.test.ts), since a
 *   gibibyte of parameters is no case to send.
 *
 * Plants: ~/.cache/grizzle-release/BR08/plants/explain-first-plan-dropped.patch, explain's plans without the first,
 * must turn the reads' and the ChangeSets' properties red;
 * ~/.cache/grizzle-release/BR08/plants/explain-change-leases-first.patch, a ChangeSet's explain leasing a session
 * before its host checks, the refusals'; ~/.cache/grizzle-release/BR08/plants/explain-uncut-by-session-bound.patch,
 * explain's executions cut by no session bound, the session bound's;
 * ~/.cache/grizzle-release/EXPLAIN/plants/index-wrong-relation.patch, an index node naming another relation than the one
 * whose table holds the index, the reads' and the ChangeSets'; ~/.cache/grizzle-release/EXPLAIN/plants/unprepared-statement.patch,
 * each plan reported under its unnamed EXPLAIN's own name rather than the served statement's, the reads' and the
 * ChangeSets'; ~/.cache/grizzle-release/EXPLAIN/plants/change-analyzed.patch, a ChangeSet's statements run under EXPLAIN
 * ANALYZE, the ChangeSets' (its serial field's sequence advanced). ~/.cache/grizzle-release/EXPLAIN/plants/rollback-dropped.patch,
 * explain's transactions committed, leaves the database's state as a ROLLBACK does, since an estimate-only explain runs
 * nothing but a carrier's CREATE TEMPORARY TABLE ... ON COMMIT DROP and its ANALYZE and an analyzed read runs READ ONLY,
 * so no state here witnesses it: test/pg/adapter/round-trips.test.ts, which reads each explain's transaction off the
 * wire, kills it.
 */
import { layer } from "@effect/vitest"
import { assertInstanceOf } from "@effect/vitest/utils"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, shuffled } from "@grizzle/testing/gen"
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
import { type MemberExplains, onceCalls, memberExplains, variantOf } from "#adapter/db/handles.ts"
import { ReadFailure } from "#adapter/errors/execution.ts"
import type { ExecutedPlan, Plan, PlanTarget, StatementPlan } from "#adapter/types/db.ts"
import type { Prologue } from "#adapter/wire/batch.ts"
import type { Session, SessionPool } from "#adapter/wire/session.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn as drawnField, natural, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { queryUses } from "#compiler/schema/walk.ts"
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
import { answered, readOnce } from "#test/support/calls.ts"
import { exactValue, valueHash } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, a2, t2, t4, tMissing, workFacts } from "#test/support/fixtures/golden/work.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { explainedTextBound } from "#test/support/staged.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"
import { makeTap, type Tap, type WireWindow } from "#test/support/wire-tap.ts"

import { regex } from "arkregex"
/**
 * A schema no Db of the suite opens, holding Work's TaskNote: a ChangeSet over it is over no level of any role here.
 */
const Elsewhere = schema("Elsewhere", [W.TaskNote], [])

/** Every node of a plan tree, depth first. */
const nodes = <N extends { readonly children: ReadonlyArray<N> }>(plan: N): ReadonlyArray<N> => [
	plan,
	...Arr.flatMap(plan.children, (child) => nodes(child))
]

/** The members a node's target holds by its kind, so a target holds exactly its kind's. */
const targetKeys: { readonly [K in PlanTarget["kind"]]: ReadonlyArray<string> } = {
	none: ["kind"],
	relation: ["kind", "relation"],
	index: ["index", "kind", "relation"],
	carrier: ["kind"]
}

/** A Plan node carries exactly its public fields, each estimate a finite number, and a target of its kind's members. */
const planShape = (plan: Plan, keys: ReadonlyArray<string>, extra: ReadonlyArray<string>): void => {
	const target: Readonly<Record<string, unknown>> = plan.on
	const targetHeld: ReadonlyArray<string> = Rec.keys(target)
	unorderedEqual(keys, [
		"children",
		"node",
		"on",
		"rows",
		"startupCost",
		"totalCost",
		"width",
		...extra
	])
	assert.equal(typeof plan.node, "string")
	unorderedEqual(targetHeld, targetKeys[plan.on.kind])
	assert.deepEqual(
		Arr.filter(
			[plan.startupCost, plan.totalCost, plan.rows, plan.width],
			(n) => !Number.isFinite(n)
		),
		[]
	)
}

/** An estimate-only Plan: every node of exactly a Plan's fields (planShape). */
const estimateOnly = (plan: Plan): void => {
	for (const node of nodes(plan)) {
		planShape(node, Rec.keys(node), [])
	}
}

/** An executed plan: every node a Plan's fields and its actuals and buffers, each a finite number. */
const executedShape = (plan: ExecutedPlan): void => {
	for (const node of nodes(plan)) {
		planShape({ ...node, children: [] }, Rec.keys(node), ["actual", "buffers"])
		assert.deepEqual(
			Arr.filter(
				[
					node.actual.startupMs,
					node.actual.totalMs,
					node.actual.rows,
					node.actual.loops,
					node.buffers.sharedHit,
					node.buffers.sharedRead
				],
				(n) => !Number.isFinite(n)
			),
			[]
		)
	}
}

/** A catalog index's place: its table's schema and name, and its own name. */
const indexKey = (schema: string, table: string, index: string): string =>
	`${schema}\u0000${table}\u0000${index}`

/** Every index the database holds, by indexKey: the catalog, read apart from the served file. */
const catalogIndexes = Effect.gen(function* () {
	const s = yield* Substrate
	const rows = yield* s.admin.queryValues(
		`SELECT n.nspname, t.relname, i.relname
		   FROM pg_catalog.pg_index x
		   JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
		   JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
		   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace`,
		[]
	)
	return new Set(Arr.map(rows, (row) => indexKey(String(row[0]), String(row[1]), String(row[2]))))
})

/**
 * Every node of `plan` reads within `footprint`, the relations the member's program names, and each index node an index
 * the catalog holds on its relation's table, the table the installation's names give that relation.
 */
const readsWithin = (
	plan: Plan,
	footprint: ReadonlySet<string>,
	tableOf: (relation: string) => { readonly schema: string; readonly name: string },
	indexes: ReadonlySet<string>
): void => {
	for (const node of nodes(plan)) {
		const on = node.on
		if (on.kind === "relation" || on.kind === "index") {
			assert.ok(footprint.has(on.relation), `${on.relation}, a relation of the footprint`)
		}
		if (on.kind === "index") {
			const table = tableOf(on.relation)
			assert.ok(
				indexes.has(indexKey(table.schema, table.name, on.index.name)),
				`the index ${on.index.name} on ${on.relation}'s table ${table.schema}.${table.name}`
			)
		}
	}
}

/** The relations a read program names: its query's, through each of its attachments (schema/walk.ts queryUses). */
const footprintOf = (program: unknown): ReadonlySet<string> => {
	const input = queryInput(program)
	return input.ok ? queryUses(input.value.desc).relations : assert.fail("a read member's query")
}

/** A read member's explains: a read's two (types/db ReadExplain). */
const readExplains = (explains: MemberExplains) =>
	explains.kind === "read" ? explains : assert.fail("a read member explains as a read")

/**
 * Each plan is of the statement the call sent at its place, under that statement's name, and explain sent an EXPLAIN of
 * exactly that statement's served text.
 */
const ofTheServed = (
	plans: ReadonlyArray<Pick<StatementPlan, "statement">>,
	sent: ReadonlyArray<Executed>,
	explained: ReadonlyArray<Executed>,
	planning: (text: string) => string
): void => {
	assert.deepEqual(
		Arr.map(plans, (p) => p.statement),
		Arr.map(sent, (e) => e.name),
		"one plan per statement, under its served name"
	)
	assert.deepEqual(
		Arr.map(explained, (e) => e.text),
		Arr.map(sent, (e) => planning(e.text)),
		"an EXPLAIN of each served statement's text"
	)
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

/** The EXPLAIN of a served statement's text, as explain sends it: estimates alone, in JSON, naming each relation's schema. */
const estimating = (text: string): string => `EXPLAIN (FORMAT JSON, VERBOSE) ${text}`

/** The EXPLAIN ANALYZE of a served statement's text, as explainAnalyze sends it. */
const analyzing = (text: string): string => `EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) ${text}`

/** A statement a window executed: the name it was bound by, and its text. */
interface Executed {
	readonly name: string
	readonly text: string
}

/**
 * The statements with a plan a window sent, in order: every Execute but a utility statement's and the prologue's two,
 * which fence and enter the Db's role and are no statements of the call's, each Execute naming its statement by its
 * Bind, whose text is the Parse of that name the session last sent, in this window or an earlier one.
 */
const plannedStatements = (
	tap: Tap,
	window: WireWindow,
	prologue: Prologue
): ReadonlyArray<Executed> => {
	const parsed = new Map<string, string>()
	for (const message of tap.since(0).frontend) {
		if (message.type === "P") {
			parsed.set(message.name, message.text)
		}
	}
	let bound = ""
	const out: Array<Executed> = []
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
			text !== prologue.fence.text.sql &&
			text !== prologue.enter.text.sql &&
			!regex("^\\s*CREATE\\b", "i").test(text) &&
			!regex("^\\s*ANALYZE\\b", "i").test(text)
		) {
			out.push({ name: bound, text })
		}
	}
	return out
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

/** Where a stratum's operation goes: a seat, whose number its relation draws, or an operation of a kind at a key. */
type OpSlot =
	| { readonly kind: "seat" }
	| { readonly kind: "item" | "put stock" | "delete stock"; readonly id: number }

/**
 * Every slot of a stratum: up to three seats, and each keyed kind at each id 1 to 3, so a stratum drawn as distinct
 * slots holds one fact per key of each kind by construction (a same-key pair is the refusal property's below).
 */
const opSlots: ReadonlyArray<OpSlot> = [
	...upTo(3, (): OpSlot => ({ kind: "seat" })),
	...Arr.flatMap(["item", "put stock", "delete stock"] as const, (kind) =>
		Arr.map([1, 2, 3], (id): OpSlot => ({ kind, id }))
	)
]

/** The operation at a slot, its payload drawn. */
const opAt =
	(slot: OpSlot): Gen<ShopOp> =>
	(source) => {
		switch (slot.kind) {
			case "seat":
				return { kind: "seat", label: source.draw(label) }
			case "item":
				return { kind: "item", id: slot.id, qty: source.draw(int(0, 9)) }
			case "put stock":
				return {
					kind: "put stock",
					id: slot.id,
					label: source.draw(label),
					qty: source.draw(int(0, 9))
				}
			case "delete stock":
				return { kind: "delete stock", id: slot.id }
		}
	}

/** One stratum: one to three operations at distinct slots. */
const stratumGen: Gen<ReadonlyArray<ShopOp>> = (source) =>
	Arr.map(source.draw(shuffled(opSlots, { min: 1, max: 3 })), (slot) => source.draw(opAt(slot)))

/**
 * A drawn ChangeSet: one or two strata of operations, and what it reads back: nothing, both sides of Seat's delta, or
 * Item's added facts joined with Stock. Every stratum writes Seat, Item and Stock, so a delta of one is made by one
 * statement only where there is one stratum, and a ChangeSet of two reads nothing back (write/schedule/plan.ts
 * placeReadBacks refuses a delta two statements make).
 */
interface ChangeCase {
	readonly strata: ReadonlyArray<ReadonlyArray<ShopOp>>
	readonly readBack: "none" | "seats" | "items joined"
}

const changeCaseGen: Gen<ChangeCase> = (source) => {
	const strata = source.draw(array(stratumGen, { min: 1, max: 2 }))
	return {
		strata,
		readBack:
			strata.length === 1
				? source.draw(element(["none", "seats", "items joined"] as const))
				: "none"
	}
}

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
const Boxes = schema("Boxes", [Box, Part], [ordered(on(Part, "box", "at"), fin(Box, "parts"))])

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

layer(Substrate.layer)("workload explain", (it) => {
	it.effect(
		"explains and analyzes a drawn read: its execute's statements, by name and text, read within its footprint",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const o = yield* installed(W.Work, workFacts, {
						label: "real",
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
					const indexes = yield* catalogIndexes
					const tableOf = (relation: string) => o.installed.installation.names.relation(relation)
					return yield* withServedDb(
						o.installed,
						o.server.roles.app,
						{},
						({ ctx, loadWithTables }) =>
							Effect.gen(function* () {
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								const programs = {
									plainRead: W.automaticBudget,
									union: W.taskPayloads,
									fused: W.taskCards,
									nested: accountTasks,
									relationParameter: W.tasksById
								}
								const { members, tables } = yield* loadWithTables(programs)
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
										oracle: {
											kind: "second-implementation",
											name: "the execution of the same call on a tapped session: one plan per plannable statement it sent, under its name, over its text; and the catalog's indexes of the footprint's tables"
										},
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
											const explains = readExplains(memberExplains(context, tables, program))
											const plans = yield* observe(tap, explains.explain({ params, facts: {} }))
											const analyzed = yield* observe(
												tap,
												explains.explainAnalyze({ params, facts: {} })
											)
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
											const footprint = footprintOf(programs[read.member])
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
										})
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"explains a drawn ChangeSet: its apply's plannable statements, by name and text, within its footprint, executing nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const o = yield* installed(Shop, {}, { label: "real", programs: {} })
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
					const indexes = yield* catalogIndexes
					const tableOf = (relation: string) => o.installed.installation.names.relation(relation)
					/** The relations every drawn ChangeSet writes and reads back. */
					const footprint: ReadonlySet<string> = new Set(["Seat", "Item", "Stock"])
					return yield* withServedDb(
						o.installed,
						o.server.roles.app,
						{},
						({ ctx, loadWithTables }) =>
							Effect.gen(function* () {
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								return yield* explore(
									{
										oracle: {
											kind: "second-implementation",
											name: "the application of the same call on a tapped session: one plan per plannable statement it sent, under its name, over its text, and the state before it unchanged by the explain; and the catalog's indexes of the footprint's tables"
										},
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
											/** A stratum's operations, each kind's facts together. */
											const strata = Arr.map(c.strata, (ops) => {
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
													: c.readBack === "items joined"
														? sequenced.read("items", (d) =>
																query(o.schema).rule((r) => {
																	const { id, label, qty } = v(Stock, "stock")
																	return r
																		.match(d.added(Item), { id })
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
												assert.deepEqual(
													Arr.filter(
														Arr.flatMap(plans.value, (p) => nodes(p.plan)),
														(n) => n.on.kind === "carrier"
													),
													[],
													"a read-back rides the statement that makes its delta and creates no carrier"
												)
												notes.note("a read-back")
											}
											if (c.readBack === "items joined") {
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
						programs: {}
					})
					const before = yield* tableState(o.installed, W.TaskNote)
					const explored = yield* withServedDb(
						o.installed,
						o.server.roles.app,
						{},
						({ ctx, loadWithTables }) =>
							Effect.gen(function* () {
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
					const o = yield* installed(Boxes, {}, { label: "boxes", programs: {} })
					return yield* withServedDb(
						o.installed,
						o.server.roles.app,
						{},
						({ ctx: served, loadWithTables }) =>
							Effect.gen(function* () {
								const loaded = yield* loadWithTables({
									boxes: ChangeSet.empty(o.schema).insert(Box, [])
								})
								const boxes = member(loaded.members, "boxes")
								if (boxes.kind !== "change") {
									return assert.fail("a ChangeSet loads as a change member")
								}
								const limit = explainedTextBound(
									variantOf(served, boxes.variants).entry.program.flight
								)
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
												explains.explain({ params: {}, facts })
											)
											const applied = yield* Effect.result(
												answered(handle.once({ params: {}, facts }))
											)
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
										})
								)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
