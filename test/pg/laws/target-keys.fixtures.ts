/** What the properties of target-keys.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	subarray,
	weighted,
	constant
} from "@bjornpagen/testing/gen"
import { Array as Arr, Data, Option } from "effect"
import type { ExprDesc, SideDesc, TermDesc } from "#compiler/ir/desc.ts"
import { nonEmpty } from "#test/support/assert.ts"
import {
	contained,
	f,
	field,
	key,
	literal,
	relation,
	type SchemaDesc
} from "#test/support/fixtures/ir/desc.ts"

/** A field of Tgt. */
type Field = "id" | "a" | "b" | "c" | "flag" | "depth"

/** The fields a target lists as its terms, in Tgt's order, each list met by Src's p, q and r in order. */
const TERM_LISTS: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Field>> = [
	["id"],
	["a"],
	["b"],
	["id", "a"],
	["id", "b"],
	["a", "b"],
	["id", "a", "b"]
]

/** The fields a drawn key lists, in Tgt's order. */
const KEY_FIELDS: Arr.NonEmptyReadonlyArray<Field> = ["a", "b", "c", "flag", "depth"]

/**
 * The conditions a selection draws, by the field each is about: at most one per field, so no field is equated to two
 * values at once. `b = a`, `c = a` and `c = b` equate two fields; `c <> 0` equates nothing.
 */
const SLOTS = [
	["a = 0", "a = 1"],
	["b = 0", "b = a"],
	["c = 1", "c = a", "c = b", "c <> 0"],
	["flag", "not flag"],
	["depth = 0", "depth = 1"]
] as const

type Condition = (typeof SLOTS)[number][number]

/** A key of Tgt beyond its primary key: the conditions of its selection, none over the whole relation, and its terms. */
interface KeySketch {
	readonly selection: ReadonlyArray<Condition>
	readonly terms: Arr.NonEmptyReadonlyArray<Field>
}

/** A row of Tgt; its id is its place in a state. */
interface TgtRow {
	readonly a: 0 | 1
	readonly b: 0 | 1
	readonly c: 0 | 1
	readonly flag: boolean
	readonly depth: 0 | 1
}

/** A row of Src, its sid its place in a state: p, q and r, the first of which its tuple reads. */
type SrcRow = readonly [p: 0 | 1, q: 0 | 1, r: 0 | 1]

/** A state: Tgt's rows at ids 0, 1 and 2 and Src's at sids 0 and 1, each absent or a row. */
interface State {
	readonly tgt: ReadonlyArray<TgtRow | undefined>
	readonly src: ReadonlyArray<SrcRow | undefined>
}

/**
 * A case: the target's terms and selection, the drawn key, if any, whether a containment out of the target's selection
 * probes its own columns, and the states written over the schema.
 */
interface Sketch {
	readonly terms: Arr.NonEmptyReadonlyArray<Field>
	readonly target: ReadonlyArray<Condition>
	readonly key: KeySketch | undefined
	readonly probed: boolean
	readonly states: ReadonlyArray<State>
}

export class Disagreed extends Data.TaggedError("Disagreed")<{ readonly message: string }> {}

const bit: Gen<0 | 1> = element<0 | 1>([0, 1])

const selectionGen: Gen<ReadonlyArray<Condition>> = (source) =>
	Arr.flatMap(SLOTS, (slot): ReadonlyArray<Condition> =>
		source.draw(boolean) ? [source.draw(element<Condition>(slot))] : []
	)

/** Some of `values` in their order, at least one. */
const someOf =
	<A>(values: Arr.NonEmptyReadonlyArray<A>): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => {
		const kept = source.draw(subarray(values))
		return Arr.isReadonlyArrayNonEmpty(kept) ? kept : [source.draw(element(values))]
	}

/** Whether two conditions are drawn from one slot: about one field. */
const sameSlot = (x: Condition, y: Condition): boolean =>
	Arr.some(SLOTS, (slot) => Arr.some(slot, (d) => d === x) && Arr.some(slot, (d) => d === y))

/**
 * A key aimed at the rule's boundary, over a target of `terms` selected by `target`: one the target holds, over some of
 * its conditions, its terms among the target's terms and the fields it fixes outside them; one beside it, the same
 * but its selection holding a condition the target lacks; one drawn freely; or none.
 */
const keyGen =
	(
		terms: Arr.NonEmptyReadonlyArray<Field>,
		target: ReadonlyArray<Condition>
	): Gen<KeySketch | undefined> =>
	(source) => {
		const heldTerms = (within: ReadonlyArray<Condition>): Gen<Arr.NonEmptyReadonlyArray<Field>> =>
			someOf(
				Arr.dedupe(
					Arr.appendAll(
						terms,
						Arr.flatMap(target, (c) =>
							within.includes(c) ? [] : Arr.map(fixedBy(c, terms), (x) => x.field)
						)
					)
				)
			)
		return source.draw(
			weighted<KeySketch | undefined>([
				[1, () => undefined],
				[
					3,
					(s) => {
						const within = s.draw(subarray(target))
						return { selection: within, terms: s.draw(heldTerms(within)) }
					}
				],
				[
					2,
					(s) => {
						const within = s.draw(subarray(target))
						const beside = Arr.filter(
							Arr.flatten(SLOTS),
							(c) => !target.includes(c) && !Arr.some(within, (w) => sameSlot(w, c))
						)
						return {
							selection: [...within, s.draw(element<Condition>(nonEmpty(beside)))],
							terms: s.draw(heldTerms(within))
						}
					}
				],
				[1, (s) => ({ selection: s.draw(selectionGen), terms: s.draw(someOf(KEY_FIELDS)) })]
			])
		)
	}

const tgtRowGen: Gen<TgtRow | undefined> = (source) =>
	source.draw(boolean)
		? {
				a: source.draw(bit),
				b: source.draw(bit),
				c: source.draw(bit),
				flag: source.draw(boolean),
				depth: source.draw(bit)
			}
		: undefined

const srcRowGen: Gen<SrcRow | undefined> = (source) =>
	source.draw(boolean) ? [source.draw(bit), source.draw(bit), source.draw(bit)] : undefined

const stateGen: Gen<State> = (source) => ({
	tgt: [source.draw(tgtRowGen), source.draw(tgtRowGen), source.draw(tgtRowGen)],
	src: [source.draw(srcRowGen), source.draw(srcRowGen)]
})

/** How many states a case writes over its one installation. */
const STATES = 16

export const sketchGen: Gen<Sketch> = (source) => {
	const terms = source.draw(
		weighted<Arr.NonEmptyReadonlyArray<Field>>(
			Arr.map(TERM_LISTS, (list) => [list.includes("id") ? 1 : 3, () => list])
		)
	)
	const target = source.draw(selectionGen)
	return {
		terms,
		target,
		key: source.draw(keyGen(terms, target)),
		probed: source.draw(boolean),
		states: source.draw(array(stateGen, { min: STATES, max: STATES }))
	}
}

/** What a condition equates: a field to a value, two fields to each other, or nothing. */
type Equation =
	| { readonly kind: "value"; readonly field: Field }
	| { readonly kind: "fields"; readonly fields: readonly [Field, Field] }
	| { readonly kind: "none" }

const equationOf = (c: Condition): Equation => {
	switch (c) {
		case "a = 0":
		case "a = 1":
			return { kind: "value", field: "a" }
		case "b = 0":
			return { kind: "value", field: "b" }
		case "c = 1":
			return { kind: "value", field: "c" }
		case "flag":
		case "not flag":
			return { kind: "value", field: "flag" }
		case "depth = 0":
		case "depth = 1":
			return { kind: "value", field: "depth" }
		case "b = a":
			return { kind: "fields", fields: ["b", "a"] }
		case "c = a":
			return { kind: "fields", fields: ["c", "a"] }
		case "c = b":
			return { kind: "fields", fields: ["c", "b"] }
		case "c <> 0":
			return { kind: "none" }
	}
}

/** How a target fixes a field beyond its terms: to a value, or to one of its terms. */
interface Fixed {
	readonly field: Field
	readonly to: "a value" | "a term"
}

/** The field a condition fixes beyond the target's terms `terms`: one equated to a value, or to exactly one term. */
const fixedBy = (c: Condition, terms: ReadonlyArray<Field>): ReadonlyArray<Fixed> => {
	const e = equationOf(c)
	switch (e.kind) {
		case "value":
			return terms.includes(e.field) ? [] : [{ field: e.field, to: "a value" }]
		case "fields": {
			const [x, y] = e.fields
			if (terms.includes(x) === terms.includes(y)) {
				return []
			}
			return [{ field: terms.includes(x) ? y : x, to: "a term" }]
		}
		case "none":
			return []
	}
}

/** The fields the target fixes outside `key`'s selection, each fixed by exactly one of its conditions. */
const fixedFields = (s: Sketch, k: KeySketch): ReadonlyArray<Fixed> => {
	const found = Arr.flatMap(s.target, (c) => (k.selection.includes(c) ? [] : fixedBy(c, s.terms)))
	return Arr.filter(found, (x) => Arr.filter(found, (y) => y.field === x.field).length === 1)
}

/** Tgt's keys: its primary key id, then the drawn key. */
const keysOf = (s: Sketch): ReadonlyArray<KeySketch> => [
	{ selection: [], terms: ["id"] },
	...(s.key === undefined ? [] : [s.key])
]

/** Whether the drawn key is over the whole relation at Tgt's primary key's set, id alone: a second key of one set. */
export const restatesPrimary = ({ key }: Sketch): boolean =>
	key?.selection.length === 0 && Arr.every(key.terms, (t) => t === "id")

/** How a target holds a key: with the fields it fixes, by the key it is first held by; by its terms alone; or none. */
type Held =
	| { readonly kind: "fixed"; readonly key: KeySketch; readonly fixed: ReadonlyArray<Fixed> }
	| { readonly kind: "terms" }
	| { readonly kind: "none" }

/** The specification of a target holding a key (the header), read from the sketch alone. */
export const heldOf = (s: Sketch): Held => {
	const within = Arr.filter(keysOf(s), (k) => Arr.every(k.selection, (c) => s.target.includes(c)))
	const byFixed = Arr.findFirst(within, (k) => {
		const fixed = fixedFields(s, k)
		return (
			fixed.length > 0 &&
			Arr.every(k.terms, (t) => s.terms.includes(t) || Arr.some(fixed, (x) => x.field === t))
		)
	})
	if (Option.isSome(byFixed)) {
		return { kind: "fixed", key: byFixed.value, fixed: fixedFields(s, byFixed.value) }
	}
	return Arr.some(within, (k) => Arr.every(k.terms, (t) => s.terms.includes(t)))
		? { kind: "terms" }
		: { kind: "none" }
}

/** A field's value at a Tgt row of id `id`, as a comparable number. */
const valueAt = (row: TgtRow, id: number, f: Field): number => {
	switch (f) {
		case "id":
			return id
		case "a":
		case "b":
		case "c":
		case "depth":
			return row[f]
		case "flag":
			return row.flag ? 1 : 0
	}
}

/** Whether a condition holds of a Tgt row. */
const holds = (c: Condition, row: TgtRow): boolean => {
	switch (c) {
		case "a = 0":
			return row.a === 0
		case "a = 1":
			return row.a === 1
		case "b = 0":
			return row.b === 0
		case "b = a":
			return row.b === row.a
		case "c = 1":
			return row.c === 1
		case "c = a":
			return row.c === row.a
		case "c = b":
			return row.c === row.b
		case "c <> 0":
			return row.c !== 0
		case "flag":
			return row.flag
		case "not flag":
			return !row.flag
		case "depth = 0":
			return row.depth === 0
		case "depth = 1":
			return row.depth === 1
	}
}

/** A state's Tgt rows with their ids. */
const tgtRows = (state: State): ReadonlyArray<readonly [number, TgtRow]> =>
	Arr.flatMap(state.tgt, (row, id): ReadonlyArray<readonly [number, TgtRow]> =>
		row === undefined ? [] : [[id, row]]
	)

/** Whether a state breaks the drawn key: two of its rows the key's selection keeps agree at its terms. */
export const keyBroken = (s: Sketch, state: State): boolean => {
	const k = s.key
	if (k === undefined) {
		return false
	}
	const kept = Arr.filter(tgtRows(state), ([, row]) => Arr.every(k.selection, (c) => holds(c, row)))
	return Arr.some(kept, ([i, x], at) =>
		Arr.some(
			kept.slice(at + 1),
			([j, y]) => i !== j && Arr.every(k.terms, (t) => valueAt(x, i, t) === valueAt(y, j, t))
		)
	)
}

/** Whether a state breaks the containment: a Src row's tuple is no tuple of a Tgt row the target's selection keeps. */
export const containmentBroken = (s: Sketch, state: State): boolean =>
	Arr.some(
		Arr.filter(state.src, (row): row is SrcRow => row !== undefined),
		(src) =>
			!Arr.some(
				tgtRows(state),
				([id, row]) =>
					Arr.every(s.target, (c) => holds(c, row)) &&
					Arr.every(s.terms, (t, i) => valueAt(row, id, t) === src[i])
			)
	)

/**
 * Whether a state holds two Tgt rows equal at the target's terms, which a UNIQUE over the terms alone would hold apart:
 * a fixed target's UNIQUE holds them apart only where they also agree at its fixed fields.
 */
export const sharesTerms = (s: Sketch, state: State): boolean => {
	const rows = tgtRows(state)
	return Arr.some(rows, ([i, x], at) =>
		Arr.some(rows.slice(at + 1), ([j, y]) =>
			Arr.every(s.terms, (t) => valueAt(x, i, t) === valueAt(y, j, t))
		)
	)
}

/** A condition as the schema's selection states it, a row predicate over Tgt's fields. */
const conditionExpr = (c: Condition): ExprDesc => {
	const eq = (left: ExprDesc, right: ExprDesc): ExprDesc => ({
		kind: "compare",
		op: "eq",
		left,
		right
	})
	switch (c) {
		case "a = 0":
			return eq(field("a"), literal(0))
		case "a = 1":
			return eq(field("a"), literal(1))
		case "b = 0":
			return eq(field("b"), literal(0))
		case "b = a":
			return eq(field("b"), field("a"))
		case "c = 1":
			return eq(field("c"), literal(1))
		case "c = a":
			return eq(field("c"), field("a"))
		case "c = b":
			return eq(field("c"), field("b"))
		case "c <> 0":
			return { kind: "compare", op: "ne", left: field("c"), right: literal(0) }
		case "flag":
			return eq(field("flag"), literal(true))
		case "not flag":
			return eq(field("flag"), literal(false))
		case "depth = 0":
			return eq(field("depth"), literal(0n))
		case "depth = 1":
			return eq(field("depth"), literal(1n))
	}
}

/** A side of Tgt over the facts `selection` keeps, projected onto `terms`. */
const tgtSide = (
	selection: ReadonlyArray<Condition>,
	terms: Arr.NonEmptyReadonlyArray<Field>
): SideDesc => ({
	relation: "Tgt",
	terms: Arr.map(terms, (t): TermDesc => ({ kind: "field", field: t })),
	selection: { conjuncts: Arr.map(selection, conditionExpr) }
})

const SOURCE_TERMS = ["p", "q", "r"] as const

/** The terms of the containment out of the target's selection: id, then the target's other terms. */
const probedTerms = (s: Sketch): Arr.NonEmptyReadonlyArray<Field> => [
	"id",
	...Arr.filter(s.terms, (t) => t !== "id")
]

/**
 * The containment out of the target's selection into Tgt over id and the target's terms, which every state keeps; none
 * where the case draws none or the target selects every row, a side whose columns are Tgt's own fields.
 */
export const probeOf = (s: Sketch): SchemaDesc["statements"] =>
	s.probed && s.target.length > 0
		? [contained(tgtSide(s.target, probedTerms(s)), tgtSide([], probedTerms(s)))]
		: []

/** The schema a sketch states: Tgt and Src, the drawn key, and the containment of Src's terms in the target. */
export const schemaOf = (s: Sketch): SchemaDesc => ({
	name: "TargetKeys",
	relations: [
		relation(
			"Tgt",
			{
				id: f.integer,
				a: f.integer,
				b: f.integer,
				c: f.integer,
				flag: f.boolean,
				depth: f.natural
			},
			["id"]
		),
		relation("Src", { sid: f.integer, p: f.integer, q: f.integer, r: f.integer }, ["sid"])
	],
	statements: [
		...(s.key === undefined ? [] : [key(tgtSide(s.key.selection, s.key.terms))]),
		contained(
			{
				relation: "Src",
				terms: nonEmpty(
					Arr.map(SOURCE_TERMS.slice(0, s.terms.length), (t): TermDesc => ({
						kind: "field",
						field: t
					}))
				),
				selection: { conjuncts: [] }
			},
			tgtSide(s.target, s.terms)
		),
		...probeOf(s)
	],
	extends: undefined
})

export const RELATIONS = nonEmpty(["Tgt", "Src"])

export type TargetKeyFeature =
	| "held by its terms"
	| "held by fixed fields"
	| "fixed to a value"
	| "fixed to a term"
	| "held by a key over a selection"
	| "held by fixed fields, a probe out of its selection reading its terms"
	| "refused, holding no key"
	| "refused, restating the primary key"
	| "committed"
	| "committed a source row"
	| "committed two target rows equal at its terms"
	| "refused by the key"
	| "refused by the containment"

/** A state's statements: Tgt's rows, then Src's, each one INSERT. */
export const statementsOf = (
	state: State,
	table: (relation: string) => string,
	column: (relation: string, role: string) => string
): ReadonlyArray<string> => {
	const tgt = tgtRows(state)
	const src = Arr.flatMap(state.src, (row, sid): ReadonlyArray<string> =>
		row === undefined ? [] : [`(${sid}, ${Arr.join(Arr.map(row, String), ", ")})`]
	)
	const columns = (relation: string, roles: ReadonlyArray<string>): string =>
		Arr.join(
			Arr.map(roles, (r) => column(relation, r)),
			", "
		)
	return [
		...(tgt.length === 0
			? []
			: [
					`INSERT INTO ${table("Tgt")} (${columns("Tgt", ["id", "a", "b", "c", "flag", "depth"])}) VALUES ${Arr.join(
						Arr.map(
							tgt,
							([id, r]) => `(${id}, ${r.a}, ${r.b}, ${r.c}, ${String(r.flag)}, ${r.depth})`
						),
						", "
					)}`
				]),
		...(src.length === 0
			? []
			: [
					`INSERT INTO ${table("Src")} (${columns("Src", ["sid", "p", "q", "r"])}) VALUES ${Arr.join(src, ", ")}`
				])
	]
}

/** A state a kept case writes: its Tgt rows at ids 0, 1 and 2 and its Src rows at sids 0 and 1. */
const kept = (
	tgt: ReadonlyArray<TgtRow | undefined>,
	src: ReadonlyArray<SrcRow | undefined>
): State => ({ tgt, src })

const row = (a: 0 | 1, b: 0 | 1, c: 0 | 1, flag: boolean, depth: 0 | 1): TgtRow => ({
	a,
	b,
	c,
	flag,
	depth
})

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const targetCases: ReadonlyArray<{
	readonly why: string
	readonly value: Sketch
	readonly reaches: ReadonlyArray<TargetKeyFeature>
}> = [
	{
		why: "a drawn key over the whole relation at id alone, a second key over the primary key's set",
		value: {
			terms: ["a"],
			target: [],
			key: { selection: [], terms: ["id"] },
			probed: false,
			states: []
		},
		reaches: ["refused, restating the primary key"]
	},
	{
		why: "a target fixed to three values, held by a key over a wider selection",
		value: {
			terms: ["a"],
			target: ["b = 0", "c = 1", "flag"],
			key: { selection: ["flag"], terms: ["a", "b", "c"] },
			probed: false,
			states: [
				kept([row(1, 0, 1, true, 0), undefined, undefined], [[1, 0, 0], undefined]),
				kept([row(1, 0, 1, false, 0), undefined, undefined], [[1, 0, 0], undefined]),
				kept(
					[row(1, 0, 1, true, 0), row(1, 1, 1, true, 0), row(1, 0, 1, false, 1)],
					[undefined, undefined]
				),
				kept([row(1, 0, 1, true, 0), row(1, 0, 1, true, 1), undefined], [undefined, undefined])
			]
		},
		reaches: [
			"held by fixed fields",
			"fixed to a value",
			"held by a key over a selection",
			"committed a source row",
			"refused by the containment",
			"refused by the key"
		]
	},
	{
		why: "a target fixed to a natural, held by a key over the whole relation",
		value: {
			terms: ["a"],
			target: ["depth = 1"],
			key: { selection: [], terms: ["a", "depth"] },
			probed: false,
			states: [
				kept([row(0, 0, 0, false, 1), row(0, 1, 1, true, 0), undefined], [[0, 1, 1], undefined]),
				kept([row(0, 0, 0, false, 0), undefined, undefined], [[0, 0, 0], undefined]),
				kept([row(0, 0, 0, false, 1), row(0, 1, 1, true, 1), undefined], [undefined, undefined])
			]
		},
		reaches: [
			"held by fixed fields",
			"fixed to a value",
			"committed two target rows equal at its terms",
			"refused by the containment",
			"refused by the key"
		]
	},
	{
		why: "a target fixed to a boolean, held by a key over the whole relation",
		value: {
			terms: ["a"],
			target: ["flag"],
			key: { selection: [], terms: ["a", "flag"] },
			probed: false,
			states: [
				kept(
					[row(1, 0, 0, true, 0), row(1, 1, 1, false, 1), undefined],
					[
						[1, 0, 0],
						[1, 1, 1]
					]
				),
				kept([row(1, 0, 0, false, 0), undefined, undefined], [[1, 0, 0], undefined]),
				kept([row(1, 0, 0, true, 0), row(1, 1, 1, true, 1), undefined], [undefined, undefined])
			]
		},
		reaches: [
			"held by fixed fields",
			"fixed to a value",
			"committed a source row",
			"refused by the containment",
			"refused by the key"
		]
	}
]

/** The property's aims (target): each kept case's value at every situation it reaches. */
export const targetAims: ReadonlyArray<readonly [Reached<TargetKeyFeature>, Gen<Sketch>]> =
	Arr.flatMap(targetCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
