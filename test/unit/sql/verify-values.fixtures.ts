/** What the properties of verify-values.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { maxIdentifierBytes } from "#compiler/core/identity.ts"
import type { Expr, SqlStatement, TypeRef } from "#compiler/sql/ast.ts"
import { provedSelect, target, types } from "#compiler/sql/build.ts"
import { auditStatementViolations } from "#test/support/oracle/verify/sql.ts"

/** The rules the statement audit reports of a statement. */
export const rules = (statement: SqlStatement): ReadonlyArray<string> =>
	Arr.map(auditStatementViolations(statement), (v) => v.rule)

/** A one-row query selecting `e`. */
export const selecting = (e: Expr): SqlStatement =>
	provedSelect("oneRow", [target(e)], [], undefined)

/** A numeric literal spelled `text` as drawn, built as the AST holds it: lit.decimal spells only a value's parts. */
export const decimalSpelled = (text: string): Expr => ({
	kind: "literal",
	value: { kind: "decimal", value: text },
	type: types.numeric
})

/** Text of code units around the edges: ASCII, a two-byte letter, a pair, a lone high or low surrogate, NUL. */
export const unitsGen = (maxLength: number): Gen<string> =>
	map(
		array(element(["a", "z", "_", "é", "😀", "\ud800", "\udc00", "\u0000"] as const), {
			min: 0,
			max: maxLength
		}),
		(parts) => Arr.join(parts, "")
	)

/** The UTF-8 length of a text, in bytes. */
export const utf8 = (text: string): number => new TextEncoder().encode(text).length

/**
 * A name around the identifier byte limit, built to its drawn UTF-8 length: two bytes short of the limit to two past
 * it, of two-byte letters (é) and one-byte ones, the two-byte count drawn too. Each two-byte letter makes the name one
 * code unit shorter than its bytes, so a name past the limit in bytes and within it in code units is in reach.
 */
export const byteEdgeGen: Gen<string> = (source) => {
	const bytes = source.draw(int(maxIdentifierBytes - 2, maxIdentifierBytes + 2))
	const twoByte = source.draw(int(0, Math.floor(bytes / 2)))
	return `${Str.repeat(twoByte)("é")}${Str.repeat(bytes - 2 * twoByte)("a")}`
}

/** An integer type's name. */
type IntegerName = "smallint" | "integer" | "bigint"

/** The bounds of each integer type. */
const bounds: Arr.NonEmptyReadonlyArray<readonly [IntegerName, TypeRef, bigint, bigint]> = [
	["smallint", types.smallint, -32768n, 32767n],
	["integer", types.integer, -2147483648n, 2147483647n],
	["bigint", types.bigint, -9223372036854775808n, 9223372036854775807n]
]

/** An integer type, one of its ends, and a step of up to two from it: the bounds and one and two past them. */
export const integerGen: Gen<
	readonly [readonly [IntegerName, TypeRef, bigint, bigint], 0 | 1, number]
> = (source) =>
	[
		source.draw(element(bounds)),
		source.draw(element([0, 1] as const)),
		source.draw(int(-2, 2))
	] as const

/** What an integer case reached: the type's bound, within or past it. */
export type IntegerFeature = `${IntegerName} ${"within" | "past"}`
