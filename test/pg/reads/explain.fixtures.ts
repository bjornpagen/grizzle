import { aimed, array, boolean, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { set } from "@bjornpagen/testing/oracle"
import { regex } from "arkregex"
import { Array as Arr, Effect, Record as Rec, Option } from "effect"
import { type MemberExplains } from "#adapter/db/handles.ts"
import {
	type ExecutedPlan,
	type Plan,
	type PlanTarget,
	type StatementPlan
} from "#adapter/types/db.ts"
import { type Prologue } from "#adapter/wire/batch.ts"
import { type Session, type SessionPool } from "#adapter/wire/session.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { bytes, drawn as drawnField, natural } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { fin, on, ordered, relation, schema } from "#compiler/public/schema.ts"
import { queryUses } from "#compiler/schema/walk.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { Item, Seat, Shop, Stock } from "#test/pg/reads/shop.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { assert, defined, nonEmpty, unorderedEqual } from "#test/support/assert.ts"
import { exactValue, valueHash } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, a2, t2, t4, tMissing } from "#test/support/fixtures/golden/work.ts"
import { Id } from "#test/support/ids.ts"
import { type Installed } from "#test/support/install-migrate.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { type Credentials } from "#test/support/substrate/session.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap, type WireWindow } from "#test/support/wire-tap.ts"

/**
 * A schema no Db of the suite opens, holding Work's TaskNote: a ChangeSet over it is over no level of any role here.
 */
export const Elsewhere = schema("Elsewhere", [W.TaskNote], [])

/** Every node of a plan tree, depth first. */
export const nodes = <N extends { readonly children: ReadonlyArray<N> }>(
	plan: N
): ReadonlyArray<N> => [plan, ...Arr.flatMap(plan.children, (child) => nodes(child))]

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
export const estimateOnly = (plan: Plan): void => {
	for (const node of nodes(plan)) {
		planShape(node, Rec.keys(node), [])
	}
}

/** An executed plan: every node a Plan's fields and its actuals and buffers, each a finite number. */
export const executedShape = (plan: ExecutedPlan): void => {
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
export const catalogIndexes = Effect.gen(function* () {
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
export const readsWithin = (
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
export const footprintOf = (program: unknown): ReadonlySet<string> => {
	const input = queryInput(program)
	return input.ok ? queryUses(input.value.desc).relations : assert.fail("a read member's query")
}

/** A read member's explains: a read's two (types/db ReadExplain). */
export const readExplains = (explains: MemberExplains) =>
	explains.kind === "read" ? explains : assert.fail("a read member explains as a read")

/**
 * Each plan is of the statement the call sent at its place, under that statement's name, and explain sent an EXPLAIN of
 * exactly that statement's served text.
 */
export const ofTheServed = (
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
export const tappedPool = (credentials: Credentials) =>
	Effect.gen(function* () {
		const { cluster } = yield* Substrate
		const tap = makeTap(cluster)
		const pool = yield* poolFor(credentials, {
			...defaultPool,
			transport: { kind: "given", transport: tap.transport },
			pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
		})
		yield* Effect.scoped(
			Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
		)
		return { pool, tap }
	})

/** The EXPLAIN of a served statement's text, as explain sends it: estimates alone, in JSON, naming each relation's schema. */
export const estimating = (text: string): string => `EXPLAIN (FORMAT JSON, VERBOSE) ${text}`

/** The EXPLAIN ANALYZE of a served statement's text, as explainAnalyze sends it. */
export const analyzing = (text: string): string => `EXPLAIN (ANALYZE, FORMAT JSON, VERBOSE) ${text}`

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
export const plannedStatements = (
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
export const observe = <A, E, R>(tap: Tap, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const mark = tap.mark()
		const value = yield* effect
		return { value, window: tap.since(mark) }
	})

export type QueryFeature =
	| "a plain read"
	| "a union"
	| "fused attachments"
	| "nested attachments"
	| "a relation parameter"

export const queryFeatures: Arr.NonEmptyReadonlyArray<QueryFeature> = [
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

export const queryCaseGen: Gen<QueryCase> = (source) => ({
	read: source.draw(element(queryFeatures)),
	pick: source.draw(int(0, 7))
})

export type ChangeFeature =
	| "a seat inserted"
	| "an insert"
	| "a put"
	| "a delete"
	| "two strata"
	| "a read-back"
	| "a read-back joining a stored relation"
	| "a refused apply"

/** One ChangeSet stratum's operations over Shop, drawn. */
type ShopOp =
	| { readonly kind: "seat"; readonly id: number; readonly label: number }
	| { readonly kind: "item"; readonly id: number; readonly qty: number }
	| {
			readonly kind: "put stock"
			readonly id: number
			readonly label: number
			readonly qty: number
	  }
	| { readonly kind: "delete stock"; readonly id: number }

export const labels = ["old", "new", "aisle", "bin"] as const

const label = int(0, labels.length - 1)

/** Where a stratum's operation goes: an operation of a kind at a key. */
interface OpSlot {
	readonly kind: "seat" | "item" | "put stock" | "delete stock"
	readonly id: number
}

/**
 * Every slot of a stratum: each kind at each key 1 to 3, so a stratum drawn as distinct slots holds one fact per key
 * of each kind by construction (a same-key pair is the refusal property's below).
 */
const opSlots: ReadonlyArray<OpSlot> = Arr.flatMap(
	["seat", "item", "put stock", "delete stock"] as const,
	(kind) => Arr.map([1, 2, 3], (id): OpSlot => ({ kind, id }))
)

/** The operation at a slot, its payload drawn. */
const opAt =
	(slot: OpSlot): Gen<ShopOp> =>
	(source) => {
		switch (slot.kind) {
			case "seat":
				return { kind: "seat", id: slot.id, label: source.draw(label) }
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
 * A drawn ChangeSet: one or two strata of operations, and what it reads back: nothing, both sides of Item's delta, or
 * Item's added facts joined with Stock. Every stratum writes Seat, Item and Stock, so a delta of one is made by one
 * statement only where there is one stratum, and a ChangeSet of two reads nothing back (write/schedule/plan.ts
 * placeReadBacks refuses a delta two statements make). Nothing reads Seat's delta back.
 */
interface ChangeCase {
	readonly strata: ReadonlyArray<ReadonlyArray<ShopOp>>
	readonly readBack: "none" | "items" | "items joined"
}

export const changeCaseGen: Gen<ChangeCase> = (source) => {
	const strata = source.draw(array(stratumGen, { min: 1, max: 2 }))
	return {
		strata,
		readBack:
			strata.length === 1
				? source.draw(element(["none", "items", "items joined"] as const))
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

export const refusalCaseGen: Gen<RefusalCase> = (source) => ({
	foreign: source.draw(boolean),
	notes: source.draw(
		array((note) => ({ task: note.draw(int(0, 2)), text: note.draw(int(0, 2)) }), {
			min: 1,
			max: 4
		})
	)
})

export type RefusalFeature = "compile" | "encode" | "explained"

/**
 * What explain makes of a refusal case: a ChangeSet over no level of the Db's role does not compile; one whose notes
 * share a task with different texts is a same-key pair host normalization refuses; any other is explained.
 */
export const refusalOf = (c: RefusalCase): RefusalFeature =>
	c.foreign
		? "compile"
		: Arr.some(c.notes, (a) => Arr.some(c.notes, (b) => a.task === b.task && a.text !== b.text))
			? "encode"
			: "explained"

/** A box, the owner of an ordered family of parts whose bodies are bytes, as pantry's import nests its entries. */
export const Box = relation("Box", { id: Id, parts: drawnField(natural) }, ["id"])
const Part = relation("Part", { box: Id, at: drawnField(natural), body: bytes }, ["box", "at"])
/**
 * A later stratum's members, each a query member over a relation parameter of the call, since a call's facts name one
 * array member per op and relation: the first stratum's.
 */
const seatsFrom = query(Shop).rule((r) => {
	const rows = r.relation("seats", { no: Seat.fields.no, label: Seat.fields.label })
	const { no, label } = v(Seat, "seat")
	return r.match(rows, { no, label }).find({ no, label })
})
const itemsFrom = query(Shop).rule((r) => {
	const rows = r.relation("items", {
		id: Item.fields.id,
		label: Item.fields.label,
		qty: Item.fields.qty
	})
	const { id, label, qty } = v(Item, "item")
	return r.match(rows, { id, label, qty }).find({ id, label, qty })
})
const stockFrom = (name: "puts" | "deletes") =>
	query(Shop).rule((r) => {
		const rows = r.relation(name, {
			id: Stock.fields.id,
			label: Stock.fields.label,
			qty: Stock.fields.qty
		})
		const { id, label, qty } = v(Stock, "stock")
		return r.match(rows, { id, label, qty }).find({ id, label, qty })
	})

/**
 * A drawn ChangeSet's later stratum, which the installation's login serves, so it installs the pattern domain of each
 * relation parameter's label (seats, items, puts, deletes): the only types a drawn ChangeSet, served under the
 * installation's snapshot, may cast a parameter to.
 */
export const laterStratum = ChangeSet.empty(Shop)
	.insert(Seat, seatsFrom)
	.insert(Item, itemsFrom)
	.put(Stock, stockFrom("puts"))
	.delete(Stock, stockFrom("deletes"))

export const Boxes = schema(
	"Boxes",
	[Box, Part],
	[ordered(on(Part, "box", "at"), fin(Box, "parts"))]
)

/** A pool whose sessions hold the message bound `limit`, as a server whose bound is below the protocol's does. */
export const boundPool = (pool: SessionPool, limit: number): SessionPool => ({
	...pool,
	lease: Effect.map(pool.lease, (session): Session => ({ ...session, messageMaxBytes: limit }))
})

/** A part body's length as a share of the session's bound, in thousandths of `boundWhole`. */
export const boundWhole = 1_000

/**
 * Where a box's bodies stand against the session's bound: a body past it, which neither the application nor explain
 * sends; every body within it and all of them within it together; or every body within it and together past it, so the
 * application cuts the write into several executions, each under the bound.
 */
export type BoundFeature =
	| "a body past the bound"
	| "bodies within the bound together"
	| "bodies within the bound, together past it"

/** The situation of a box whose bodies are `shares` of the bound (BoundFeature). */
export const boundFeatureOf = (shares: ReadonlyArray<number>): BoundFeature =>
	Arr.some(shares, (share) => share > boundWhole)
		? "a body past the bound"
		: Arr.reduce(shares, 0, (sum, share) => sum + share) > boundWhole
			? "bodies within the bound, together past it"
			: "bodies within the bound together"

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

/** Two to four bodies each past half the bound and within it, so they are within it alone and past it together. */
const togetherPastGen: Gen<BoundCase> = (source) => ({
	shares: nonEmpty(
		source.draw(array(int(boundWhole / 2 + 1, boundWhole), { min: 2, max: 4 })),
		"a box holds a part"
	)
})

/** The shares a case whose turn aims at bodies together past the bound draws (aimed): togetherPastGen's. */
const boundAims: ReadonlyArray<readonly [BoundFeature, Gen<BoundCase>]> = [
	["bodies within the bound, together past it", togetherPastGen]
]

/**
 * The Shop fixture with the later stratum's member in its workload, installed once per member as a read fixture
 * (reads/support.ts fixtureTemplate), where its search installed it before its cases.
 */
export const explainShopInstall = { label: "real", programs: { later: laterStratum } } as const

export const explainShopTemplate = fixtureTemplate(import.meta, Shop, explainShopInstall)

/** The Boxes fixture, installed once per member as a read fixture, where its search installed it before its cases. */
export const explainBoxesInstall = { label: "boxes", programs: {} } as const

export const explainBoxesTemplate = fixtureTemplate(import.meta, Boxes, explainBoxesInstall)

/** Bodies drawn as shares of the bound, each feature aimed at by the shares that reach it (aimed). */
export const boundCases = aimed(boundCaseGen, boundAims)

/** The Work read members a query case explains, each with the parameters its pick gives. */
export const workReads = {
	"a plain read": { member: "plainRead", params: (_pick: number) => ({}) },
	"a union": { member: "union", params: (_pick: number) => ({}) },
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

/** An account's tasks, each with its note: the nested read of the query cases. */
const accountTasks = query(W.Work)
	.rule((r) => {
		const { id, name } = v(W.Account, "account")
		return r
			.match(W.Account, { id, name })
			.where(r.eq(id, r.param("account", Id)))
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

/** The read programs the query cases serve, by member name. */
export const workPrograms = {
	plainRead: W.automaticBudget,
	union: W.taskPayloads,
	fused: W.taskCards,
	nested: accountTasks,
	relationParameter: W.tasksById
} as const

/** `effect` run over `installed`, Work's notes table left as it was before it. */
export const notesUnchanged = <A, E, R>(installed: Installed, effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const before = yield* tableState(installed, W.TaskNote)
		const result = yield* effect
		const after = yield* tableState(installed, W.TaskNote)
		assert.deepEqual(set(valueHash, exactValue)(after, before), Option.none())
		return result
	})
