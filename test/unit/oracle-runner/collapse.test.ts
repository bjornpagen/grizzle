/**
 * The reference's collapses leave a tie across spellings to PostgreSQL (test/support/oracle/reference/values.ts).
 *
 * A collapse keeps one of natively equal values: a projection's DISTINCT and a group key keep whichever row they meet
 * first, and min and max return one of their arguments, as an aggregate and as a partition's window function alike.
 * Where the equal values are spelled otherwise (a numeric at other display scales, a float zero of either sign), which
 * spelling the answer holds is PostgreSQL's choice, so the reference's value there may be any of them and no other:
 * over facts drawn among a few value classes of several spellings each, every collapsed value's spellings are exactly
 * those of the facts' values natively equal to it, by an oracle that classes and orders the facts' literals itself.
 */
import { describe, it } from "@effect/vitest"
import { explore, type Kept, sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, element, type Gen, int, shuffled, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import { DecimalText, decimalPayload } from "#compiler/ir/decimal.ts"
import { type TypedLiteral, OpId } from "#compiler/ir/expr.ts"
import { conservativeMeta, type RelNode } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { CarrierValue } from "#compiler/scalar/compute/literal.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { float8, int4, int8, numeric } from "#test/support/oracle/gen/domain.ts"
import type { GenRelation } from "#test/support/oracle/gen/schema.ts"
import { indices, nonEmptyList } from "#test/support/oracle/pick.ts"
import { noBindings, Reference, unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { possibleValues, type Value } from "#test/support/oracle/reference/values.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

const collapses = ["distinct", "group key", "min", "max", "window min", "window max"] as const
type Collapse = (typeof collapses)[number]

const carriers = ["numeric", "float8"] as const
type Carrier = (typeof carriers)[number]

type Feature = `${Collapse} across ${Carrier} spellings`

/**
 * The value classes of each carrier, every spelling of a class natively equal: numerics at other display scales, and a
 * float zero of either sign beside a value of one spelling.
 */
const classes: Readonly<Record<Carrier, ReadonlyArray<ReadonlyArray<TypedLiteral>>>> = {
	numeric: Arr.map([["1", "1.0", "1.00"], ["2.5", "2.50"], ["3"]], (spellings) =>
		Arr.map(spellings, (text): TypedLiteral => ({
			kind: "numeric",
			value: succeeded(DecimalText.make(text))
		}))
	),
	float8: Arr.map([[0, -0], [1.5], [-2]], (values) =>
		Arr.map(values, (value): TypedLiteral => ({ kind: "float", value }))
	)
}

const typeOf: Readonly<Record<Carrier, ScalarType>> = { numeric, float8 }

/** A drawn fact's value: a class of the case's carrier and one of its spellings. */
interface FactSketch {
	readonly cls: number
	readonly spelling: number
}

interface CollapseSketch {
	readonly collapse: number
	readonly carrier: number
	readonly facts: ReadonlyArray<FactSketch>
}

const pick = <A>(items: ReadonlyArray<A>, at: number): A => {
	const item = items[at % items.length]
	if (item === undefined) {
		throw new Error(`nothing to pick at ${at}`)
	}
	return item
}

/**
 * The oracle's own reading of a literal: its spelling as PostgreSQL writes it, its class under native equality, and
 * its place in the type's order.
 */
const spellingOf = (l: TypedLiteral): string => {
	if (l.kind === "numeric") {
		return decimalPayload(l.value)
	}
	if (l.kind === "float") {
		return Object.is(l.value, -0) ? "-0" : String(l.value)
	}
	throw new Error(`a ${l.kind} literal among the drawn values`)
}
const classOf = (l: TypedLiteral): string => String(rankOf(l))
const rankOf = (l: TypedLiteral): number => {
	if (l.kind === "numeric") {
		return Number(decimalPayload(l.value))
	}
	if (l.kind === "float") {
		return l.value === 0 ? 0 : l.value
	}
	throw new Error(`a ${l.kind} literal among the drawn values`)
}

/** A reference value's spellings: those a merged value may hold, or a stated value's own. */
const spellingsOf = (v: Value): ReadonlyArray<string> => {
	const values = possibleValues(v)
	if (values === undefined) {
		throw new Error("the reference declined a collapsed value")
	}
	return Arr.map(values, (x: CarrierValue) => {
		if (x instanceof Decimal) {
			return x.toString()
		}
		if (typeof x === "number") {
			return Object.is(x, -0) ? "-0" : String(x)
		}
		throw new Error(
			`the reference holds ${Formatter.format(x)} where a numeric or a float was expected`
		)
	})
}

const sorted = (items: Iterable<string>): ReadonlyArray<string> =>
	Arr.sort([...new Set(items)], Order.String)

/** The case: R(k int4, x) keyed by k holding the drawn values at k = 0, 1, ..., and the collapse over it. */
const resolve = (s: CollapseSketch) => {
	const carrier = pick(carriers, s.carrier)
	const collapse = pick(collapses, s.collapse)
	const type = typeOf[carrier]
	const values = Arr.map(s.facts, (f) => pick(pick(classes[carrier], f.cls), f.spelling))
	return { carrier, collapse, type, values }
}

type Resolved = ReturnType<typeof resolve>

/** The root of the collapse over R's base, and the column holding the collapsed value. */
const rootOf = (
	q: Q,
	base: RelNode,
	r: Resolved
): { readonly root: RelNode; readonly column: string } => {
	const x = () => q.col(base, "x")
	switch (r.collapse) {
		case "distinct":
			return { root: q.project(base, [["x", "x"]], conservativeMeta), column: "x" }
		case "group key":
			return {
				root: q.group(
					base,
					["k", "x"],
					["x"],
					[{ name: "n", fn: "count", op: "count", args: [], type: int8 }],
					conservativeMeta
				),
				column: "x"
			}
		case "min":
		case "max":
			return {
				root: q.group(
					base,
					["k", "x"],
					[],
					[{ name: "m", fn: r.collapse, op: r.collapse, args: ["x"], type: r.type }],
					conservativeMeta
				),
				column: "m"
			}
		case "window min":
		case "window max":
			return {
				root: q.node({
					kind: "Window",
					input: base,
					partition: [],
					order: { keys: [] },
					fn: r.collapse === "window min" ? "min" : "max",
					op: OpId(r.collapse === "window min" ? "min" : "max"),
					args: [x()],
					filter: undefined,
					frame: undefined,
					out: "w",
					rule: "a partition's extreme",
					heading: [...base.heading, { name: "w", type: r.type }],
					loc: undefined,
					meta: conservativeMeta
				}),
				column: "w"
			}
	}
}

/**
 * The spellings each collapsed value must hold, as the oracle derives them from the facts: per class for a set or a
 * group key, the extreme's class for min and max, once per fact for a window.
 */
const expectedOf = (r: Resolved): ReadonlyArray<ReadonlyArray<string>> => {
	const spellingsIn = (cls: string) =>
		sorted(
			Arr.map(
				Arr.filter(r.values, (v) => classOf(v) === cls),
				spellingOf
			)
		)
	switch (r.collapse) {
		case "distinct":
		case "group key":
			return Arr.map(sorted(Arr.map(r.values, classOf)), spellingsIn)
		case "min":
		case "max":
		case "window min":
		case "window max": {
			if (r.values.length === 0) {
				return []
			}
			const ranks = Arr.map(r.values, rankOf)
			const extreme = Str.endsWith("min")(r.collapse) ? Math.min(...ranks) : Math.max(...ranks)
			const tied = spellingsIn(String(extreme))
			return Str.startsWith("window")(r.collapse) ? Arr.map(r.values, () => tied) : [tied]
		}
	}
}

const factGen: Gen<FactSketch> = (source) => ({
	cls: source.draw(int(0, 5)),
	spelling: source.draw(int(0, 5))
})

/** A fact of one of the classes `among`, in any spelling. */
const factOf =
	(among: Arr.NonEmptyReadonlyArray<number>): Gen<FactSketch> =>
	(source) => ({ cls: source.draw(element(among)), spelling: source.draw(int(0, 5)) })

const sketchGen: Gen<CollapseSketch> = (source) => ({
	collapse: source.draw(int(0, collapses.length - 1)),
	carrier: source.draw(int(0, carriers.length - 1)),
	facts: source.draw(array(factGen, { min: 0, max: 5 }))
})

/**
 * Whether a fact of rank `rank` leaves the value a collapse keeps at the class of rank `kept`: a set and a group key
 * keep every class, min keeps it beside no class below it, and max beside no class above it.
 */
const leaves = (collapse: Collapse, kept: number, rank: number): boolean => {
	switch (collapse) {
		case "distinct":
		case "group key":
			return true
		case "min":
		case "window min":
			return rank >= kept
		case "max":
		case "window max":
			return rank <= kept
	}
}

/**
 * A collapse that keeps a class spelled two ways, over any collapse and carrier: two spellings of one class of several,
 * then up to three facts of classes that leave the collapse's value at that class, in any order. Each case reaches its
 * own collapse and carrier across spellings, where the population reaches a float8 extreme about one case in 240, a
 * numeric max about one in 170, and a float8 set or group key about one in 95.
 */
const spelledTwiceGen: Gen<CollapseSketch> = (source) => {
	const collapse = source.draw(int(0, collapses.length - 1))
	const carrier = source.draw(int(0, carriers.length - 1))
	const of = classes[pick(carriers, carrier)]
	const classesWhere = (keep: (c: number) => boolean, what: string) =>
		nonEmptyList(Arr.filter(indices(of.length), keep), what)
	const rankAt = (c: number) => rankOf(pick(pick(of, c), 0))
	const cls = source.draw(
		element(classesWhere((c) => pick(of, c).length > 1, "the classes of several spellings"))
	)
	const leaving = classesWhere(
		(c) => leaves(pick(collapses, collapse), rankAt(cls), rankAt(c)),
		"the classes that leave the collapse's value"
	)
	const count = pick(of, cls).length
	const first = source.draw(int(0, count - 1))
	const facts: ReadonlyArray<FactSketch> = [
		{ cls, spelling: first },
		{ cls, spelling: (first + source.draw(int(1, count - 1))) % count },
		...source.draw(array(factOf(leaving), { min: 0, max: 3 }))
	]
	return {
		collapse,
		carrier,
		facts: source.draw(shuffled(facts, { min: facts.length, max: facts.length }))
	}
}

/** The population, and beside it, two cases in five, a collapse that keeps a class spelled two ways. */
const collapseDrawGen: Gen<CollapseSketch> = weighted([
	[3, sketchGen],
	[2, spelledTwiceGen]
])

/** Planted: for every collapse and carrier, two facts of one class in two spellings (1.0 and 1.00, 0 and -0). */
const kept: ReadonlyArray<Kept<CollapseSketch, Feature>> = Arr.flatMap(collapses, (collapse, c) =>
	Arr.map(carriers, (carrier, k): Kept<CollapseSketch, Feature> => ({
		note: `${collapse} over two spellings of one ${carrier}`,
		sketch: {
			collapse: c,
			carrier: k,
			facts:
				carrier === "numeric"
					? [
							{ cls: 0, spelling: 1 },
							{ cls: 0, spelling: 2 }
						]
					: [
							{ cls: 0, spelling: 0 },
							{ cls: 0, spelling: 1 }
						]
		},
		draws: "",
		reaches: [`${collapse} across ${carrier} spellings`]
	}))
)

const key = (spellings: ReadonlyArray<string>) => Arr.join(spellings, " ")

describe("the reference's collapses", () => {
	it.effect(
		"hold, for every collapsed value, exactly the spellings of the natively equal values it collapsed",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/oracle-runner/collapse",
						draw: sketched(collapseDrawGen, resolve),
						literal: Formatter.format,
						features: features<Feature>(
							Arr.flatMap(collapses, (collapse) =>
								Arr.map(carriers, (carrier): Feature => `${collapse} across ${carrier} spellings`)
							)
						),
						kept,
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						steering: { kind: "mutate", cases: 300, sense: notesOnly },
						caseHang: Duration.minutes(2)
					},
					(r, c) =>
						Effect.sync(() => {
							const relation: GenRelation = {
								name: "R",
								columns: [
									{ name: "k", type: int4 },
									{ name: "x", type: r.type }
								],
								primaryKey: ["k"],
								keys: [],
								mutable: false
							}
							const q = new Q()
							const base = q.base(
								{ name: relation.name, heading: relation.columns, primaryKey: relation.primaryKey },
								conservativeMeta
							)
							const { root, column } = rootOf(q, base, r)
							const reference = Reference.of(q.build(root).dag, {
								schema: { name: "collapse", relations: [relation], closed: [], containments: [] },
								facts: {
									R: Arr.map(r.values, (v, i): ReadonlyArray<TypedLiteral> => [
										{ kind: "int", value: BigInt(i) },
										v
									])
								},
								params: {},
								observer: unobserved
							})
							const rel = reference.eval(root, noBindings)
							const at = Option.getOrThrowWith(
								Arr.findFirstIndex(rel.heading, (h) => h.name === column),
								() => new Error(`the collapse has no column ${column}`)
							)
							const actual = Arr.map(rel.rows, (row) => {
								const v = row[at]
								if (v === undefined) {
									throw new Error(`a row of the collapse has no column ${column}`)
								}
								return sorted(spellingsOf(v))
							})
							const expected = expectedOf(r)
							assert.deepEqual(
								Arr.sort(Arr.map(actual, key), Order.String),
								Arr.sort(Arr.map(expected, key), Order.String)
							)
							if (Arr.some(expected, (spellings) => spellings.length > 1)) {
								c.note(`${r.collapse} across ${r.carrier} spellings`)
							}
						})
				)
			)
	)
})
