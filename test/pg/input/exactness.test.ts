/**
 * The input boundary's exactness against PostgreSQL 19: a value is parsed once as its type (scalar/values/identity.ts
 * parseValue), and the database stores exactly the value parsed or nothing; a silently altered value is never stored.
 *
 * - Exactness: for every carrier whose input PostgreSQL could store as another value than the one sent, numeric under
 *   typmods of many precisions and scales (a negative scale and a scale above the precision among them), real, double
 *   precision, money, smallint, integer, bigint, uuid, date, text and boolean, a batch of drawn host values, inside the
 *   type, past its scale or its precision, no binary32 value, at the type's edges and of another type, is parsed: a
 *   refused value sends nothing; an admitted one is the value drawn under the carrier's own equality, the parse
 *   altering only its spelling (a uuid's case, a float's -0), and its parameter text, cast to the column's type in one
 *   recordset as a stored column's assignment casts it, comes back as PostgreSQL's text of the stored value, read by
 *   the kernel's strict reader (test/support/kernel/strict.ts), exactly the value parsed.
 *
 * Oracle: PostgreSQL itself, its input functions and its typmod coercion; and each carrier's equality between the value
 * drawn and the value parsed.
 *
 * Plants (~/.cache/grizzle-release/LIVE-PARSE/plants): parse-numeric-rounds (parseNumeric rounds to the typmod's scale
 * as normalizeNumeric does, admitting 1.005 at scale 2 as 1.01), parse-real-rounds (parseReal rounds a double to
 * binary32 as toReal does).
 *
 * Features: per carrier, "<carrier> stored exactly" and "<carrier> refused"; "numeric past its scale refused" and "real
 * no binary32 value refused", the two coercions PostgreSQL would make silently.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	codePoint,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint, double, float, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result, String as Str } from "effect"
import { carrierSpecOf, resultTextCasts, scalarCodec } from "#compiler/codec/scalar.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import {
	type Carrier,
	type CarrierSpec,
	canonicalText,
	compareValues,
	isHostValue,
	parseValue
} from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, defined, nonEmpty } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { strictReader } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { decimalGen } from "#test/unit/values/support.ts"

/** One column type the property sends values of: its label, its type, its PostgreSQL spelling and its values. */
interface Column {
	readonly label: string
	readonly type: ScalarType
	readonly sql: string
	readonly values: Gen<unknown>
}

/** A numeric(p, s) column, its values any Decimal, and now and then a JavaScript number, which no numeric is. */
const numericColumn = (precision: number, scale: number): Column => ({
	label: `numeric(${precision}, ${scale})`,
	type: scalarOf({ kind: "numeric", precision, scale }, {}),
	sql: `numeric(${precision},${scale})`,
	values: weighted<unknown>([
		[12, decimalGen],
		[1, element<unknown>([1.5, "1.5"])]
	])
})

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

const columns: Arr.NonEmptyReadonlyArray<Column> = [
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
		values: anyReal
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

const caseGen: Gen<Case> = (source) => {
	const column = source.draw(element(columns))
	return { column, values: source.draw(array(column.values, { min: 1, max: 40 })) }
}

type ExactFeature =
	| `${string} stored exactly`
	| `${string} refused`
	| "numeric past its scale refused"
	| "real no binary32 value refused"

/**
 * Whether the parse kept the value drawn, `drawn`, as `parsed`: equal under the carrier's own order (identity.ts
 * compareValues), a uuid drawn in its lowercase spelling, the one spelling the parse changes beside a float's -0.
 */
const keptValue = (spec: CarrierSpec, parsed: unknown, drawnValue: unknown): boolean => {
	const value =
		spec.carrier === "uuid" && typeof drawnValue === "string"
			? Str.toLowerCase(drawnValue)
			: drawnValue
	return sameHost(spec, parsed, value)
}

/** Whether two values are one host value of the spec's carrier, by its order and its one text. */
const sameHost = (spec: CarrierSpec, a: unknown, b: unknown): boolean => {
	const carrier: Carrier = spec.carrier
	return (
		isHostValue(carrier, a) &&
		isHostValue(carrier, b) &&
		compareValues(spec, a, b) === 0 &&
		canonicalText(spec, a) === canonicalText(spec, b)
	)
}

/** The cast a column's stored value is read back through, as a delivery casts it (codec/scalar.ts resultTextCasts). */
const readBackSql = (column: Column): string =>
	Arr.reduce(
		resultTextCasts(column.type),
		column.type.carrier === "money" ? "((c.v::numeric)::money)" : `(c.v::${column.sql})`,
		(expr, cast) => `(${expr})::${cast}`
	)

layer(Substrate.layer)("the input boundary against PostgreSQL 19", (it) => {
	it.effect(
		"stores exactly the value parsed, or refuses it before any SQL: never a silently altered value",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* explore(
						{
							oracle: {
								kind: "postgresql",
								name: "each column type's input and typmod coercion, read back by the strict reader"
							},
							suite: "pg/input/exactness",
							draw: drawn(caseGen),
							literal: Formatter.format,
							coverage: required<ExactFeature>(
								nonEmpty(
									[
										...Arr.flatMap(columns, (c): ReadonlyArray<ExactFeature> => [
											`${c.label} stored exactly`,
											`${c.label} refused`
										]),
										"numeric past its scale refused",
										"real no binary32 value refused"
									],
									"the features"
								),
								{ cases: 400, sense: notesOnly }
							),
							kept: [],
							runs: 400,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						({ column, values }, c) =>
							Effect.gen(function* () {
								const spec = carrierSpecOf(column.type, emptyCodebook)
								const codec = scalarCodec(column.type, emptyCodebook)
								const sent: Array<{
									readonly ord: number
									readonly v: string
									readonly parsed: unknown
								}> = []
								for (const [ord, value] of values.entries()) {
									const parsed = parseValue(spec, value)
									if (!parsed.ok) {
										c.note(`${column.label} refused`)
										if (parsed.error === "numericScale") {
											c.note("numeric past its scale refused")
										}
										if (parsed.error === "realInexact") {
											c.note("real no binary32 value refused")
										}
										continue
									}
									assert.ok(
										keptValue(spec, parsed.value, value),
										`${column.label}: the parse of ${Formatter.format(value)} is ${Formatter.format(parsed.value)}, another value`
									)
									const text = codec.encode(value)
									assert.ok(text.ok, `${column.label}: a value the parse admits encodes`)
									sent.push({ ord, v: text.ok ? text.value : "", parsed: parsed.value })
								}
								if (sent.length === 0) {
									return
								}
								const rows = yield* db.values(
									`SELECT c.ord::text, ${readBackSql(column)} FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
									[jsonText(Arr.map(sent, ({ ord, v }) => ({ ord, v })))]
								)
								assert.equal(rows.length, sent.length, `${column.label}: one row per value sent`)
								const read = strictReader(column.type, emptyCodebook)
								for (const [i, one] of sent.entries()) {
									const cell = defined(rows[i], `the row of value ${one.ord}`)[1]
									const stored = typeof cell === "string" ? read(cell) : undefined
									assert.ok(
										stored !== undefined &&
											Result.isSuccess(stored) &&
											sameHost(spec, stored.success, one.parsed),
										`${column.label}: ${Formatter.format(one.parsed)} was stored as ${Formatter.format(cell)}`
									)
									c.note(`${column.label} stored exactly`)
								}
							})
					)
				})
			)
	)
})
