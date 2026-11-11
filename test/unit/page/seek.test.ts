/**
 * The seek predicate of the window variants (packages/engine/src/lower/shapes/page/seek.ts).
 *
 * The predicate is checked exhaustively against its definition, the declared lexicographic order: for every
 * comparator sequence of one to three keys in every direction combination, each seek (strictly after or before), and
 * every tuple and boundary over a three-value domain, a direct evaluation of the emitted SQL expression agrees with the
 * declared order, and so does the empty comparison tuple of the zero-column relation, which nothing strictly follows or
 * precedes.
 *
 * A backward fetch reverses every direction of an order, and reversing twice is the order: checked on every order of
 * one to four keys.
 *
 * Oracles: the declared lexicographic order, a specification, for the predicate; each key's opposite direction for the
 * reversal.
 *
 * Features: zero to three keys.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): seek-reverse-first-key-only (a reversal of the first key alone).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { array, element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, type Order, String as Str } from "effect"
import { type Direction, directions, opposite } from "#compiler/core/order.ts"
import type { CompletedOrder } from "#compiler/ir/rel.ts"
import {
	anchoredSeek,
	reversedCompletedOrder,
	reversedOrder,
	type Seek,
	type SeekKey,
	seekPredicate
} from "#compiler/lower/shapes/page/seek.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { BinaryOperator, Expr } from "#compiler/sql/ast.ts"
import { asc, col, desc, param, types } from "#compiler/sql/build.ts"
import { assert, nonEmpty } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { isList } from "#test/support/list.ts"
import { testTypeSchema } from "#test/support/sql.ts"

/** The seek keys of `dirs`: integer key i reads column r.ki against placeholder $(i + 1). */
const keysOf = (dirs: ReadonlyArray<Direction>): ReadonlyArray<SeekKey> =>
	Arr.map(dirs, (direction, i) => ({
		direction,
		type: plainType("int4"),
		column: col("r", `k${i}`),
		boundary: param(i + 1, types.integer)
	}))

/** The installation's names a key's operators resolve through: the vector extension's schema; no key here is a
 * vector. */
const names = Object.freeze({ vectorSchema: testTypeSchema("vector_ext") })

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

/** The strict seeks of the anchored window variants. */
const seeks: Arr.NonEmptyReadonlyArray<Seek> = [anchoredSeek("before"), anchoredSeek("after")]

const expected = (seek: Seek, cmp: number): boolean => (seek.side === "follows" ? cmp > 0 : cmp < 0)

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
						box: "every direction set of zero to three keys, each seek, every tuple and boundary over three values",
						oracle: { kind: "specification", name: "the declared lexicographic order" },
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
							const predicate = seekPredicate(keysOf(dirs), seek, names)
							for (const t of tuples(m)) {
								for (const bound of tuples(m)) {
									const holds = evaluate(predicate, t, bound) === true
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

describe("window variants", () => {
	it.effect(
		"reverse every direction of an order for a backward fetch, and reversing twice is the order",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "every order of one to four keys",
						oracle: { kind: "specification", name: "each key's opposite direction" },
						suite: "unit/page/reverse",
						generator: array(element(directions), { min: 1, max: 4 }),
						literal: Formatter.format,
						coverage: noCoverage,
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
