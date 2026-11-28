/** What the properties of scalar.test.ts read: the carriers' cases, their spaces, a case's setup and its round trip. */
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { assert, nonEmpty } from "@bjornpagen/testing/assert"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subset,
	weighted
} from "@bjornpagen/testing/gen"
import type { Source } from "@bjornpagen/testing/source"
import { bigint, double, float, uuid } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { positionalColumns } from "#compiler/codec/recordset.ts"
import type { ScalarCodec } from "#compiler/codec/scalar.ts"
import { int4Max } from "#compiler/core/canonical.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { int4Min, int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { noSpellings } from "#compiler/ir/pattern.ts"
import { type Carrier, routable, type ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { parseValue, type CarrierHost } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import {
	monetaryContext,
	type SqlNames,
	textOut,
	vectorSchemaOf,
	wireSql
} from "#test/support/pg/codec/support.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { codecOf, type TestCodec } from "#test/support/unit/codec/support.ts"
import { decimalGen } from "#test/support/unit/values/support.ts"
import { upTo } from "#test/support/up-to.ts"

/** The handles of the test's own roster, the codes they hold, with a hole before each of the last two. */
export const kindHandles = ["Manual", "Automatic", "Ünïcode"] as const

/**
 * The widths of the sets the round trip sends over rosters of their own, one code to nine: a set's text is X and whole
 * bytes of hex digits, its padding 0, so the widths that fill their last byte and those that pad it are told apart, and
 * a digit holding only its last code is the digit 1.
 */
export const setWidths: Arr.NonEmptyReadonlyArray<number> = Arr.range(1, 9)

/** The handles of the roster of a set of `width` codes. */
export const setHandles = (width: number): Arr.NonEmptyReadonlyArray<string> =>
	nonEmpty(upTo(width, (c) => `s${c}`))

const setRoster = (width: number) => parsedName(`Set${width}`)

export const kindRosterCodes: Codebook = {
	rosters: new Map([
		[
			parsedName("Kind"),
			rosterCodec(parsedName("Kind"), [
				{ kind: "live", handle: "Manual" },
				{ kind: "hole" },
				{ kind: "live", handle: "Automatic" },
				{ kind: "hole" },
				{ kind: "live", handle: "Ünïcode" }
			])
		],
		...Arr.map(
			setWidths,
			(w) =>
				[
					setRoster(w),
					rosterCodec(
						setRoster(w),
						Arr.map(setHandles(w), (handle) => ({ kind: "live", handle }) as const)
					)
				] as const
		)
	]),
	spellings: noSpellings
}
const scalars = Object.freeze({
	uuid: scalarOf({ kind: "uuid" }, {}),
	numeric52: scalarOf({ kind: "numeric", precision: 5, scale: 2 }, {}),
	numeric72: scalarOf({ kind: "numeric", precision: 7, scale: 2 }, {}),
	numeric10: scalarOf({ kind: "numeric", precision: 1, scale: 0 }, {}),
	numeric10000: scalarOf({ kind: "numeric", precision: 1000, scale: 0 }, {}),
	kind: scalarOf({ kind: "closedId", roster: "Kind", only: undefined }, { Kind: kindHandles }),
	kinds: scalarOf({ kind: "bits", roster: "Kind" }, { Kind: kindHandles }),
	range4: scalarOf(
		{ kind: "span", endpoint: { kind: "pg", type: "integer" }, width: undefined },
		{}
	),
	range8: scalarOf(
		{ kind: "span", endpoint: { kind: "pg", type: "bigint" }, width: undefined },
		{}
	),
	vector3: scalarOf({ kind: "vector", dimensions: 3 }, {}),
	vector16: scalarOf({ kind: "vector", dimensions: 16 }, {}),
	cents: scalarOf(
		{
			kind: "contract",
			name: "Cents",
			base: { kind: "pg", type: "bigint" },
			predicate: undefined,
			facts: []
		},
		{}
	)
})

/** NaN and the infinities, one draw in ten beside a generator of finite values. */
const withNonFinite = (finite: Gen<number>): Gen<number> =>
	weighted([
		[9, finite],
		[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
	])

/** The largest finite binary32 value. */
const realMax = 3.4028234663852886e38

const int8Gen: Gen<bigint> = oneOf([
	bigint(int8Min, int8Max),
	element([int8Min, int8Max, 0n, -1n, 1n])
])

const int4Gen: Gen<number> = oneOf([int(int4Min, int4Max), element([int4Min, int4Max, 0, -0])])

/**
 * An integer of numeric(p, 0), whose host value is a bigint below 10^p in magnitude: drawn over the whole range, at its
 * ends and zero, and among the small ones.
 */
const integerNumericGen = (precision: number): Gen<bigint> => {
	const most = 10n ** BigInt(precision) - 1n
	const small = most < 1000n ? most : 1000n
	return oneOf([bigint(-most, most), element([most, -most, 0n]), bigint(-small, small)])
}

/**
 * Two distinct endpoints, the lower first: the second endpoint, where it repeats the first, is moved to its `neighbour`,
 * so every draw is a span by construction.
 */
const span =
	<E extends number | bigint>(
		endpoint: Gen<E>,
		neighbour: (endpoint: E) => E
	): Gen<Readonly<{ start: E; end: E }>> =>
	(source) => {
		const a = source.draw(endpoint)
		const drawn = source.draw(endpoint)
		const b = drawn === a ? neighbour(a) : drawn
		return a < b ? { start: a, end: b } : { start: b, end: a }
	}

/** An int4 endpoint's neighbour: the next one up, or down from the greatest. */
const int4Neighbour = (endpoint: number): number =>
	endpoint === int4Max ? endpoint - 1 : endpoint + 1

/** An int8 endpoint's neighbour: the next one up, or down from the greatest. */
const int8Neighbour = (endpoint: bigint): bigint =>
	endpoint === int8Max ? endpoint - 1n : endpoint + 1n

/**
 * A binary32 value of any exponent: a sign, a significand in [1, 2) of any binary64 bits and an exponent from the least
 * subnormal binary32's to one below the greatest's, rounded to binary32, which keeps it nonzero and finite.
 */
const insideReal: Gen<number> = (source) => {
	const negative = source.draw(boolean)
	const m = source.draw(double(1, 2 - 2 ** -52))
	const e = source.draw(int(-149, 126))
	return Math.fround((negative ? -1 : 1) * m * 2 ** e)
}

/** Values a real holds exactly, by construction: binary32 values of every exponent, edges. */
const realGen: Gen<number> = oneOf([
	withNonFinite(insideReal),
	withNonFinite(float(-realMax, realMax)),
	element([-0, 1 + 2 ** -23, 2 ** -149, realMax, Number.NaN, Number.POSITIVE_INFINITY])
])

/**
 * A numeric(7,2) value, by construction: NaN, or a whole part below 10^5 - 1 in magnitude and up to two fraction
 * digits, each a value the typmod holds as it is.
 */
const numeric72Gen: Gen<Decimal> = weighted([
	[1, constant(Decimal.nan)],
	[
		12,
		(source) => {
			const whole = source.draw(int(-99_998, 99_998))
			const fraction = source.draw(string(codePoint(0x30, 0x39), { min: 0, max: 2 }))
			return Decimal.of(fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`)
		}
	]
])

const doubleGen: Gen<number> = oneOf([
	withNonFinite(double(-Number.MAX_VALUE, Number.MAX_VALUE)),
	element([-0, 5e-324, Number.MAX_VALUE, Number.NaN, Number.NEGATIVE_INFINITY, 0.1])
])

/** The UUID versions a uuid is drawn in, every one RFC 9562 defines. */
const uuidVersions = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** A UUID of any version, in canonical lowercase. */
export const anyUuid: Gen<string> = (source) =>
	source.draw(uuid(source.draw(element(uuidVersions))))

const caseShuffled: Gen<string> = (source) => {
	const u = source.draw(anyUuid)
	const ups = source.draw(array(boolean, { min: 36, max: 36 }))
	return Arr.join(
		Array.from(u, (c, i) => (ups[i] === true ? Str.toUpperCase(c) : c)),
		""
	)
}

/** The spellings a text comparison trips on: empty, composed and decomposed, beyond the BMP, U+FFFD and U+10FFFF. */
const textEdges = ["", "\u00e9", "e\u0301", "𝔘", "�", "\u{10ffff}"] as const

/**
 * Texts of up to twelve code points, each well-formed and never NUL: ASCII, the rest of the BMP outside the surrogates,
 * and the supplementary planes; or one of the spellings a text comparison trips on.
 */
const textGen: Gen<string> = oneOf([
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
 * A vector lies in the cosine domain, whose norm is in [2^-16, 2^16]: its components are bounded by
 * 2^16 / sqrt(dims), subnormals included, and a vector whose norm falls below the domain has its first component set
 * to 1.
 */
const vectorGen = (dims: number) => {
	const bound = Math.fround(2 ** 16 / Math.sqrt(dims))
	const component = oneOf([float(-bound, bound), double(-bound, bound)])
	return map(array(component, { min: dims, max: dims }), (xs) => {
		const v = Vector.make(Float32Array.from(xs), dims)
		return Vector.inCosineDomain(v) ? v : Vector.make(Float32Array.from([1, ...xs.slice(1)]), dims)
	})
}

/** A batch of values a case sends in one statement. */
const batchOf = <A>(values: Gen<A>): Gen<ReadonlyArray<A>> => array(values, { min: 1, max: 100 })

interface Case {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
}

/** The round trips' cases per carrier: a search runs this many times as many cases as there are carriers. */
export const roundTripRuns = 15

export const cases: Arr.NonEmptyReadonlyArray<Case> = [
	{ label: "smallint", type: plainType("int2"), values: int(-32768, 32767) },
	{ label: "integer", type: plainType("int4"), values: int4Gen },
	{ label: "bigint", type: plainType("int8"), values: int8Gen },
	{ label: "numeric", type: anyNumeric, values: decimalGen },
	{
		label: "numeric(7,2)",
		type: scalars.numeric72,
		values: numeric72Gen
	},
	{ label: "numeric(1,0)", type: scalars.numeric10, values: integerNumericGen(1) },
	{ label: "numeric(1000,0)", type: scalars.numeric10000, values: integerNumericGen(1000) },
	{ label: "real", type: plainType("float4"), values: realGen },
	{ label: "double precision", type: plainType("float8"), values: doubleGen },
	{ label: "money", type: plainType("money"), values: map(int8Gen, (u) => Money.of(u)) },
	{ label: "boolean", type: plainType("bool"), values: boolean },
	{ label: "uuid", type: scalars.uuid, values: caseShuffled },
	{ label: "text", type: wildcardText, values: textGen },
	{ label: "closed id", type: scalars.kind, values: element(kindHandles) },
	{
		label: "set",
		type: scalars.kinds,
		values: map(subset(kindHandles, { min: 0, max: kindHandles.length }), (hs) => new Set(hs))
	},
	...Arr.map(setWidths, (w): Case => ({
		label: `set over ${w} codes`,
		type: scalarOf({ kind: "bits", roster: `Set${w}` }, { [`Set${w}`]: setHandles(w) }),
		values: map(subset(setHandles(w), { min: 0, max: w }), (hs) => new Set(hs))
	})),
	{ label: "int4range", type: scalars.range4, values: span(int4Gen, int4Neighbour) },
	{ label: "int8range", type: scalars.range8, values: span(int8Gen, int8Neighbour) },
	{ label: "vector(3)", type: scalars.vector3, values: vectorGen(3) },
	{ label: "vector(16)", type: scalars.vector16, values: vectorGen(16) },
	{ label: "contract Cents", type: scalars.cents, values: int8Gen }
]

/** The carrier a round trip's case names, by its label. */
export const caseOf = (label: string): Case =>
	Option.getOrThrowWith(
		Arr.findFirst(cases, (c) => c.label === label),
		() => new Error(`no carrier ${label}`)
	)

/**
 * A round trip's case: a carrier, by its label, a batch of its values the recordset sends, and one value a cast
 * parameter sends.
 */
interface RoundTrip {
	readonly label: string
	readonly batch: ReadonlyArray<unknown>
	readonly cast: unknown
}

export const roundTripGen: Gen<RoundTrip> = (source) => {
	const c = source.draw(element(cases))
	return { label: c.label, batch: source.draw(batchOf(c.values)), cast: source.draw(c.values) }
}

/** A carrier a round trip reached, by its label. */
export type RoundTripFeature = `round-trips ${string}`

/**
 * Whether two host values are one value, compared by their structure and never through grizzle's encoder, whose texts
 * are what the round trip tests: a set by its handles, a numeric and money by their own equality, a vector component by
 * component and a span by its ends, each double by Object.is, everything else by identity.
 */
const sameHost = (a: unknown, b: unknown): boolean => {
	if (a instanceof Set && b instanceof Set) {
		return a.size === b.size && Arr.every(Arr.fromIterable(a), (x) => b.has(x))
	}
	if (a instanceof Decimal && b instanceof Decimal) {
		return a.equals(b)
	}
	if (a instanceof Money && b instanceof Money) {
		return a.equals(b)
	}
	if (isVector(a) && isVector(b)) {
		return Vector.equals(a, b)
	}
	if (
		typeof a === "object" &&
		a !== null &&
		typeof b === "object" &&
		b !== null &&
		"start" in a &&
		"end" in a &&
		"start" in b &&
		"end" in b
	) {
		return Object.is(a.start, b.start) && Object.is(a.end, b.end)
	}
	return Object.is(a, b)
}

/**
 * The exact comparison of a sent value with its conversion: the conversion is the value the sent one admits to,
 * compared by its structure (sameHost), and a float, which admission takes as it is, either zero with its sign, is the
 * value sent itself. The sent value is encodable by construction; the conversion is compared as it is, never admitted.
 */
export const sameValue = (
	codec: ScalarCodec,
	sent: unknown,
	decoded: CarrierHost[Carrier]
): boolean =>
	sameHost(
		codec.spec.carrier === "float4" || codec.spec.carrier === "float8"
			? sent
			: succeeded(parseValue(codec.spec, sent)),
		decoded
	)

/**
 * PostgreSQL's output text of a value: admitted by the kernel's strict reader, and converted by the library to the value
 * the strict reader reads, compared by its structure (no admission: PostgreSQL's value may lie outside what the encoder
 * admits).
 */
const read = (codec: TestCodec, text: unknown): Result.Result<CarrierHost[Carrier], string> => {
	if (typeof text !== "string") {
		return Result.err("no text")
	}
	const strict = codec.read(text)
	if (strict._tag === "Failure") {
		return Result.err(strict.failure)
	}
	const converted = codec.convert(text)
	return sameHost(strict.success, converted)
		? Result.ok(converted)
		: Result.err("conversion differs")
}

/** The recordset's rows of a batch of texts, in batch order. */
export const recordset = (
	db: CaseSession,
	select: string,
	column: string,
	texts: ReadonlyArray<string>
) =>
	db.values(
		`SELECT ${select} FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${column}) ORDER BY r.ord`,
		[jsonText(Arr.map(texts, (v, ord) => ({ ord: String(ord), v })))]
	)

/**
 * A case's session made ready, in the case's transaction (Substrate.rolledBack): the money context set, a schema of the
 * case's own under a name `allocate` gives, and the cents domain in it.
 */
export const setupIn = (db: CaseSession, allocate: (label: string) => Effect.Effect<string>) =>
	Effect.gen(function* () {
		yield* monetaryContext(db)
		const name = yield* allocate("codec")
		yield* db.values(`CREATE SCHEMA ${quoteIdent(name)}`, [])
		const vector = yield* vectorSchemaOf(db)
		const names: SqlNames = { schema: quoteIdent(name), vector, codes: kindRosterCodes }
		yield* db.values(
			`CREATE DOMAIN ${names.schema}."cents" AS bigint CONSTRAINT "cents_check" CHECK ((VALUE >= 0) IS TRUE)`,
			[]
		)
		return { db, names }
	})

/** One batch of a carrier's values through the recordset, and one value through a cast parameter. */
export const roundTrip = (db: CaseSession, names: SqlNames, c: Case, trip: RoundTrip) =>
	Effect.gen(function* () {
		const codec = codecOf(c.type, kindRosterCodes)
		const texts = Arr.map(trip.batch, (v) => succeeded(codec.encode(v)))
		const rows = yield* recordset(db, textOut(c.type, "r.v"), wireSql(c.type, names), texts)
		const viaRecordset = Arr.flatMap(trip.batch, (v, i) => {
			const text = rows[i]?.[0]
			const decoded = read(codec, text)
			return decoded.ok && sameValue(codec, v, decoded.value)
				? []
				: [{ sent: texts[i], received: text }]
		})
		assert.deepEqual(viaRecordset, [])
		const sent = succeeded(codec.encode(trip.cast))
		const out = yield* db.values(`SELECT ${textOut(c.type, `$1::${wireSql(c.type, names)}`)}`, [
			sent
		])
		const received = out[0]?.[0]
		const decoded = read(codec, received)
		assert.ok(
			decoded.ok && sameValue(codec, trip.cast, decoded.value),
			`the parameter ${sent} read back as ${Formatter.format(received)}`
		)
	})

/** The Reading row a stored-row case writes over `names`: its table, its columns, their encoder and decoder. */
export const readingOver = (names: SqlNames) => {
	const table = `${names.schema}."reading"`
	const columns: ReadonlyArray<{
		readonly field: string
		readonly type: ScalarType
		readonly sql: string
	}> = [
		{ field: "id", type: scalars.uuid, sql: "uuid" },
		{ field: "amount", type: scalars.cents, sql: `${names.schema}."cents"` },
		{ field: "rate", type: scalars.numeric72, sql: "numeric(7,2)" },
		{ field: "raw", type: plainType("float4"), sql: "real" },
		{ field: "charge", type: plainType("money"), sql: "money" },
		{ field: "kind", type: scalars.kind, sql: "smallint" },
		{ field: "kinds", type: scalars.kinds, sql: wireSql(scalars.kinds, names) },
		{ field: "label", type: wildcardText, sql: "text COLLATE pg_catalog.pg_c_utf8" },
		{ field: "during", type: scalars.range8, sql: "int8range" },
		{ field: "value", type: scalars.vector16, sql: `${names.vector}."vector"(16)` }
	]
	const create = `CREATE TABLE ${table} (${Arr.join(
		Arr.map(columns, (c) => `${quoteIdent(c.field)} ${c.sql} NOT NULL`),
		", "
	)}, CONSTRAINT "reading_key" PRIMARY KEY ("id"))`
	const encode = arraysEncoder({
		relation: "Reading",
		columns: positionalColumns(Arr.map(columns, (c) => ({ name: c.field, type: c.type }))),
		slot: { kind: "none" },
		codes: kindRosterCodes
	})
	/** Each column's array as the lowering reads it: its base type made an array, a typmod cast back. */
	const arrayColumns = Arr.join(
		Arr.map(columns, (c, i) => {
			const base = wireSql(c.type, names)
			const unnest = `pg_catalog.unnest($${i + 1}::${base}[])`
			const typed =
				c.type.carrier === "vector" || Str.startsWith("numeric(")(base)
					? `${unnest}::${base}`
					: unnest
			return `${typed} AS c${i + 1}`
		}),
		", "
	)
	const selectList = Arr.join(
		Arr.map(columns, (c, i) => {
			const column = `r0.c${i + 1}`
			if (c.type.carrier === "money") {
				return `(${column})::money`
			}
			if (c.type.contract !== undefined) {
				return `(${column})::${c.sql}`
			}
			return column
		}),
		", "
	)
	const decodeRow = headingRecord(
		Arr.map(columns, (c) => ({ name: c.field, type: c.type })),
		kindRosterCodes
	)
	return { table, columns, create, encode, arrayColumns, selectList, decodeRow }
}

/** A Reading fact of key `id`: every column a drawn value of its carrier. */
export const factOf = (id: string) => (source: Source) => ({
	id,
	amount: source.draw(bigint(0n, int8Max)),
	rate: source.draw(map(int(-9999999, 9999999), (n) => Decimal.of(`${n}e-2`))),
	raw: source.draw(realGen),
	charge: source.draw(map(int8Gen, (u) => Money.of(u))),
	kind: source.draw(element(kindHandles)),
	kinds: new Set(source.draw(subset(kindHandles, { min: 0, max: kindHandles.length }))),
	label: source.draw(textGen),
	during: source.draw(span(int8Gen, int8Neighbour)),
	value: source.draw(vectorGen(16))
})

/** The round trip's cases of the carriers a change routes by (ir/scalar.ts routable). */
export const routableCases: Arr.NonEmptyReadonlyArray<Case> = nonEmpty(
	Arr.filter(cases, (c) => routable[c.type.carrier])
)

/**
 * A writer's session settings a printed text may follow, each with the values a writer may hold, its session's own
 * among them (the harness's startup options): what the change source's text of a stored value is printed under, which
 * no grizzle session pins for a direct SQL writer.
 */
const writerSettings = {
	DateStyle: ["ISO, MDY", "SQL, DMY", "Postgres, YMD", "German, DMY"],
	IntervalStyle: ["postgres", "sql_standard", "iso_8601"],
	extra_float_digits: ["-15", "0", "1", "3"],
	bytea_output: ["hex", "escape"]
} as const

/** The names of the writer's settings (writerSettings). */
const settingNames = ["DateStyle", "IntervalStyle", "extra_float_digits", "bytea_output"] as const

/**
 * A routable carrier, by its round trip's label, a batch of its values, and the writer's settings it is printed under:
 * a value of every setting, so a setting a writer leaves alone is its session's own value, one of those drawn.
 */
interface RoutableCase {
	readonly label: string
	readonly batch: ReadonlyArray<unknown>
	readonly settings: ReadonlyArray<readonly [(typeof settingNames)[number], string]>
}

export const routableGen: Gen<RoutableCase> = (source) => {
	const c = source.draw(element(routableCases))
	const settings = Arr.map(
		settingNames,
		(name) => [name, source.draw(element(writerSettings[name]))] as const
	)
	return { label: c.label, batch: source.draw(batchOf(c.values)), settings }
}

/** A routable carrier a case reached, by its round trip's label. */
export type RoutableFeature = `routes ${string}`
