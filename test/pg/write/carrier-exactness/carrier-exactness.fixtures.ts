/** What the property of carrier-exactness.test.ts reads: the carried types, a case's values, its statements. */
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { array, codePoint, element, type Gen, oneOf, string } from "@bjornpagen/testing/gen"
import { double, float } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { scalarCodec } from "#compiler/codec/scalar.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import {
	type PhysicalNames,
	sessionTypeRef,
	variantAttributes,
	variantAttributeType,
	variantTagAttribute
} from "#compiler/ir/physical.ts"
import { type Carrier, carriers, type ScalarType } from "#compiler/ir/scalar.ts"
import { roleDefaultSettings } from "#compiler/physical/ddl/roles.ts"
import { anyNumeric as computedNumeric } from "#compiler/scalar/compute/types.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import type { ColumnDefinition } from "#compiler/sql/ast.ts"
import { cast, col, provedSelect, target, types } from "#compiler/sql/build.ts"
import { printStatement, printType } from "#compiler/sql/print.ts"
import { installedTypes } from "#compiler/sql/type-schemas.ts"
import {
	carrierRead,
	carrierStash,
	CarrierSupply,
	type WriteCarrier
} from "#compiler/write/carriers/carriers.ts"
import { succeeded } from "#test/support/assert.ts"
import { productionNames } from "#test/support/kernel/naming.ts"
import { type SqlNames, textRows, wireSql } from "#test/support/pg/codec/support.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { kindCodes } from "#test/support/unit/codec/support.ts"
import { decoded, written } from "#test/support/unit/codec/wild.fixtures.ts"
import { decimalGen } from "#test/support/unit/values/support.ts"

/** A carried type: a scalar type a carrier column holds a value of, and its values. */
interface Carried {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
}

/** The spellings a double's text trips on: both zeros, the least subnormal, the greatest, a third, NaN, the infinities. */
const doubleEdges = [
	0,
	-0,
	5e-324,
	-5e-324,
	Number.MAX_VALUE,
	0.1,
	1 / 3,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
] as const

/** The spellings a real's text trips on: both zeros, the least subnormal binary32, one past 1, the greatest. */
const realEdges = [
	0,
	-0,
	2 ** -149,
	1 + 2 ** -23,
	Math.fround(3.4028234663852886e38),
	Math.fround(0.1),
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
] as const

/**
 * The texts an array's text form quotes or escapes: empty, the array's own punctuation, a backslash, a double quote,
 * whitespace at either end, NULL spelled as a text, control characters, a composed and a decomposed é, a code point
 * past the BMP, U+FFFD and U+10FFFF.
 */
const textEdges = [
	"",
	"{",
	"}",
	",",
	"{a,b}",
	'"',
	"\\",
	'\\"',
	" ",
	" padded ",
	"NULL",
	"null",
	"\t\n\r",
	"\u0001",
	"(1,2)",
	"é",
	"é",
	"𝔘",
	"�",
	"\u{10ffff}"
] as const

/** Any text but NUL: every plane, or a spelling the array's text form quotes. */
const anyText: Gen<string> = oneOf([
	string(
		oneOf([
			codePoint(0x1, 0x7f),
			codePoint(0x80, 0xd7ff),
			codePoint(0xe000, 0xffff),
			codePoint(0x1_00_00, 0x10_ff_ff)
		]),
		{ min: 0, max: 12 }
	),
	element(textEdges)
])

/**
 * Numerics of any scale, display scale kept (1.10 is not 1.1), NaN and the infinities among them: a computed numeric's
 * values (scalar/compute/types.ts anyNumeric), which a carrier of a query's computed column holds.
 */
const anyNumericValue: Gen<Decimal> = oneOf([
	decimalGen,
	element(
		Arr.map(
			["1.10", "-0.000", "0", "1e-20", "123456789012345678901234567890.123456789"] as const,
			(text) => Decimal.of(text)
		)
	)
])

/**
 * The values of each carrier past the codec catalogue's (test/support/unit/codec/wild.fixtures.ts written): the edges of a
 * float's text, numeric of no typmod, and text of any characters.
 */
const edges: Readonly<Partial<Record<Carrier, ReadonlyArray<Carried>>>> = {
	float4: [{ label: "float4 edges", type: decodedType("float4"), values: element(realEdges) }],
	float8: [
		{
			label: "float8 edges",
			type: decodedType("float8"),
			values: oneOf([element(doubleEdges), double(-Number.MAX_VALUE, Number.MAX_VALUE)])
		},
		{ label: "float8 at binary32", type: decodedType("float8"), values: float(-1e30, 1e30) }
	],
	numeric: [{ label: "numeric of no typmod", type: computedNumeric, values: anyNumericValue }],
	text: [{ label: "text of any characters", type: decodedType("text"), values: anyText }]
}

/** A descriptor of the codec catalogue's form decoded, with its values (test/support/unit/codec/wild.fixtures.ts decoded). */
function decodedCarried(w: Parameters<typeof decoded>[0]): Carried {
	const d = decoded(w)
	return { label: d.label, type: d.type, values: d.live }
}

/** The type of a carrier's first descriptor in the codec catalogue. */
function decodedType(carrier: Carrier): ScalarType {
	return decoded(written[carrier][0]).type
}

/**
 * Every carried type, of every carrier: each descriptor of the codec catalogue (keyed by carrier, so a new carrier is
 * listed there), its Live values, and the edges of its text (`edges`).
 */
export const catalogue: Arr.NonEmptyReadonlyArray<Carried> = nonEmpty(
	Arr.flatMap(carriers, (carrier): ReadonlyArray<Carried> => [
		...Arr.map(written[carrier], decodedCarried),
		...(edges[carrier] ?? [])
	]),
	"the carried types"
)

/** A case: a carried type, by its label, and the values one carrier holds of it, none to many. */
export interface ExactCase {
	readonly label: string
	readonly values: ReadonlyArray<unknown>
}

/** A case: a batch of every carried type's values, none to many of each, so every case carries every type. */
export const exactGen: Gen<ReadonlyArray<ExactCase>> = (source) =>
	Arr.map(catalogue, (c) => ({
		label: c.label,
		values: source.draw(array(c.values, { min: 0, max: 40 }))
	}))

/** The carried type a case names, by its label. */
export const carriedOf = (label: string): Carried =>
	Option.getOrThrowWith(
		Arr.findFirst(catalogue, (c) => c.label === label),
		() => new Error(`no carried type ${label}`)
	)

/** A carried type a case reached, by its label, and an empty carrier. */
export type ExactFeature = `carries ${string}` | "an empty carrier"

/**
 * The login defaults a value's text depends on (sql/ast.ts textParameters): extra_float_digits, DateStyle, bytea_output
 * and the locale categories, at the values every login holds (physical/ddl/roles.ts roleDefaultSettings).
 */
const textForms: ReadonlySet<string> = new Set([
	"extra_float_digits",
	"DateStyle",
	"bytea_output",
	"lc_monetary",
	"lc_numeric",
	"lc_time"
])

/**
 * A case's session as a login's is: each login default a value's text depends on, set for the transaction; and the
 * names its types are named by: a schema of the case's own, under a name `allocate` gives, for its installation's
 * types, and the vector extension's.
 */
export const loginLike = (db: CaseSession, allocate: (label: string) => Effect.Effect<string>) =>
	Effect.gen(function* () {
		for (const setting of roleDefaultSettings) {
			if ("value" in setting && textForms.has(setting.parameter)) {
				yield* db.values("SELECT pg_catalog.set_config($1, $2, true)", [
					setting.parameter,
					setting.value
				])
			}
		}
		const schema = yield* allocate("carried")
		yield* db.values(`CREATE SCHEMA ${quoteIdent(schema)}`, [])
		const vector = String(
			(yield* db.values(
				"SELECT n.nspname::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
				[]
			))[0]?.[0]
		)
		const base = productionNames("Carried", { kind: "declared" }, vector, kindCodes)
		const names: PhysicalNames = {
			...base,
			variantRow: (variant) => ({
				schema: installedTypes(schema),
				name: identifierOf(identity.variantRow(variant))
			})
		}
		const wire: SqlNames = {
			schema: quoteIdent(schema),
			vector: quoteIdent(vector),
			codes: kindCodes
		}
		return { names, wire, schema }
	})

/**
 * The composite a variant's value is held by, as an installation creates it (physical/ddl/variants.ts addVariants): its
 * tag, then each arm's fields at their base types, a float's zero sign beside it.
 */
export const createComposite = (db: CaseSession, names: PhysicalNames, type: ScalarType) => {
	if (type.carrier !== "variant") {
		return Effect.void
	}
	const attributes: Arr.NonEmptyReadonlyArray<ColumnDefinition> = [
		{ name: variantTagAttribute, type: types.smallint, collation: undefined },
		...Arr.flatMap(variantAttributes(type.variant, names.codes), (arm) =>
			Arr.flatMap(arm.fields, (f): ReadonlyArray<ColumnDefinition> => {
				const held = variantAttributeType(names, f.field.type)
				const value = { name: f.attribute, type: held.type, collation: held.collation }
				return f.zero === undefined
					? [value]
					: [value, { name: f.zero, type: types.boolean, collation: undefined }]
			})
		)
	]
	const row = names.variantRow(type.variant.name)
	return Effect.asVoid(
		db.values(
			printStatement({
				kind: "createRowType",
				name: { schema: row.schema, name: row.name },
				attributes
			}),
			[]
		)
	)
}

/**
 * The carrier of a case: two columns, each value's ordinal and the value, typed as production types every carrier
 * column (ir/physical.ts sessionTypeRef), so the reading pairs each value with its ordinal across the two arrays.
 */
export const carrierOf = (names: PhysicalNames, type: ScalarType): WriteCarrier =>
	new CarrierSupply({ typing: (t) => sessionTypeRef(names, t) }).next(
		[
			{ name: "ord", type: decodedType("int4") },
			{ name: "value", type }
		],
		{ ranks: ["held"], rows: "the case's values" }
	)

/**
 * The rows a case sends, each value's text with its ordinal, as one JSON text: its codec's parameter text
 * (codec/scalar.ts ScalarCodec `encode`), and a bytes value's byteain hex text, which no parameter carries since its
 * arrays travel in binary (codec/bytea.ts).
 */
const rowsText = (type: ScalarType, values: ReadonlyArray<unknown>) => {
	const codec = scalarCodec(type, kindCodes)
	const textOf = (v: unknown): string =>
		v instanceof Uint8Array
			? `\\x${Arr.join(
					Arr.map(Array.from(v), (b) => Str.padStart(2, "0")(b.toString(16))),
					""
				)}`
			: succeeded(codec.encode(v))
	return jsonText(Arr.map(values, (v, ord) => ({ ord: String(ord), v: textOf(v) })))
}

/**
 * The statements of a case over its schema `schema`: `create`, a table of each value with its ordinal, the value typed
 * as the carrier's column; `load`, each value's text as its wire type reads it, cast into that type; `fill`, the
 * carrier's fill over the table as a write sends one (write/carriers/carriers.ts carrierStash); `read`, every row of the
 * carrier as a statement reads it (carrierRead), its value's text; and `expected`, the table's rows with each value's
 * text.
 */
export const statementsOf = (
	carrier: WriteCarrier,
	type: ScalarType,
	wire: SqlNames,
	schema: string
) => {
	const value = defined(carrier.declaration.columns[1], "the value's column")
	const held = printType(value.type)
	const sent = type.carrier === "variant" ? held : wireSql(type, wire)
	const table = { schema, name: "src" }
	const create = `CREATE TABLE ${quoteIdent(schema)}."src" (ord int4 NOT NULL, v ${held} NOT NULL)`
	const load = `INSERT INTO ${quoteIdent(schema)}."src" SELECT r.ord, CAST(CAST(r.v AS ${sent}) AS ${held}) FROM pg_catalog.jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v text)`
	const fill = printStatement(
		carrierStash(
			carrier,
			provedSelect(
				"keyed",
				[target(col("x", "ord")), target(col("x", "v"))],
				[{ kind: "table", table, alias: "x" }],
				undefined
			),
			{ alias: "s", columns: ["ord", "v"] }
		)
	)
	const read = printStatement(
		provedSelect(
			"keyed",
			[target(col("r", "c1")), target(cast(col("r", "c2"), types.text))],
			[carrierRead(carrier, "r")],
			undefined
		)
	)
	const expected = `SELECT s.ord, CAST(s.v AS text) FROM ${quoteIdent(schema)}."src" AS s`
	return { create, load, fill, read, expected }
}

/** The rows a case's statement returns, its ordinal and its value's text, in ordinal order. */
export const byOrdinal = (rows: unknown): ReadonlyArray<readonly [number, string]> =>
	Arr.sort(
		Arr.map(textRows(rows), (row) => [Number(row[0]), String(row[1])] as const),
		Order.mapInput(Order.Number, (row: readonly [number, string]) => row[0])
	)

/** The JSON text of a case's rows, the one parameter its fill and its expectation read. */
export const parameterOf = (type: ScalarType, values: ReadonlyArray<unknown>) => [
	rowsText(type, values)
]
