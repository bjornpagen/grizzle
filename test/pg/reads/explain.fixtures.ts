import { assert, defined, unorderedEqual } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, shuffled } from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Record as Rec } from "effect"
import { type Plan, type PlanTarget, type StatementPlan } from "#adapter/types/db.ts"
import { type Prologue } from "#adapter/wire/batch.ts"
import { planNodes } from "#bench/harness/explain.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import { on } from "#compiler/public/schema.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { Item, Seat, Shop, Stock } from "#test/pg/reads/shop.ts"
import { fixtureTemplate } from "#test/pg/reads/support.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { type Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap, type WireWindow } from "#test/support/wire-tap.ts"

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
	for (const node of planNodes(plan)) {
		planShape(node, Rec.keys(node), [])
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
	for (const node of planNodes(plan)) {
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
			!regex("^\\s*(?:CREATE|DO)\\b", "i").test(text) &&
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

/**
 * The Shop fixture with the later stratum's member in its workload, installed once per member as a read fixture
 * (reads/support.ts fixtureTemplate), where its search installed it before its cases.
 */
export const explainShopInstall = { label: "real", programs: { later: laterStratum } } as const

export const explainShopTemplate = fixtureTemplate(import.meta, Shop, explainShopInstall)
