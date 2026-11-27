/** What the properties of lexical.test.ts read: its spaces, models and helpers. */

import { Formatter } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { int8ExactDigits } from "#compiler/ir/carriers.ts"
import { datePartSlices, dayNumber, toCalendarDate } from "#compiler/ir/date.ts"
import { parseDoubleForm } from "#compiler/lower/conservative/expr/parse-double.ts"
import { toFloat } from "#compiler/scalar/compute/cast.ts"
import { formOctets, formSource, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { convertDouble } from "#compiler/scalar/values/float.ts"
import type { Expr, TypeRef } from "#compiler/sql/ast.ts"
import { binary, cast, lit, numericType, tableCol, types } from "#compiler/sql/build.ts"
import { dateOfText } from "#compiler/sql/lexical.ts"
import { printExpr } from "#compiler/sql/print.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { succeeded } from "#test/support/assert.ts"
import { sameValue } from "#test/support/lexical.ts"

export const roundDouble = (negative: boolean, num: bigint, den: bigint): number =>
	toFloat(negative, num, den, "float8")

/** The SQL type a target's cast names, numeric's typmod included. */
const targetType = (
	target: Exclude<LexicalTarget, { readonly kind: "date" | "doubleText" }>
): TypeRef => {
	switch (target.kind) {
		case "integer":
			return target.carrier === "int2"
				? types.smallint
				: target.carrier === "int4"
					? types.integer
					: types.bigint
		case "decimal":
			return numericType(target.typmod.precision, target.typmod.scale)
		case "double":
			return types.double
		case "boolean":
			return types.boolean
		case "decimalText":
			return types.numeric
		case "exactInteger":
			return target.digits <= int8ExactDigits ? types.bigint : types.numeric
	}
}

/**
 * The parse of the column `t` as grizzle prints it, as text: the cast, for a date its day number after 0001-01-01,
 * which reads no DateStyle, and for a double's text Text.parseDouble's form.
 */
const parsedOf = (target: LexicalTarget, t: Expr): Expr => {
	switch (target.kind) {
		case "date":
			return binary(
				"-",
				dateOfText(t, datePartSlices),
				cast(lit.text("0001-01-01", types.text), types.date)
			)
		case "doubleText":
			return parseDoubleForm(t)
		case "integer":
		case "exactInteger":
		case "decimal":
		case "double":
		case "boolean":
		case "decimalText":
			return cast(t, targetType(target))
	}
}

export const parseSql = (target: LexicalTarget): string =>
	printExpr(cast(parsedOf(target, tableCol("t")), types.text))

/** The ARE of a target's form, as the text analysis translates it for PostgreSQL. */
export const areOf = (target: LexicalTarget): string =>
	succeeded(analyzeText([{ source: formSource(target), flags: "u" }], SourceLoc("lexicalForm", [])))
		.members[0].are

/** Whether PostgreSQL's text of a parsed value is the host's value of the member. */
export const agrees = (target: LexicalTarget, text: string, value: unknown): boolean => {
	switch (target.kind) {
		case "integer":
		case "exactInteger":
			return typeof value === "bigint" && BigInt(text) === value
		case "decimal":
		case "decimalText":
			return value instanceof Decimal && Decimal.fromOutput(text).equals(value)
		case "double":
		case "doubleText":
			return sameValue(convertDouble(text), value)
		case "boolean":
			return value === (text === "true")
		case "date":
			return (
				typeof value === "string" && Number(text) === dayNumber(succeeded(toCalendarDate(value)))
			)
	}
}

/** PostgreSQL's membership of `t` in a target's form: a match of its ARE, `$2`, within its byte bound, if any. */
export const memberSql = (target: LexicalTarget): string => {
	const match = "u.t COLLATE pg_catalog.pg_c_utf8 ~ $2::text"
	const octets = formOctets(target)
	return octets === undefined ? match : `(${match} AND pg_catalog.octet_length(u.t) <= ${octets})`
}

/** A target's key, which groups a batch's candidates into one statement per target. */
export const targetKey = (target: LexicalTarget): string => Formatter.format(target)
