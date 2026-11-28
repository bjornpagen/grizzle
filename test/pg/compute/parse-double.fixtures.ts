/** What the properties of parse-double.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, defined } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { Text } from "#compiler/public/compute.ts"
import { generated, float8, int4 } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { float8Text } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { regexField } from "#compiler/text/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import {
	bitsOfNumber,
	type Conversion,
	decimalTextOf
} from "#test/support/oracle/evaluate/double-text.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { inInstallation } from "#test/support/pg/compute/support.ts"
import { owning } from "#test/support/policy.ts"
import {
	baseParams,
	lowerWith,
	spelledExpr,
	testPg,
	v
} from "#test/support/unit/compute/support.ts"

export type Feature =
	| "a special spelling"
	| "an overflow to an infinity"
	| "an underflow to a zero"
	| "a negative zero"
	| "a subnormal"
	| "the greatest finite double"
	| "a tie"
	| "more than 15 significant digits"
	| "more than 17 significant digits"
	| "an exponent past 400 in magnitude"
	| "a leading plus"
	| "a bare fraction"
	| "a trailing point"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"a special spelling",
	"an overflow to an infinity",
	"an underflow to a zero",
	"a negative zero",
	"a subnormal",
	"the greatest finite double",
	"a tie",
	"more than 15 significant digits",
	"more than 17 significant digits",
	"an exponent past 400 in magnitude",
	"a leading plus",
	"a bare fraction",
	"a trailing point"
]

const signBit = 1n << 63n

const infinityBits = 0x7ff0000000000000n

const greatestFiniteBits = 0x7fefffffffffffffn

const leastNormalBits = 1n << 52n

/** A text's characters up to its exponent, and the exponent it writes, zero where it writes none. */
const splitExponent = (text: string): { readonly mantissa: string; readonly exponent: bigint } => {
	const characters = Arr.fromIterable(text)
	const at = Arr.findFirstIndex(characters, (ch) => ch === "e" || ch === "E")
	return Option.match(at, {
		onNone: () => ({ mantissa: text, exponent: 0n }),
		onSome: (e) => ({
			mantissa: Str.slice(0, e)(text),
			exponent: BigInt(Str.slice(e + 1)(text))
		})
	})
}

/** The digits of a whole number's text before its trailing zeros. */
const significantDigits = (digits: string): number => {
	const characters = Arr.fromIterable(digits)
	const last = Arr.findLastIndex(characters, (ch) => ch !== "0")
	return Option.match(last, { onNone: () => 0, onSome: (i) => i + 1 })
}

/** The situations a text and its conversion reach, read from the text's own parts and the reference's encoding. */
export const featuresOf = (text: string, conversion: Conversion): ReadonlyArray<Feature> => {
	const read = decimalTextOf(text)
	if (read?.kind !== "finite") {
		return ["a special spelling"]
	}
	const magnitude = conversion.bits & ~signBit
	const significant = significantDigits(read.value.digits.toString())
	const { mantissa, exponent } = splitExponent(text)
	const unsigned =
		Str.startsWith("+")(mantissa) || Str.startsWith("-")(mantissa)
			? Str.slice(1)(mantissa)
			: mantissa
	const facts: ReadonlyArray<readonly [Feature, boolean]> = [
		["an overflow to an infinity", magnitude === infinityBits],
		["an underflow to a zero", magnitude === 0n && read.value.digits !== 0n],
		["a negative zero", conversion.bits === signBit],
		["a subnormal", magnitude > 0n && magnitude < leastNormalBits],
		["the greatest finite double", magnitude === greatestFiniteBits],
		["a tie", conversion.tie],
		["more than 15 significant digits", significant > 15],
		["more than 17 significant digits", significant > 17],
		["an exponent past 400 in magnitude", exponent > 400n || exponent < -400n],
		["a leading plus", Str.startsWith("+")(text)],
		["a bare fraction", Str.startsWith(".")(unsigned)],
		["a trailing point", Str.endsWith(".")(mantissa)]
	]
	return Arr.map(
		Arr.filter(facts, ([, holds]) => holds),
		([feature]) => feature
	)
}

/** The host evaluator's parse of a text: the evaluation, as a generated field's check lowers it, of parseFloat8(v). */
const keyField = testPg.regex(float8Text.source, "u")

const lowered = succeeded(
	lowerWith(
		"check",
		spelledExpr(computeCore.parseFloat8(v("v", keyField)).expr),
		{ v: { kind: "column", type: keyField.scalar } },
		false,
		baseParams
	)
).root.expr

const table = predicateTable(lowered)

const patterns = ProgramPatterns.of(tablePatterns(table))

export const hostBits = (text: string): bigint => {
	const value = succeeded(
		Engine.mapError(
			compiledExpr(table)(
				{ value: undefined, column: () => text, closed: () => undefined, param: noParamLeaf },
				patterns
			),
			(stop) => new Error(Formatter.format(stop))
		),
		"the host evaluates it"
	)
	return typeof value === "number"
		? bitsOfNumber(value)
		: assert.fail(`a double, not ${Formatter.format(value)}`)
}

const Keys = relation.generated(
	"Keys",
	{ id: int4, key: regexField<string>(float8Text.source, []) },
	["id"],
	(r) => ({ value: generated(float8, Text.parseFloat8(r.key)) })
)

const parsed = schema("ParseDouble", [Keys], [])

export const parseDoubleInstallation = (schemaName: string) =>
	Effect.gen(function* () {
		const owned = owning(parsed)
		const real = compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schemaName))]
		})
		return real.ok ? real.value : yield* Effect.die(new Error(`compile ${real.error.message}`))
	})

/**
 * Installs the relation under a savepoint of the case's rolled-back transaction (compute/support.ts inInstallation),
 * stores `texts`, reads each value's bits, and rolls back to it.
 */
export const storedBits = (
	bare: PgConnection,
	database: string,
	installation: Installation,
	texts: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<bigint>, SqlError> => {
	const names = installationNamesOf(installation)
	return inInstallation(
		bare,
		installationSql(installation, database),
		Effect.gen(function* () {
			yield* bare.query(
				`INSERT INTO ${names.table(Keys)} (${names.column(Keys, "id")}, ${names.column(Keys, "key")}) SELECT r.ord, r.v FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v text)`,
				[jsonText(Arr.map(texts, (text, ord) => ({ ord, v: text })))]
			)
			const rows = yield* bare.queryValues(
				`SELECT pg_catalog.float8send(${names.column(Keys, "value")})::text FROM ${names.table(Keys)} ORDER BY ${names.column(Keys, "id")}`,
				[]
			)
			return Arr.map(rows, (row) => BigInt(`0x${Str.slice(2)(String(defined(row[0])))}`))
		})
	)
}

/**
 * qti-pie's xs:double map keys b0e98c456 fixed, kept by value since the space draws none of them (toolchain-test keep
 * found none), each refused before by the cast's bounded form: past 15 digits, past the exponent bound, the greatest
 * finite double, the least subnormal, and an overflow and an underflow.
 */
export const mapKeyDoubles: Arr.NonEmptyReadonlyArray<ReadonlyArray<string>> = [
	["1e294", "1.2345678901234567", "1.7976931348623157e308", "5e-324", "1e400", "1e-400"]
]
