import { describe, it } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { array, element, int, uniqueArray } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, type Order, String as Str } from "effect"
import { type Direction, directions, opposite } from "#compiler/core/order.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import {
	anchoredSeek,
	probeKinds,
	probeSeek,
	reversedCompletedOrder,
	reversedOrder,
	type Seek,
	type SeekKey,
	seekPredicate
} from "#compiler/lower/shapes/page/seek.ts"
import { plainType } from "#compiler/scalar/compute/types.ts"
import type { BinaryOperator, Expr } from "#compiler/sql/ast.ts"
import { asc, col, desc, param, types } from "#compiler/sql/build.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { isList } from "#test/support/list.ts"

/**
 * The seek predicate and the request variants' probes (packages/engine/src/lower/shapes/page/seek.ts).
 *
 * The predicate is checked exhaustively against its definition, the declared lexicographic order: for every
 * comparator sequence of one to three keys in every direction combination, every seek (strictly or inclusively after
 * or before), and every tuple and boundary over a three-value domain, a direct evaluation of the emitted SQL
 * expression agrees with the declared order, and so does the empty comparison tuple of the zero-column relation.
 *
 * The opposite flag's probe on the anchor is checked against the delivered edge it replaces: for generated sets of
 * tuples, anchors and directions, "D holds a tuple before the page's first edge" is "D holds a tuple at or before the
 * anchor", and its mirror for a before request, each side evaluated through the seek predicates the page compiler
 * emits.
 */

/** The seek keys of `dirs`: integer key i reads column r.ki against placeholder $(i + 1). */
const keysOf = (dirs: ReadonlyArray<Direction>): ReadonlyArray<SeekKey> =>
	Arr.map(dirs, (direction, i) => ({
		direction,
		type: plainType("int4"),
		column: col("r", `k${i}`),
		boundary: param(i + 1, types.integer)
	}))

/** The extension schema a vector key's operators would name; no key here is a vector. */
const vectorSchema = "vector_ext"

/**
 * A direct evaluation of the predicate subset the seek emits: columns and placeholders over integers, the comparison
 * operators on values and on rows (lexicographically, as PostgreSQL compares rows), AND, OR and Boolean literals.
 */
type Value = number | ReadonlyArray<number> | boolean
/** A value the seek compares as one integer; a missing column or placeholder is a defect of the predicate. */
const integer = (v: Value | undefined): number => {
	if (typeof v !== "number") {
		throw new Error(`an integer operand, not ${Formatter.format(v)}`)
	}
	return v
}

/** What a comparison operator says of a lexicographic comparison's sign. */
const comparison = (op: BinaryOperator, cmp: number): boolean => {
	switch (op) {
		case "=":
			return cmp === 0
		case "<":
			return cmp < 0
		case ">":
			return cmp > 0
		case "<=":
			return cmp <= 0
		case ">=":
			return cmp >= 0
		case "%":
		case "&":
		case "|":
		case "&&":
		case "&<":
		case "&>":
		case "*":
		case "+":
		case "-":
		case "-|-":
		case "/":
		case "<<":
		case "<=>":
		case "<>":
		case "<@":
		case ">>":
		case "@>":
		case "||":
		case "~":
			throw new Error(`no operator ${op} in a seek`)
	}
}

const evaluate = (e: Expr, tuple: ReadonlyArray<number>, bound: ReadonlyArray<number>): Value => {
	switch (e.kind) {
		case "column":
			return integer(tuple[Number(Str.slice(1)(e.column))])
		case "param":
			return integer(bound[e.slot.number - 1])
		case "literal":
			if (e.value.kind !== "bool") {
				throw new Error("a Boolean literal")
			}
			return e.value.value
		case "row":
			return Arr.map(e.items, (item) => integer(evaluate(item, tuple, bound)))
		case "and":
			return Arr.every(e.args, (a) => evaluate(a, tuple, bound) === true)
		case "or":
			return Arr.some(e.args, (a) => evaluate(a, tuple, bound) === true)
		case "binary": {
			const l = evaluate(e.left, tuple, bound)
			const r = evaluate(e.right, tuple, bound)
			return comparison(
				e.op,
				lexicographic(isList(l) ? l : [integer(l)], isList(r) ? r : [integer(r)])
			)
		}
		case "array":
		case "between":
		case "call":
		case "case":
		case "cast":
		case "coalesce":
		case "collate":
		case "domainValue":
		case "excluded":
		case "exists":
		case "field":
		case "greatest":
		case "inList":
		case "inQuery":
		case "isTrue":
		case "least":
		case "mergeAction":
		case "negate":
		case "not":
		case "plSpecial":
		case "plVar":
		case "returning":
		case "subquery":
		case "user":
		case "regclass":
		case "complement":
		case "nullif":
		case "subscript":
			throw new Error(`no ${e.kind} in a seek`)
	}
}

/** A position past the shorter list compares as NaN does, less than nothing, as undefined compares in JavaScript. */
const lexicographic = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return (a[i] ?? Number.NaN) < (b[i] ?? Number.NaN) ? -1 : 1
		}
	}
	return 0
}

/** The declared order: lexicographic with each key's direction. */
const declared =
	(dirs: ReadonlyArray<Direction>): Order.Order<ReadonlyArray<number>> =>
	(a, b) => {
		for (let i = 0; i < dirs.length; i++) {
			if (a[i] !== b[i]) {
				const below = (a[i] ?? Number.NaN) < (b[i] ?? Number.NaN)
				return below === (dirs[i] === "asc") ? -1 : 1
			}
		}
		return 0
	}

const tuples = (m: number): ReadonlyArray<ReadonlyArray<number>> =>
	m === 0 ? [[]] : Arr.flatMap(tuples(m - 1), (t) => Arr.map([0, 1, 2], (v) => [...t, v]))

const directionSets = (m: number): ReadonlyArray<ReadonlyArray<Direction>> =>
	m === 0
		? [[]]
		: Arr.flatMap(directionSets(m - 1), (d) => [
				[...d, "asc" as const],
				[...d, "desc" as const]
			])

/** The strict seeks of the request variants and the inclusive ones of the probes. */
const seeks: Arr.NonEmptyReadonlyArray<Seek> = [
	{ side: "precedes", inclusive: false },
	{ side: "follows", inclusive: false },
	...Arr.map(probeKinds, probeSeek)
]

const expected = (seek: Seek, cmp: number): boolean =>
	seek.side === "follows"
		? seek.inclusive
			? cmp >= 0
			: cmp > 0
		: seek.inclusive
			? cmp <= 0
			: cmp < 0

/** A tuple as its values joined by commas, as an array prints. */
const shownTuple = (tuple: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(tuple, (x) => String(x)),
		","
	)

describe("the seek predicate", () => {
	it.effect(
		"agrees with the declared lexicographic order on every tuple, boundary, direction and seek",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: { kind: "unstated" },
						oracle: { kind: "unstated" },
						suite: "unit/page/seek",
						generator: (source) => {
							const m = source.draw(element([0, 1, 2, 3]))
							return {
								dirs: source.draw(element(nonEmpty(directionSets(m), "the direction sets"))),
								seek: source.draw(element(seeks)),
								m
							}
						},
						literal: Formatter.format,
						/** The 1, 2, 4 and 8 direction sets of zero to three keys, each with every seek. */
						limit: 15 * seeks.length,
						coverage: requiredInSpace<`${0 | 1 | 2 | 3} keys`>([
							"0 keys",
							"1 keys",
							"2 keys",
							"3 keys"
						]),
						caseHang
					},
					({ dirs, seek, m }, c) =>
						Effect.sync(() => {
							c.note(m === 0 ? "0 keys" : m === 1 ? "1 keys" : m === 2 ? "2 keys" : "3 keys")
							const predicate = seekPredicate(keysOf(dirs), seek, vectorSchema)
							for (const t of tuples(m)) {
								for (const bound of tuples(m)) {
									const holds =
										predicate === undefined ? true : evaluate(predicate, t, bound) === true
									assert.equal(
										holds,
										expected(seek, declared(dirs)(t, bound)),
										`${Arr.join(dirs, ",")} ${Formatter.format(seek)} ${shownTuple(t)} vs ${shownTuple(bound)}`
									)
								}
							}
						})
				)
			)
	)
})

/** Whether some tuple of `d` holds the predicate the compiler emits for `seek` against `bound`. */
const anyOn = (
	dirs: ReadonlyArray<Direction>,
	d: ReadonlyArray<ReadonlyArray<number>>,
	seek: Seek,
	bound: ReadonlyArray<number>
): boolean => {
	const predicate = seekPredicate(keysOf(dirs), seek, vectorSchema)
	return Arr.some(d, (t) => predicate === undefined || evaluate(predicate, t, bound) === true)
}

describe("variants and probes", () => {
	it.effect("decide the opposite flag from the anchor alone, as the delivered edge would", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/page/anchor-probe",
					draw: drawn((source) =>
						source.draw(
							((m) => (source) => ({
								dirs: source.draw(array(element(directions), { min: m, max: m })),
								d: source.draw(
									uniqueArray(
										array(int(0, 3), { min: m, max: m }),
										shownTuple,
										{ min: 0, max: 12 },
										20
									)
								),
								anchor: source.draw(array(int(0, 3), { min: m, max: m })),
								size: source.draw(int(1, 4))
							}))(source.draw(int(0, 3)))
						)
					),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2_000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ dirs, d, anchor, size }) =>
					Effect.sync(() => {
						const inOrder = Arr.sort(d, declared(dirs))
						/**
						 * An after request: the page is the first `size` tuples after the anchor in the declared order, its
						 * first edge E the least of them; hasPreviousPage is a tuple strictly before E.
						 */
						const after = anchoredSeek("after")
						const fetched = Arr.take(
							Arr.filter(inOrder, (tuple) => anyOn(dirs, [tuple], after, anchor)),
							size
						)
						const first = fetched[0]
						const edgeFlag =
							first === undefined
								? d.length > 0
								: anyOn(dirs, d, { side: "precedes", inclusive: false }, first)
						assert.equal(anyOn(dirs, d, probeSeek("atOrBefore"), anchor), edgeFlag)
						/**
						 * A before request: the page is the last `size` tuples before the anchor, its last edge L the
						 * greatest of them; hasNextPage is a tuple strictly after L.
						 */
						const before = anchoredSeek("before")
						const backward = Arr.take(
							Arr.reverse(Arr.filter(inOrder, (tuple) => anyOn(dirs, [tuple], before, anchor))),
							size
						)
						const last = backward[0]
						const lastFlag =
							last === undefined
								? d.length > 0
								: anyOn(dirs, d, { side: "follows", inclusive: false }, last)
						assert.equal(anyOn(dirs, d, probeSeek("atOrAfter"), anchor), lastFlag)
					})
			)
		)
	)

	it.effect(
		"reverse every direction of an order for a backward fetch, and reversing twice is the order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/page/reverse",
						draw: drawn(array(element(directions), { min: 1, max: 4 })),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 50,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(dirs) =>
						Effect.sync(() => {
							const items = Arr.map(dirs, (d, i) =>
								d === "asc" ? asc(col("r", `c${i}`)) : desc(col("r", `c${i}`))
							)
							assert.deepEqual(
								reversedOrder(items),
								Arr.map(dirs, (d, i) =>
									opposite(d) === "asc" ? asc(col("r", `c${i}`)) : desc(col("r", `c${i}`))
								)
							)
							const order: CompletedOrder = {
								keys: Arr.map(dirs, (dir, i) => ({ column: `c${i}`, dir }))
							}
							assert.deepEqual(reversedCompletedOrder(order), {
								keys: Arr.map(dirs, (dir, i) => ({ column: `c${i}`, dir: opposite(dir) }))
							})
							assert.deepEqual(reversedCompletedOrder(reversedCompletedOrder(order)), order)
						})
				)
			)
	)
})
