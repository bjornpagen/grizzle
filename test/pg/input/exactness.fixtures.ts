/** What the properties of exactness.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	codePoint,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { bigint, double, float, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, String as Str } from "effect"
import { resultTextCasts } from "#compiler/codec/scalar.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import {
	canonicalText,
	type Carrier,
	type CarrierSpec,
	compareValues,
	isHostValue
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { decimalGen } from "#test/support/unit/values/support.ts"

/** One column type the property sends values of: its label, its type, its PostgreSQL spelling and its values. */
interface Column {
	readonly label: string
	readonly type: ScalarType
	readonly sql: string
	readonly values: Gen<unknown>
}

/**
 * A numeric(p, s) column, its values any value of its host type, and now and then one of no numeric's: a Decimal and a
 * JavaScript number or text, but numeric(p, 0)'s host value a bigint since 4da9792ba, an integer type's, from the edges
 * of its precision and past them, beside a Decimal, a number and a text, none of which it admits.
 */
const numericColumn = (precision: number, scale: number): Column => {
	const edge = 10n ** BigInt(precision)
	return {
		label: `numeric(${precision}, ${scale})`,
		type: scalarOf({ kind: "numeric", precision, scale }, {}),
		sql: `numeric(${precision},${scale})`,
		values:
			scale === 0
				? weighted<unknown>([
						[12, bigint(-2n * edge, 2n * edge)],
						[1, element<unknown>([Decimal.of("1"), 1.5, "1"])]
					])
				: weighted<unknown>([
						[12, decimalGen],
						[1, element<unknown>([1.5, "1.5"])]
					])
	}
}

/** Doubles of every kind: binary32 values, doubles between them, the edges of binary32's range, and the specials. */
const anyReal: Gen<number> = oneOf([
	float(-3.4e38, 3.4e38),
	double(-Number.MAX_VALUE, Number.MAX_VALUE),
	map(float(-3.4e38, 3.4e38), (x) => x * (1 + Number.EPSILON)),
	element([
		0.1,
		-0,
		1 + 2 ** -23,
		1 + 2 ** -24,
		2 ** -149,
		2 ** -150,
		3.4028234663852886e38,
		3.4028235677973366e38,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	])
])

export const columns: Arr.NonEmptyReadonlyArray<Column> = [
	numericColumn(5, 2),
	numericColumn(3, 0),
	numericColumn(10, 4),
	numericColumn(4, -2),
	numericColumn(2, 3),
	numericColumn(38, 12),
	{ label: "real", type: plainType("float4"), sql: "real", values: anyReal },
	{
		label: "double precision",
		type: plainType("float8"),
		sql: "double precision",
		values: oneOf<unknown>([anyReal, element<unknown>(["1.5", 1n, true])])
	},
	{
		label: "money",
		type: plainType("money"),
		sql: "money",
		values: oneOf<unknown>([
			map(bigint(-(2n ** 63n), 2n ** 63n - 1n), (n) => Money.of(n)),
			map(bigint(2n ** 63n, 2n ** 64n), (n) => Money.exact(n)),
			element<unknown>([12.5, "12.50"])
		])
	},
	{
		label: "smallint",
		type: plainType("int2"),
		sql: "smallint",
		values: oneOf<unknown>([int(-40000, 40000), element<unknown>([1.5, -0, 32767, -32768])])
	},
	{
		label: "integer",
		type: plainType("int4"),
		sql: "integer",
		values: oneOf<unknown>([
			int(-(2 ** 31), 2 ** 31 - 1),
			element<unknown>([2 ** 31, -(2 ** 31) - 1, 0.5, 1n])
		])
	},
	{
		label: "bigint",
		type: plainType("int8"),
		sql: "bigint",
		values: oneOf<unknown>([
			bigint(-(2n ** 64n), 2n ** 64n),
			element<unknown>([2n ** 63n - 1n, -(2n ** 63n), 1])
		])
	},
	{
		label: "uuid",
		type: scalarOf({ kind: "uuid" }, {}),
		sql: "uuid",
		values: oneOf<unknown>([
			uuid(4),
			map(uuid(7), (u) => Str.toUpperCase(u)),
			element<unknown>([
				"a0eebc999c0b4ef8bb6d6bb9bd380a11",
				"{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}"
			])
		])
	},
	{
		label: "date",
		type: plainType("date"),
		sql: "date",
		values: element<unknown>([
			"2026-11-11",
			"0001-01-01",
			"9999-12-31",
			"2024-02-29",
			"2023-02-29",
			"2026-1-1",
			"20261111",
			"10000-01-01"
		])
	},
	{
		label: "text",
		type: wildcardText,
		sql: "text",
		values: oneOf<unknown>([
			string(codePoint(0x20, 0x10ffff), { min: 0, max: 8 }),
			element<unknown>(["a\u0000b", "\ud800", "é", ""])
		])
	},
	{
		label: "boolean",
		type: plainType("bool"),
		sql: "boolean",
		values: oneOf<unknown>([boolean, element<unknown>([0, "true"])])
	}
]

/** One case: a column and the values it sends, each with its position. */
interface Case {
	readonly column: Column
	readonly values: ReadonlyArray<unknown>
}

export const caseGen: Gen<Case> = (source) => {
	const column = source.draw(element(columns))
	return { column, values: source.draw(array(column.values, { min: 1, max: 40 })) }
}

export type ExactFeature =
	| `${string} stored exactly`
	| `${string} refused`
	| "numeric past its scale refused"
	| "real no binary32 value refused"

/**
 * Whether the parse kept the value drawn, `drawn`, as `parsed`: equal under the carrier's own order (identity.ts
 * compareValues), a uuid drawn in its lowercase spelling, the one spelling the parse changes beside a float's -0.
 */
export const keptValue = (spec: CarrierSpec, parsed: unknown, drawnValue: unknown): boolean => {
	const value =
		spec.carrier === "uuid" && typeof drawnValue === "string"
			? Str.toLowerCase(drawnValue)
			: drawnValue
	return sameHost(spec, parsed, value)
}

/** Whether two values are one host value of the spec's carrier, by its order and its one text. */
export const sameHost = (spec: CarrierSpec, a: unknown, b: unknown): boolean => {
	const carrier: Carrier = spec.carrier
	return (
		isHostValue(carrier, a) &&
		isHostValue(carrier, b) &&
		compareValues(spec, a, b) === 0 &&
		canonicalText(spec, a) === canonicalText(spec, b)
	)
}

/** The cast a column's stored value is read back through, as a delivery casts it (codec/scalar.ts resultTextCasts). */
export const readBackSql = (column: Column): string =>
	Arr.reduce(
		resultTextCasts(column.type),
		column.type.carrier === "money" ? "((c.v::numeric)::money)" : `(c.v::${column.sql})`,
		(expr, cast) => `(${expr})::${cast}`
	)
