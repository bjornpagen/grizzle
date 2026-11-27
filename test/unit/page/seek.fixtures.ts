/** What the properties of seek.test.ts read: its spaces, models and helpers. */

import { Array as Arr, Formatter, type Order, String as Str } from "effect"
import { type Direction } from "#compiler/core/order.ts"
import { anchoredSeek, type Seek, type SeekKey } from "#compiler/lower/shapes/page/seek.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { BinaryOperator, Expr } from "#compiler/sql/ast.ts"
import { col, param, types } from "#compiler/sql/build.ts"
import { isList } from "#test/support/list.ts"
import { testTypeSchema } from "#test/support/sql.ts"

/** The seek keys of `dirs`: integer key i reads column r.ki against placeholder $(i + 1). */
export const keysOf = (dirs: ReadonlyArray<Direction>): ReadonlyArray<SeekKey> =>
	Arr.map(dirs, (direction, i) => ({
		direction,
		type: plainType("int4"),
		column: col("r", `k${i}`),
		boundary: param(i + 1, types.integer)
	}))

/** The installation's names a key's operators resolve through: the vector extension's schema; no key here is a
 * vector. */
export const names = Object.freeze({ vectorSchema: testTypeSchema("vector_ext") })

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
		case "<<=":
		case "<=>":
		case "<>":
		case "<@":
		case ">>":
		case "@>":
		case "||":
		case "~":
		case "@@":
			throw new Error(`no operator ${op} in a seek`)
	}
}

export const evaluate = (
	e: Expr,
	tuple: ReadonlyArray<number>,
	bound: ReadonlyArray<number>
): Value => {
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
		case "attribute":
		case "array":
		case "between":
		case "call":
		case "case":
		case "cast":
		case "clock":
		case "coalesce":
		case "access":
		case "collate":
		case "domainValue":
		case "excluded":
		case "exists":
		case "field":
		case "greatest":
		case "inList":
		case "inQuery":
		case "equalsAny":
		case "isTrue":
		case "least":
		case "negate":
		case "not":
		case "plSpecial":
		case "plVar":
		case "returning":
		case "subquery":
		case "user":
		case "regclass":
		case "complement":
		case "lowerAscii":
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
export const declared =
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

export const tuples = (m: number): ReadonlyArray<ReadonlyArray<number>> =>
	m === 0 ? [[]] : Arr.flatMap(tuples(m - 1), (t) => Arr.map([0, 1, 2], (v) => [...t, v]))

export const directionSets = (m: number): ReadonlyArray<ReadonlyArray<Direction>> =>
	m === 0
		? [[]]
		: Arr.flatMap(directionSets(m - 1), (d) => [
				[...d, "asc" as const],
				[...d, "desc" as const]
			])

/** The strict seeks of the anchored window variants. */
export const seeks: Arr.NonEmptyReadonlyArray<Seek> = [
	anchoredSeek("before"),
	anchoredSeek("after")
]

export const expected = (seek: Seek, cmp: number): boolean =>
	seek.side === "follows" ? cmp > 0 : cmp < 0

/** A tuple as its values joined by commas, as an array prints. */
export const shownTuple = (tuple: ReadonlyArray<number>): string =>
	Arr.join(
		Arr.map(tuple, (x) => String(x)),
		","
	)
