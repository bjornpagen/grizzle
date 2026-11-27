/** What the property of zero-quotient.test.ts reads: its dividends, its terms of each float carrier and its SQL. */

import { assert } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, map } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter } from "effect"
import type { ExprDesc } from "#compiler/ir/desc.ts"
import { predicateTable, type ScalarExpr } from "#compiler/ir/expr.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	baseParams,
	lowerWith,
	plainRender,
	renderSql,
	testPg
} from "#test/unit/compute/support.ts"

/** What a dividend of a batch reached: its class, and its carrier. */
export type ZeroQuotientFeature =
	| "a positive dividend"
	| "a negative dividend"
	| "a dividend of 0"
	| "a dividend of -0"
	| "an infinite dividend"
	| "a NaN dividend"
	| "a subnormal dividend"
	| "a double's quotient"
	| "a real's quotient"

/** The float carriers a quotient is computed in, each by its SQL type. */
export type FloatCarrier = "float8" | "float4"

/**
 * The dividends at every class the rule turns on: the zeros, the infinities, NaN, a double's least and greatest
 * subnormals and normals, the greatest finite double and a real's least subnormal, each of either sign.
 */
const specials = [
	0,
	-0,
	1,
	-1,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	Number.NaN,
	5e-324,
	-5e-324,
	2.225073858507201e-308,
	-2.225073858507201e-308,
	2.2250738585072014e-308,
	-2.2250738585072014e-308,
	Number.MAX_VALUE,
	-Number.MAX_VALUE,
	1.401298464324817e-45,
	-1.401298464324817e-45
] as const

/** A drawn dividend: a fraction of sevenths, either sign. */
const fractionGen: Gen<number> = map(int(-7000, 7000), (n) => n / 7)

/**
 * A batch: its carrier, and its dividends, every special and zero to twenty drawn fractions, each held in that carrier
 * (Math.fround for a real), so every class the rule turns on is in every batch.
 */
export const batchGen: Gen<{
	readonly carrier: FloatCarrier
	readonly dividends: ReadonlyArray<number>
}> = (source) => {
	const carrier = source.draw(element(["float8", "float4"] as const))
	const drawn = [...specials, ...source.draw(array(fractionGen, { min: 0, max: 20 }))]
	return { carrier, dividends: carrier === "float4" ? Arr.map(drawn, Math.fround) : drawn }
}

/** The least normal magnitude of each carrier: below it, a nonzero value is subnormal. */
const leastNormal: { readonly [C in FloatCarrier]: number } = {
	float8: 2.2250738585072014e-308,
	float4: 1.1754943508222875e-38
}

/** The class a dividend of `carrier` is of. */
export const classOf = (x: number, carrier: FloatCarrier): ZeroQuotientFeature =>
	Number.isNaN(x)
		? "a NaN dividend"
		: !Number.isFinite(x)
			? "an infinite dividend"
			: Object.is(x, -0)
				? "a dividend of -0"
				: x === 0
					? "a dividend of 0"
					: Math.abs(x) < leastNormal[carrier]
						? "a subnormal dividend"
						: x > 0
							? "a positive dividend"
							: "a negative dividend"

/**
 * grizzle's rule for a float quotient by zero (registry.ts Totality ieee): the infinity of the dividend's sign, NaN
 * over a zero or NaN dividend, whichever zero divides.
 */
export const byZero = (x: number): number =>
	Number.isNaN(x) || x === 0
		? Number.NaN
		: x > 0
			? Number.POSITIVE_INFINITY
			: Number.NEGATIVE_INFINITY

/** A float as its identity names it: -0 apart from 0, every NaN one. */
export const identityOf = (v: number): string => (Object.is(v, -0) ? "-0" : String(v))

/** A float PostgreSQL's text cast wrote, as a value of `carrier`. */
export const readFloat = (text: string, carrier: FloatCarrier): number =>
	carrier === "float4" ? Math.fround(Number(text)) : Number(text)

const quotient: ExprDesc = {
	kind: "compute",
	fn: "div",
	args: [
		{ kind: "var", var: "x" },
		{ kind: "var", var: "y" }
	]
}

/** Num.div(x, y) over two columns of `carrier`, as a query lowers it, a check refusing float arithmetic. */
const termOf = (carrier: FloatCarrier): ScalarExpr => {
	const column = {
		kind: "column",
		type: (carrier === "float8" ? testPg.double : testPg.real).scalar
	} as const
	return succeeded(
		lowerWith("query", quotient, { x: column, y: column }, false, baseParams),
		`Num.div lowers in a query over two ${carrier} columns`
	).root.expr
}

/** Each carrier's quotient term, lowered once. */
const terms: { readonly [C in FloatCarrier]: ScalarExpr } = {
	float8: termOf("float8"),
	float4: termOf("float4")
}

/** Each carrier's SQL of its term over a batch's rows, `$1` their JSON, each float its text, in their order. */
export const quotientSql = (carrier: FloatCarrier): string =>
	`SELECT (${renderSql(terms[carrier], plainRender)})::text FROM jsonb_to_recordset($1::text::jsonb) AS r0(ord int4, x ${carrier}, y ${carrier}) ORDER BY r0.ord`

/** The two divisors, -0 then 0: equal under PostgreSQL's equality and two values. */
const zeros = [-0, 0] as const

/** A batch's rows: each dividend over -0, then over 0. */
export const rowsOf = (
	dividends: ReadonlyArray<number>
): ReadonlyArray<{ readonly x: number; readonly y: number }> =>
	Arr.flatMap(dividends, (x) => Arr.map(zeros, (y) => ({ x, y })))

/** The rows as the SQL's JSON reads them, each float as its text, which float8in and float4in read back exactly. */
export const rowsJson = (
	rows: ReadonlyArray<{ readonly x: number; readonly y: number }>
): ReadonlyArray<{ readonly ord: number; readonly x: string; readonly y: string }> =>
	Arr.map(rows, (row, ord) => ({ ord, x: identityOf(row.x), y: identityOf(row.y) }))

/** The host evaluator's quotient of a row (scalar/compute/evaluate.ts), over the term the SQL holds. */
export const hostQuotient = (
	carrier: FloatCarrier,
	row: { readonly x: number; readonly y: number }
): number => {
	const table = predicateTable(terms[carrier])
	const value = succeeded(
		compiledExpr(table)(
			{
				value: undefined,
				column: (ref) => (ref.name === "x" ? row.x : row.y),
				closed: () => undefined,
				param: noParamLeaf
			},
			ProgramPatterns.of(tablePatterns(table))
		),
		"the host evaluates a float quotient"
	)
	return typeof value === "number"
		? value
		: assert.fail(`the host's quotient is a float, not ${Formatter.format(value)}`)
}
