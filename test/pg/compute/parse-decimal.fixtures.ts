/** What the properties of parse-decimal.test.ts read: its spaces, models and helpers. */

import * as Engine from "@bjornpagen/grizzle-text/base/result"
import { assert, defined, nonEmpty } from "@bjornpagen/testing/assert"
import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { identity } from "#compiler/core/identity.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { predicateTable } from "#compiler/ir/expr.ts"
import { type Installation, installOptions } from "#compiler/physical/install/compile.ts"
import { compileInstallation } from "#compiler/program/install.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { decimalText, decimalTextMaxBytes, str } from "#compiler/public/text.ts"
import { computeCore } from "#compiler/scalar/compute/builders.ts"
import { compiledExpr, noParamLeaf } from "#compiler/scalar/compute/evaluate.ts"
import { ProgramPatterns, tablePatterns } from "#compiler/scalar/regex/patterns.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { numericMaxFractionDigits } from "#compiler/scalar/values/fault.ts"
import { generatedField } from "#compiler/schema/relation.ts"
import { regexField } from "#compiler/text/field.ts"
import { succeeded } from "#test/support/assert.ts"
import { installationSql } from "#test/support/compile.ts"
import { installationNamesOf, parsedSchemaName } from "#test/support/kernel/naming.ts"
import { decimalTextGen } from "#test/support/lexical.ts"
import {
	canonicalDecimal,
	type DecimalValue,
	referenceDecimal,
	significantDigits
} from "#test/support/oracle/evaluate/decimal-text.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { owning } from "#test/support/policy.ts"
import {
	baseParams,
	field,
	lowerWith,
	plainRender,
	renderSql,
	spelledExpr,
	v
} from "#test/unit/compute/support.ts"

export type Feature =
	| "past 256 integer digits"
	| "past 255 fraction digits"
	| "the form's last byte"
	| "numeric's most fraction digits"
	| "a negative zero"
	| "leading zeros"
	| "trailing zeros"
	| "a bare fraction"
	| "a trailing point"
	| "a leading plus"
	| "one value spelled twice"
	| "a pair out of order"
	| "a value stored"

export const features: Arr.NonEmptyReadonlyArray<Feature> = [
	"past 256 integer digits",
	"past 255 fraction digits",
	"the form's last byte",
	"numeric's most fraction digits",
	"a negative zero",
	"leading zeros",
	"trailing zeros",
	"a bare fraction",
	"a trailing point",
	"a leading plus",
	"one value spelled twice",
	"a pair out of order",
	"a value stored"
]

/** A pair of decimal texts, the downstream's range: a low end and a high end. */
interface Pair {
	readonly low: string
	readonly high: string
}

/** The most bytes of a low end whose value the relation stores, and the numeric(p, s) that holds every such value. */
export const storedBytes = 500

const Stored = pg.numeric(storedBytes * 2, storedBytes - 1)

/** A text's value by the reference mapping: every drawn text is a member of the grammar. */
export const valueOf = (text: string): DecimalValue =>
	defined(referenceDecimal(text), `${text} names a value`)

/** A value plus `step` units in its last place, its sign following the sum. */
const stepped = (value: DecimalValue, step: bigint): DecimalValue => {
	const signed = (value.negative ? -value.digits : value.digits) + step
	return { negative: signed < 0n, digits: signed < 0n ? -signed : signed, scale: value.scale }
}

/** A value moved a place: ten times it, or a tenth of it, exactly. */
const shifted = (value: DecimalValue, up: boolean): DecimalValue =>
	up ? { ...value, digits: value.digits * 10n } : { ...value, scale: value.scale + 1n }

/**
 * The high end of a pair beside its low end's value: the value again in its canonical spelling, with zeros before it or
 * after its point, or a plus sign; one unit either side in its last place; its negation; a place either way; or a text
 * drawn apart. Only spellings within the form's bytes are drawn.
 */
const highGen =
	(low: string): Gen<string> =>
	(source) => {
		const value = valueOf(low)
		const canonical = canonicalDecimal(value)
		const magnitude = canonicalDecimal({ ...value, negative: false })
		const neighbours = [
			canonical,
			`${value.negative ? "-" : ""}00${magnitude}`,
			`${canonical}${value.scale === 0n ? "." : ""}000`,
			value.negative ? canonical : `+${canonical}`,
			canonicalDecimal(stepped(value, 1n)),
			canonicalDecimal(stepped(value, -1n)),
			canonicalDecimal({ ...value, negative: !value.negative }),
			canonicalDecimal(shifted(value, true)),
			canonicalDecimal(shifted(value, false)),
			low
		]
		const within = Arr.filter(neighbours, (text) => text.length <= decimalTextMaxBytes)
		return source.draw(
			weighted([
				[4, element(nonEmpty(within, "the low end itself is within the form"))],
				[1, decimalTextGen]
			])
		)
	}

export const pairGen: Gen<Pair> = (source) => {
	const low = source.draw(decimalTextGen)
	return { low, high: source.draw(highGen(low)) }
}

/** The situations a text reaches, read from its own spelling and the reference's value. */
export const textFeatures = (text: string): ReadonlyArray<Feature> => {
	const value = valueOf(text)
	const significant = significantDigits(value)
	const unsigned =
		Str.startsWith("+")(text) || Str.startsWith("-")(text) ? Str.slice(1)(text) : text
	const [integer, fraction] = Str.split(".")(unsigned)
	const facts: ReadonlyArray<readonly [Feature, boolean]> = [
		["past 256 integer digits", significant.integer > 256],
		["past 255 fraction digits", significant.fraction > 255],
		["the form's last byte", text.length === decimalTextMaxBytes],
		["numeric's most fraction digits", significant.fraction === numericMaxFractionDigits],
		["a negative zero", Str.startsWith("-")(text) && value.digits === 0n],
		["leading zeros", Str.startsWith("0")(integer) && integer.length > 1],
		["trailing zeros", fraction !== undefined && Str.endsWith("0")(fraction)],
		["a bare fraction", integer.length === 0],
		["a trailing point", fraction === ""],
		["a leading plus", Str.startsWith("+")(text)]
	]
	return Arr.map(
		Arr.filter(facts, ([, holds]) => holds),
		([feature]) => feature
	)
}

/** A decimal text the parse reads total: the form's pattern within its bytes. */
const KeyText = str.bytes(decimalTextMaxBytes, regexField<string>(decimalText.source, []))

/** The host evaluator's parse of a text: the evaluation, as a check lowers it, of parseDecimal(v). */
const keyField = field(describeFieldOrThrow(KeyText, SourceLoc("KeyText", [])).desc, "text")

const lowered = succeeded(
	lowerWith(
		"check",
		spelledExpr(computeCore.parseDecimal(v("v", keyField)).expr),
		{ v: { kind: "column", type: keyField.scalar } },
		false,
		baseParams
	)
).root.expr

const table = predicateTable(lowered)

const patterns = ProgramPatterns.of(tablePatterns(table))

export const parseSql = renderSql(lowered, plainRender)

export const hostValue = (text: string): DecimalValue => {
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
	return value instanceof Decimal
		? valueOf(value.toString())
		: assert.fail(`a Decimal, not ${Formatter.format(value)}`)
}

/**
 * The downstream's range: two decimal texts, whose generated fields store whether the low end's value is below the high
 * end's and whether the two are one value, and the low end's value where a guard bounds its text within storedBytes.
 */
const holds = (predicate: unknown): unknown =>
	computeCore.cond(
		predicate,
		computeCore.literal(pg.boolean, true),
		computeCore.literal(pg.boolean, false)
	)

const Ranges = relation.generated(
	"Ranges",
	{ id: pg.integer, low: KeyText, high: KeyText },
	["id"],
	(r) => ({
		below: generatedField(
			pg.boolean,
			holds(computeCore.lt(computeCore.parseDecimal(r.low), computeCore.parseDecimal(r.high))),
			[]
		),
		same: generatedField(
			pg.boolean,
			holds(computeCore.eq(computeCore.parseDecimal(r.low), computeCore.parseDecimal(r.high))),
			[]
		),
		stored: generatedField(
			Stored,
			computeCore.when(
				computeCore.within(computeCore.octetLength(r.low), 0, storedBytes),
				() => computeCore.cast(computeCore.parseDecimal(r.low), Stored),
				computeCore.literal(Stored, "0")
			),
			[]
		)
	})
)

const parsed = schema("ParseDecimal", [Ranges], [])

/** The parse's relation compiled as an installation under the schema `schemaName`, a schema the case's own. */
export const parseDecimalInstallation = (schemaName: string) =>
	Effect.gen(function* () {
		const owned = owning(parsed)
		const real = compileInstallation(owned, {
			...installOptions(owned),
			levels: [identity.schema(parsedSchemaName(schemaName))]
		})
		return real.ok ? real.value : yield* Effect.die(new Error(`compile ${real.error.message}`))
	})

/** One stored row: its generated fields as PostgreSQL's text prints them. */
interface StoredRow {
	readonly below: string
	readonly same: string
	readonly stored: string
}

/**
 * Installs the relation in the case's transaction on `connection`, stores `pairs` and reads each row back, all of which
 * the case's rollback undoes.
 */
export const storedRows = (
	connection: PgConnection,
	database: string,
	installation: Installation,
	pairs: ReadonlyArray<Pair>
): Effect.Effect<ReadonlyArray<StoredRow>, SqlError> =>
	Effect.gen(function* () {
		const names = installationNamesOf(installation)
		const column = (name: "id" | "low" | "high" | "below" | "same" | "stored") =>
			names.column(Ranges, name)
		for (const statement of installationSql(installation, database)) {
			yield* connection.query(statement, [])
		}
		yield* connection.query(
			`INSERT INTO ${names.table(Ranges)} (${column("id")}, ${column("low")}, ${column("high")}) SELECT r.ord, r.low, r.high FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, low text, high text)`,
			[jsonText(Arr.map(pairs, (pair, ord) => ({ ord, low: pair.low, high: pair.high })))]
		)
		const rows = yield* connection.queryValues(
			`SELECT ${column("below")}::text, ${column("same")}::text, ${column("stored")}::text FROM ${names.table(Ranges)} ORDER BY ${column("id")}`,
			[]
		)
		return Arr.map(rows, (row) => ({
			below: String(row[0]),
			same: String(row[1]),
			stored: String(row[2])
		}))
	})

/** The value PostgreSQL's numeric_out text names, by the reference mapping. */
export const printed = (text: unknown): DecimalValue =>
	typeof text === "string"
		? valueOf(text)
		: assert.fail(`numeric_out text, not ${Formatter.format(text)}`)

/** Whether two values are one, by their canonical texts. */
export const sameDecimalValue = (a: DecimalValue, b: DecimalValue): boolean =>
	canonicalDecimal(a) === canonicalDecimal(b)

/** A value of 257 integer digits, one past the widest numeric(p, s) form's. */
const pastEdge = `1${Str.repeat(256)("0")}`

/**
 * The downstream's ARIA value range 91f8347df fixed, kept by value since the space draws no text past numeric(511, 255)'s
 * form (toolchain-test keep found none): texts that read as an infinity of their sign and passed the range rule, a low
 * end above its high end past 256 integer digits either side of zero, past 255 fraction digits, and one value spelled
 * twice.
 */
export const ariaRanges: Arr.NonEmptyReadonlyArray<ReadonlyArray<Pair>> = [
	[
		{ low: `2${Str.slice(1)(pastEdge)}`, high: pastEdge },
		{ low: `-${pastEdge}`, high: `-2${Str.slice(1)(pastEdge)}` },
		{
			low: `0.${Str.repeat(255)("0")}2`,
			high: `0.${Str.repeat(255)("0")}1`
		},
		{ low: pastEdge, high: `+${pastEdge}.000` }
	]
]
