import { layer } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	pipe,
	Record as Rec,
	String as Str
} from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { failure } from "#test/pg/e2e-laws/support.ts"
import {
	budgets,
	budgetsLaw,
	employersLaw,
	firms,
	firmsLaw,
	lines,
	linesLaw,
	orders,
	ordersLaw,
	quotas,
	quotasLaw,
	rooms,
	roomsLaw
} from "#test/pg/laws/capacity/schemas.ts"

import {
	type CapacityInstall,
	installCapacity,
	witness,
	writerOf
} from "#test/pg/laws/capacity/support.ts"
import { assert, defined } from "#test/support/assert.ts"
import type { SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { installationNamesOf } from "#test/support/kernel/naming.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

const int8Max = 2n ** 63n - 1n
const int8Min = -(2n ** 63n)
const int4Max = 2n ** 31n - 1n
const int4Min = -(2n ** 31n)

/**
 * A stored value as the host reads it: an exact number (scaled by its field's `scale`), a flag, a key text, or a span.
 */
type HostValue =
	| { readonly kind: "number"; readonly value: bigint }
	| { readonly kind: "flag"; readonly value: boolean }
	| { readonly kind: "span"; readonly lo: bigint; readonly hi: bigint }

const num = (value: bigint): HostValue => ({ kind: "number", value })
const flag = (value: boolean): HostValue => ({ kind: "flag", value })

/**
 * A field's planted values, each with its SQL literal, and the scale its numbers are stored at (tenths for numeric(6,1)).
 */
interface Field {
	readonly name: string
	readonly scale: bigint
	readonly values: Arr.NonEmptyReadonlyArray<{ readonly sql: string; readonly host: HostValue }>
}

const numbers = (name: string, values: Arr.NonEmptyReadonlyArray<bigint>): Field => ({
	name,
	scale: 1n,
	values: Arr.map(values, (v) => ({ sql: String(v), host: num(v) }))
})

const flags = (name: string): Field => ({
	name,
	scale: 1n,
	values: Arr.map([true, false] as const, (v) => ({ sql: String(v), host: flag(v) }))
})

/** A relation of a shape: its key's kind, its own fields, and the target relation its group field references. */
interface Relation {
	readonly name: string
	readonly key: "integer" | "uuid"
	readonly fields: ReadonlyArray<Field>
	readonly parent: { readonly field: string; readonly relation: string } | "none"
}

type Bound =
	| { readonly kind: "literal"; readonly value: bigint }
	| { readonly kind: "ref"; readonly field: string }

/** A capacity law as the host reads its statement. */
interface Law {
	readonly id: LawId
	readonly target: string
	readonly targetSelector: { readonly field: string; readonly value: boolean } | "every"
	readonly source: string
	readonly group: string
	readonly sourceSelector: { readonly field: string; readonly value: boolean } | "every"
	readonly weight:
		| { readonly kind: "count" }
		| { readonly kind: "field" | "duration"; readonly field: string }
	readonly low: Bound
	readonly high: Bound | "unbounded"
}

interface Shape {
	readonly name: ShapeName
	readonly desc: SchemaDesc
	readonly relations: Arr.NonEmptyReadonlyArray<Relation>
	readonly laws: ReadonlyArray<Law>
	/**
	 * A field of a relation whose values are unique (the partial UNIQUE of an upper bound of one), with its constraint.
	 */
	readonly unique: { readonly relation: string; readonly field: string } | "none"
}

const shapeNames = ["budgets", "lines", "quotas", "rooms", "orders", "firms"] as const
type ShapeName = (typeof shapeNames)[number]
const edges = [
	"a negative weight counted",
	"a sum past the bigint maximum",
	"a count at a fractional bound",
	"a width past the bigint maximum",
	"a second invoice refused at its statement",
	"only unselected signers"
] as const
type Feature = `${ShapeName} ${"accepted" | "refused by its capacity"}` | (typeof edges)[number]

const span = (lo: bigint, hi: bigint) => ({
	sql: `'[${lo},${hi})'`,
	host: { kind: "span" as const, lo, hi }
})

const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	{
		name: "budgets",
		desc: budgets({ mutable: false }),
		relations: [
			{
				name: "Budget",
				key: "integer",
				fields: [numbers("cap", [-1n, 0n, 5n, int8Max]), flags("open")],
				parent: "none"
			},
			{
				name: "Spend",
				key: "integer",
				fields: [numbers("amount", [int4Min, -3n, 4n, int4Max]), flags("posted")],
				parent: { field: "budget", relation: "Budget" }
			}
		],
		laws: [
			{
				id: budgetsLaw,
				target: "Budget",
				targetSelector: { field: "open", value: true },
				source: "Spend",
				group: "budget",
				sourceSelector: { field: "posted", value: true },
				weight: { kind: "field", field: "amount" },
				low: { kind: "literal", value: 0n },
				high: { kind: "ref", field: "cap" }
			}
		],
		unique: "none"
	},
	{
		name: "lines",
		desc: lines(),
		relations: [
			{ name: "Line", key: "uuid", fields: [numbers("net", [0n, 1n, int8Max])], parent: "none" },
			{
				name: "Deposit",
				key: "uuid",
				fields: [numbers("amount", [1n, int8Max])],
				parent: { field: "line", relation: "Line" }
			}
		],
		laws: [
			{
				id: linesLaw,
				target: "Line",
				targetSelector: "every",
				source: "Deposit",
				group: "line",
				sourceSelector: "every",
				weight: { kind: "field", field: "amount" },
				low: { kind: "ref", field: "net" },
				high: { kind: "ref", field: "net" }
			}
		],
		unique: "none"
	},
	{
		name: "quotas",
		desc: quotas(),
		relations: [
			{
				name: "Quota",
				key: "integer",
				fields: [
					{
						name: "limit",
						scale: 10n,
						values: Arr.map([0n, 19n, 20n, 25n] as const, (t) => ({
							sql: `${t / 10n}.${t % 10n}`,
							host: num(t)
						}))
					}
				],
				parent: "none"
			},
			{ name: "Seat", key: "integer", fields: [], parent: { field: "quota", relation: "Quota" } }
		],
		laws: [
			{
				id: quotasLaw,
				target: "Quota",
				targetSelector: "every",
				source: "Seat",
				group: "quota",
				sourceSelector: "every",
				weight: { kind: "count" },
				low: { kind: "literal", value: 0n },
				high: { kind: "ref", field: "limit" }
			}
		],
		unique: "none"
	},
	{
		name: "rooms",
		desc: rooms({ mutable: false }),
		relations: [
			{
				name: "Room",
				key: "integer",
				fields: [numbers("ceiling", [19n, 20n, int8Max])],
				parent: "none"
			},
			{
				name: "Booking",
				key: "integer",
				fields: [
					{
						name: "during",
						scale: 1n,
						values: [span(0n, 10n), span(5n, 15n), span(int8Min, int8Max), span(0n, int8Max)]
					}
				],
				parent: { field: "room", relation: "Room" }
			}
		],
		laws: [
			{
				id: roomsLaw,
				target: "Room",
				targetSelector: "every",
				source: "Booking",
				group: "room",
				sourceSelector: "every",
				weight: { kind: "duration", field: "during" },
				low: { kind: "literal", value: 0n },
				high: { kind: "ref", field: "ceiling" }
			}
		],
		unique: "none"
	},
	{
		name: "orders",
		desc: orders(),
		relations: [
			{ name: "Order", key: "integer", fields: [], parent: "none" },
			{
				name: "Invoice",
				key: "integer",
				fields: [],
				parent: { field: "order", relation: "Order" }
			},
			{ name: "Employer", key: "integer", fields: [], parent: "none" },
			{
				name: "Approver",
				key: "integer",
				fields: [],
				parent: { field: "employer", relation: "Employer" }
			}
		],
		laws: [
			{
				id: ordersLaw,
				target: "Order",
				targetSelector: "every",
				source: "Invoice",
				group: "order",
				sourceSelector: "every",
				weight: { kind: "count" },
				low: { kind: "literal", value: 1n },
				high: { kind: "literal", value: 1n }
			},
			{
				id: employersLaw,
				target: "Employer",
				targetSelector: "every",
				source: "Approver",
				group: "employer",
				sourceSelector: "every",
				weight: { kind: "count" },
				low: { kind: "literal", value: 1n },
				high: "unbounded"
			}
		],
		unique: { relation: "Invoice", field: "order" }
	},
	{
		name: "firms",
		desc: firms(),
		relations: [
			{ name: "Firm", key: "integer", fields: [], parent: "none" },
			{
				name: "Signer",
				key: "integer",
				fields: [flags("active")],
				parent: { field: "firm", relation: "Firm" }
			}
		],
		laws: [
			{
				id: firmsLaw,
				target: "Firm",
				targetSelector: "every",
				source: "Signer",
				group: "firm",
				sourceSelector: { field: "active", value: true },
				weight: { kind: "count" },
				low: { kind: "literal", value: 1n },
				high: "unbounded"
			}
		],
		unique: "none"
	}
]

/** A fact as the host keeps it: its key text, its group's key text when it has a parent, and its fields. */
interface Fact {
	readonly key: string
	readonly parent: string
	readonly fields: ReadonlyMap<string, HostValue>
}
type State = ReadonlyMap<string, ReadonlyArray<Fact>>

/** The facts of a relation the state holds: every relation of the shape is a key of it. */
const factsIn = (state: State, relation: string): ReadonlyArray<Fact> =>
	defined(state.get(relation), relation)

/**
 * One drawn statement: an insert into a relation with each of its fields at a planted value, by the value's SQL
 * literal, and a pick for its parent among the targets there are; or a delete of a fact picked among those there are.
 */
type OpSketch =
	| {
			readonly kind: "insert"
			readonly relation: string
			readonly values: Readonly<Record<string, string>>
			readonly parent: number
	  }
	| { readonly kind: "delete"; readonly relation: string; readonly pick: number }

interface CaseSketch {
	readonly shape: ShapeName
	readonly transactions: ReadonlyArray<ReadonlyArray<OpSketch>>
}

const shapeNamed = (name: ShapeName): Shape =>
	Option.getOrThrowWith(
		Arr.findFirst(shapes, (s) => s.name === name),
		() => new Error(name)
	)

const relationNamed = (shape: Shape, name: string): Relation =>
	Option.getOrThrowWith(
		Arr.findFirst(shape.relations, (r) => r.name === name),
		() => new Error(`${name} is no relation of ${shape.name}`)
	)

/** The planted value of a field its SQL literal names. */
const valueNamed = (relation: Relation, f: Field, sql: string | undefined) =>
	Option.getOrThrowWith(
		Arr.findFirst(f.values, (v) => v.sql === sql),
		() => new Error(`${relation.name}.${f.name} plants no ${String(sql)}`)
	)

/** A statement of a shape's: an insert three times in four, into one of its relations, each field at one of its
 * planted values; otherwise a delete from one of its relations. */
const opGen = (shape: Shape): Gen<OpSketch> =>
	weighted<OpSketch>([
		[
			3,
			(source) => {
				const relation = source.draw(element(shape.relations))
				return {
					kind: "insert",
					relation: relation.name,
					values: Rec.fromEntries(
						Arr.map(relation.fields, (f) => [f.name, source.draw(element(f.values)).sql] as const)
					),
					parent: source.draw(pickGen)
				}
			}
		],
		[
			1,
			(source) => ({
				kind: "delete",
				relation: source.draw(element(shape.relations)).name,
				pick: source.draw(pickGen)
			})
		]
	])

/** A case: one of the shapes, then up to three transactions of its statements. */
const caseGen: Gen<CaseSketch> = (source) => {
	const shape = source.draw(element(shapeNames))
	return {
		shape,
		transactions: source.draw(
			array(array(opGen(shapeNamed(shape)), { min: 1, max: 6 }), { min: 1, max: 3 })
		)
	}
}

/** An insert into `relation`, each field at the planted value its SQL literal names, under the first target. */
const insertInto = (relation: string, values: Readonly<Record<string, string>>): OpSketch => ({
	kind: "insert",
	relation,
	values,
	parent: 0
})

const plant = (
	shape: ShapeName,
	note: string,
	ops: ReadonlyArray<OpSketch>,
	reaches: Kept<CaseSketch, Feature>["reaches"]
): Kept<CaseSketch, Feature> => ({
	note,
	sketch: { shape, transactions: [ops] },
	draws: "",
	reaches
})

/**
 * Each planted edge, and each outcome a shape's drawn transactions rarely reach, as a kept case of one transaction: the
 * edges need values in a combination (two deposits at the bigint maximum on one line, a booking as wide as the int8
 * range) or inserts in an order (an order, its invoice, then a second invoice of it) that drawn transactions over
 * several relations rarely make.
 */
const planted: ReadonlyArray<Kept<CaseSketch, Feature>> = [
	plant(
		"budgets",
		"a budget of 5, and spends of -3 and 4 posted to it",
		[
			insertInto("Budget", { cap: "5", open: "true" }),
			insertInto("Spend", { amount: "-3", posted: "true" }),
			insertInto("Spend", { amount: "4", posted: "true" })
		],
		["a negative weight counted", "budgets accepted"]
	),
	plant(
		"lines",
		"a line of net 1 and a deposit of 1",
		[insertInto("Line", { net: "1" }), insertInto("Deposit", { amount: "1" })],
		["lines accepted"]
	),
	plant(
		"lines",
		"a line of net 2^63 - 1 and two deposits of 2^63 - 1",
		[
			insertInto("Line", { net: String(int8Max) }),
			insertInto("Deposit", { amount: String(int8Max) }),
			insertInto("Deposit", { amount: String(int8Max) })
		],
		["a sum past the bigint maximum", "lines refused by its capacity"]
	),
	plant(
		"quotas",
		"a quota of 2.5 and three seats",
		[
			insertInto("Quota", { limit: "2.5" }),
			insertInto("Seat", {}),
			insertInto("Seat", {}),
			insertInto("Seat", {})
		],
		["a count at a fractional bound", "quotas refused by its capacity"]
	),
	plant(
		"rooms",
		"a room of ceiling 2^63 - 1 and a booking across the whole int8 range",
		[
			insertInto("Room", { ceiling: String(int8Max) }),
			insertInto("Booking", { during: span(int8Min, int8Max).sql })
		],
		["a width past the bigint maximum", "rooms refused by its capacity"]
	),
	plant(
		"orders",
		"an order, its invoice and a second invoice of it",
		[insertInto("Order", {}), insertInto("Invoice", {}), insertInto("Invoice", {})],
		["a second invoice refused at its statement"]
	),
	plant(
		"orders",
		"an order and its one invoice, an employer and its one approver",
		[
			insertInto("Order", {}),
			insertInto("Invoice", {}),
			insertInto("Employer", {}),
			insertInto("Approver", {})
		],
		["orders accepted"]
	),
	plant(
		"orders",
		"an order with no invoice",
		[insertInto("Order", {})],
		["orders refused by its capacity"]
	),
	plant(
		"firms",
		"a firm and one inactive signer",
		[insertInto("Firm", {}), insertInto("Signer", { active: "false" })],
		["only unselected signers", "firms refused by its capacity"]
	)
]

const keyText = (r: Relation, n: number): string =>
	r.key === "integer"
		? String(n)
		: `00000000-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`
const keySql = (r: Relation, key: string): string => (r.key === "integer" ? key : `'${key}'`)

const numberOf = (v: HostValue | undefined, what: string): bigint => {
	if (v?.kind !== "number") {
		throw new Error(`${what} is a number`)
	}
	return v.value
}

const selectedBy = (fact: Fact, selector: Law["targetSelector"]): boolean => {
	if (selector === "every") {
		return true
	}
	const v = fact.fields.get(selector.field)
	return v?.kind === "flag" && v.value === selector.value
}

/** What one source fact weighs under a law: one, its weight field, or its span's whole width. */
const weightOf = (law: Law, s: Fact): bigint => {
	switch (law.weight.kind) {
		case "count":
			return 1n
		case "field":
			return numberOf(s.fields.get(law.weight.field), law.weight.field)
		case "duration": {
			const v = defined(s.fields.get(law.weight.field), law.weight.field)
			if (v.kind !== "span") {
				throw new Error("a duration weight is a span")
			}
			return v.hi - v.lo
		}
	}
}

/**
 * The targets a law finds violated in `state`: each selected target whose group's total, scaled to the bound's field,
 * lies outside its bounds.
 */
const violations = (shape: Shape, law: Law, state: State): ReadonlyArray<string> => {
	const targetRelation = Option.getOrThrowWith(
		Arr.findFirst(shape.relations, (r) => r.name === law.target),
		() => new Error(law.target)
	)
	const sources = Arr.filter(factsIn(state, law.source), (s) => selectedBy(s, law.sourceSelector))
	return Arr.flatMap(factsIn(state, law.target), (t) => {
		if (!selectedBy(t, law.targetSelector)) {
			return []
		}
		const group = Arr.filter(sources, (s) => s.parent === t.key)
		const total = Arr.reduce(group, 0n, (sum, s) => sum + weightOf(law, s))
		const bound = (b: Bound) => {
			if (b.kind === "literal") {
				return { value: b.value, scale: 1n }
			}
			const field = Option.getOrThrowWith(
				Arr.findFirst(targetRelation.fields, (f) => f.name === b.field),
				() => new Error(b.field)
			)
			return { value: numberOf(t.fields.get(b.field), b.field), scale: field.scale }
		}
		const low = bound(law.low)
		const below = total * low.scale < low.value
		const above =
			law.high === "unbounded"
				? false
				: (() => {
						const high = bound(law.high)
						return total * high.scale > high.value
					})()
		return below || above ? [t.key] : []
	})
}

type Expected =
	| { readonly kind: "accepted"; readonly state: State }
	| { readonly kind: "unique"; readonly at: number }
	| {
			readonly kind: "commit"
			readonly laws: ReadonlyMap<LawId, ReadonlyArray<string>>
	  }

/**
 * Scalar-group capacity on PostgreSQL 19, one writer at a time, over every capacity shape the fixtures declare and the
 * values at their edges.
 *
 * The writer is a raw session in the schema's full role, holding only its derived grants. Each case
 * draws a shape (schemas.ts) and up to three transactions of inserts and deletes, whose values come from domains with
 * the shape's edges planted:
 *
 * - Budgets: a field-weighted sum against a `ref` bound, both sides selected; integer weights that may be negative.
 * - Lines: an exact `ref` bound over bigint weights, two of which at the bigint limit sum past any bigint, exactly.
 * - Quotas: a count against a numeric(6,1) `ref` bound, compared in its own type: 2.5 admits two, not three.
 * - Rooms: a duration weight, the sum of whole widths (overlap counts twice), a width from the bigint minimum to its
 *   maximum past any bigint.
 * - Orders: `within(1n, 1n)`, the partial UNIQUE (immediate, 23505 at its statement) plus the existence law, and
 *   Employers' `within(1n, "*")`, the existence law alone.
 * - Firms: the existence law over a selected source, which an unselected signer never satisfies.
 *
 * The host keeps the state and judges each transaction: a duplicate under the partial UNIQUE is refused at its
 * statement; at COMMIT, a source whose group's target is missing is the deferred containment's 23503, and a selected
 * target whose group's total (in exact arithmetic) lies outside its bounds is the capacity law's 23000, naming the law
 * and a violating target's key. Otherwise COMMIT succeeds. Every shape must reach an acceptance and a refusal by its
 * capacity, and each planted edge must be met; every edge, and each outcome the drawn transactions rarely reach, is a
 * kept case as well (`planted`).
 *
 * The planted edges this transaction reached.
 */
export const capacityBehaviourSuite = (): void => {
	layer(Substrate.layer)("scalar-group capacity, one writer", (it) => {
		it.effect(
			"every capacity shape commits iff its final state is lawful, at its planted edges",
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { admin } = yield* Substrate
						/** Every shape's installation, made before the first case. */
						const installedShapes = yield* Effect.forEach(shapes, (shape) =>
							Effect.map(
								installCapacity(shape.desc, `cap${shape.name}`),
								(installed) => [shape.name, installed] as const
							)
						)
						const installs = new Map(installedShapes)
						return yield* explore(
							{
								suite: "laws/capacity-shapes",
								draw: drawn(caseGen),
								literal: Formatter.format,
								kept: planted,
								runs: 120,
								concurrency: 1,
								steerEvery: 16,
								/**
								 * Each candidate is a case against the server: a complete shrink of a failure only some runs reproduce never
								 * ends (laws/families/suites/family.ts), so it stops after 300.
								 */
								shrink: { kind: "bounded", candidates: 300 },
								coverage: required<Feature>(
									[
										...Arr.flatMap(shapeNames, (s): Arr.NonEmptyReadonlyArray<Feature> => [
											`${s} accepted`,
											`${s} refused by its capacity`
										]),
										...edges
									],
									{ cases: 120, sense: notesOnly }
								),
								caseHang: Duration.minutes(2)
							},
							(sketch, c) =>
								Effect.gen(function* () {
									const shape = shapeNamed(sketch.shape)
									const install: CapacityInstall = defined(
										installs.get(shape.name),
										`the installation of ${shape.name}`
									)
									const names = installationNamesOf(install.installation)
									const tables = Arr.join(
										Arr.map(shape.relations, (r) => install.table(r.name)),
										", "
									)
									yield* admin.query(`TRUNCATE ${tables}`, [])
									let state: State = new Map(Arr.map(shape.relations, (r) => [r.name, []]))
									let next = 1
									yield* Effect.scoped(
										Effect.gen(function* () {
											const w = yield* writerOf(install, "writer")
											for (const ops of sketch.transactions) {
												/**
												 * The transaction's ops resolved in order against the state before it: its statements, the
												 * draft state they reach, and the statement a unique group field refuses, if one plants a
												 * duplicate (the ops after it are not resolved).
												 */
												const draft = new Map(state)
												const statements: Array<string> = []
												let unique: Option.Option<number> = Option.none()
												for (const op of ops) {
													const relation = relationNamed(shape, op.relation)
													const facts = factsIn(draft, relation.name)
													if (op.kind === "delete") {
														if (facts.length === 0) {
															continue
														}
														const victim = pickFrom(
															[defined(facts[0], "a fact"), ...facts.slice(1)],
															op.pick
														)
														/** A target keeps its sources' containment: one with sources stays. */
														const held = Arr.some(
															shape.relations,
															(r) =>
																r.parent !== "none" &&
																r.parent.relation === relation.name &&
																Arr.some(factsIn(draft, r.name), (f) => f.parent === victim.key)
														)
														if (held) {
															continue
														}
														draft.set(
															relation.name,
															Arr.filter(facts, (f) => f !== victim)
														)
														statements.push(
															`DELETE FROM ${install.table(relation.name)} WHERE "id" = ${keySql(relation, victim.key)}`
														)
														continue
													}
													const key = keyText(relation, next++)
													const fields = new Map(
														Arr.map(
															relation.fields,
															(f) => [f.name, valueNamed(relation, f, op.values[f.name])] as const
														)
													)
													const columns = [
														'"id"',
														...Arr.map(relation.fields, (f) => quoteIdent(f.name))
													]
													const values = [
														keySql(relation, key),
														...Arr.map([...fields.values()], (v) => v.sql)
													]
													let parent = ""
													if (relation.parent !== "none") {
														const p = relation.parent
														const parentRelation = Option.getOrThrowWith(
															Arr.findFirst(shape.relations, (r) => r.name === p.relation),
															() => new Error(`${p.relation} is no relation of ${shape.name}`)
														)
														/** A source joins an existing target only: the containment is the families' to judge. */
														const keys = Arr.map(factsIn(draft, p.relation), (f) => f.key)
														if (keys.length === 0) {
															continue
														}
														/**
														 * Under a unique group field, an odd pick plants the duplicate: a parent that already
														 * holds a child, when one does.
														 */
														const holding = Arr.filter(keys, (k) =>
															Arr.some(facts, (f) => f.parent === k)
														)
														const u = shape.unique
														const plants =
															u !== "none" &&
															u.relation === relation.name &&
															op.parent % 2 === 1 &&
															holding.length > 0
														const from = plants ? holding : keys
														parent = pickFrom(
															[defined(from[0], "a parent key"), ...from.slice(1)],
															op.parent
														)
														columns.push(quoteIdent(p.field))
														values.push(keySql(parentRelation, parent))
													}
													statements.push(
														`INSERT INTO ${install.table(relation.name)} (${Arr.join(columns, ", ")}) VALUES (${Arr.join(values, ", ")})`
													)
													const fact: Fact = {
														key,
														parent,
														fields: new Map(Arr.map([...fields], ([k, v]) => [k, v.host]))
													}
													draft.set(relation.name, [...facts, fact])
													const u = shape.unique
													if (
														u !== "none" &&
														u.relation === relation.name &&
														Arr.some(facts, (f) => f.parent === parent)
													) {
														unique = Option.some(statements.length - 1)
														break
													}
												}
												const expected = Option.match(unique, {
													onSome: (at): Expected => ({ kind: "unique", at }),
													onNone: (): Expected => {
														const laws = new Map(
															Arr.flatMap(shape.laws, (l) => {
																const v = violations(shape, l, draft)
																return v.length > 0 ? [[l.id, v] as const] : []
															})
														)
														return laws.size === 0
															? { kind: "accepted", state: draft }
															: { kind: "commit", laws }
													}
												})
												noteEdges(shape, draft, c.note)
												yield* w.begin
												const run = statements.slice(
													0,
													expected.kind === "unique" ? expected.at : statements.length
												)
												for (const sql of run) {
													yield* w.query(sql, [])
												}
												const what = `${shape.name}: ${Arr.join(statements, "; ")}`
												switch (expected.kind) {
													case "unique": {
														const refused = yield* failure(
															w.query(defined(statements[expected.at], "the duplicate"), [])
														)
														assert.equal(refused.code, "23505", what)
														assert.equal(
															refused.constraint,
															names.fieldConstraint({ name: "Invoice" }, "key", ["order"]),
															what
														)
														c.note("a second invoice refused at its statement")
														yield* w.rollback
														break
													}
													case "accepted":
														yield* w.commit
														state = expected.state
														c.note(`${shape.name} accepted`)
														break
													case "commit": {
														const refused = yield* failure(w.commit)
														const law = Arr.findFirst(
															shape.laws,
															(l) => l.id === refused.constraint
														)
														assert.equal(refused.code, "23000", what)
														const id = Option.getOrThrowWith(
															law,
															() =>
																new Error(
																	`${what}: a capacity law's constraint, not ${refused.constraint}`
																)
														).id
														const violated = defined(
															expected.laws.get(id),
															`${what}: ${id} holds on the final state`
														)
														assert.ok(
															violated.includes(
																defined(witness(install.law(id), refused.detail)[0], "a key")
															),
															what
														)
														c.note(`${shape.name} refused by its capacity`)
														break
													}
												}
											}
										})
									)
								})
						)
					})
				),
			900_000
		)
	})
}

const value = (f: Fact, field: string) => f.fields.get(field)

/** Notes each planted edge the judged state reaches. */
const noteEdges = (shape: Shape, state: State, note: (f: Feature) => void): void => {
	const facts = (relation: string) => factsIn(state, relation)
	switch (shape.name) {
		case "budgets":
			if (
				Arr.some(facts("Spend"), (s) => {
					const v = value(s, "amount")
					return v?.kind === "number" && v.value < 0n
				})
			) {
				note("a negative weight counted")
			}
			return
		case "lines": {
			const total = (line: Fact) =>
				Arr.reduce(
					Arr.filter(facts("Deposit"), (d) => d.parent === line.key),
					0n,
					(sum, d) => sum + numberOf(value(d, "amount"), "amount")
				)
			if (Arr.some(facts("Line"), (line) => total(line) > int8Max)) {
				note("a sum past the bigint maximum")
			}
			return
		}
		case "quotas":
			if (
				Arr.some(facts("Quota"), (q) => {
					const tenths = numberOf(value(q, "limit"), "limit")
					const count = BigInt(Arr.filter(facts("Seat"), (s) => s.parent === q.key).length)
					return tenths % 10n !== 0n && (count === tenths / 10n || count === tenths / 10n + 1n)
				})
			) {
				note("a count at a fractional bound")
			}
			return
		case "rooms":
			if (
				Arr.some(facts("Booking"), (b) => {
					const v = value(b, "during")
					return v?.kind === "span" && v.hi - v.lo > int8Max
				})
			) {
				note("a width past the bigint maximum")
			}
			return
		case "orders":
			return
		case "firms":
			if (
				Arr.some(facts("Firm"), (f) => {
					const signers = Arr.filter(facts("Signer"), (s) => s.parent === f.key)
					return (
						signers.length > 0 &&
						Arr.every(signers, (s) => {
							const v = value(s, "active")
							return v?.kind === "flag" && !v.value
						})
					)
				})
			) {
				note("only unselected signers")
			}
	}
}
