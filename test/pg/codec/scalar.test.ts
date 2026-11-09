import { layer } from "@effect/vitest"
import { drawn, explore, type Exploration } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	codePoint,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	string,
	subset,
	uniqueArray,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import type { Source } from "@grizzle/testing/source"
import { bigint, double, float, uuid } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, String as Str } from "effect"
import { positionalColumns } from "#compiler/codec/recordset.ts"
import type { ScalarCodec } from "#compiler/codec/scalar.ts"
import { int4Max, int4Min, int8Max, int8Min } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { type Codebook, rosterCodec } from "#compiler/ir/codes.ts"
import { type Carrier, contractOf, type ScalarType } from "#compiler/ir/scalar.ts"
import { anyNumeric, wildcardText } from "#compiler/scalar/compute/types.ts"
import { plainType } from "#compiler/scalar/native.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { toReal } from "#compiler/scalar/values/float.ts"
import { admitValue, type CarrierHost, isHostValue } from "#compiler/scalar/values/identity.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { isVector, Vector } from "#compiler/scalar/values/vector.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	fieldOf,
	monetaryContext,
	type SqlNames,
	storedTextOut,
	textOut,
	textRows,
	vectorSchemaOf,
	wireSql
} from "#test/pg/codec/support.ts"
import { arraysEncoder } from "#test/support/arrays.ts"
import { assert, nonEmpty, succeeded } from "#test/support/assert.ts"
import { scalarOf } from "#test/support/fixtures/ir/scalar.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { headingRecord } from "#test/support/statement-rows.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { codecOf, type TestCodec } from "#test/unit/codec/support.ts"
import { decimalGen } from "#test/unit/values/support.ts"

/**
 * Exact scalar codecs against PostgreSQL 19 in raw-text mode.
 *
 * - The outermost SELECT casts every column to text, which the conversions read.
 * - For every scalar, generated host values are encoded, sent through jsonb_to_recordset and through a cast
 *   parameter, and read back as PostgreSQL's own text, which the kernel's strict reader admits
 *   (test/support/kernel/strict.ts) and the library's trusting conversion converts to the value the strict reader
 *   reads (the same text form and identity, never through the encoder's admission) and to exactly the value sent:
 *   numeric with NaN, Infinity and display scale, real at binary32, -0, money minor units, bigint, uuid case, spans and
 *   vectors.
 * - The encoder's native coercion is PostgreSQL's: numeric(p,s) rounding and overflow, and the float8-to-real cast.
 * - Vectors PostgreSQL rounds itself convert exactly, and a stored row converts through a positional row converter.
 *
 * Each property searches through the library's exploration over a batch of values, sent in one statement per case, so
 * a failure shrinks to the value that fails.
 *
 * The handles of the test's own roster, the codes they hold, with a hole before each of the last two so no handle's code
 * is its position, and the cases' scalar types beyond the plain carriers, each the registry's.
 */
const kindHandles = ["Manual", "Automatic", "Ünïcode"] as const

/**
 * The widths of the sets the round trip sends over rosters of their own, one code to nine: a set's text is X and whole
 * hex digits, its padding 0, so the widths that fill their last digit and those that pad it are told apart, and a
 * digit holding only its last code is the digit 1.
 */
const setWidths = Arr.range(1, 9)

/** The handles of the roster of a set of `width` codes. */
const setHandles = (width: number): Arr.NonEmptyReadonlyArray<string> =>
	nonEmpty(Arr.map(Arr.range(0, width - 1), (c) => `s${c}`))

const setRoster = (width: number) => parsedName(`Set${width}`)

const kindCodes: Codebook = {
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
	])
}
const scalars = {
	uuid: scalarOf({ kind: "uuid" }, {}),
	numeric52: scalarOf({ kind: "numeric", precision: 5, scale: 2 }, {}),
	numeric72: scalarOf({ kind: "numeric", precision: 7, scale: 2 }, {}),
	kind: scalarOf({ kind: "closedId", roster: "Kind" }, { Kind: kindHandles }),
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
}

/** NaN and the infinities, one draw in ten beside a generator of finite values. */
const withNonFinite = (finite: Gen<number>): Gen<number> =>
	weighted([
		[9, finite],
		[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
	])

/** The largest finite binary32 value. */
const realMax = 3.4028234663852886e38

const int8Gen: Gen<bigint> = oneOf([
	bigint(int8Min.value, int8Max.value),
	element([int8Min.value, int8Max.value, 0n, -1n, 1n])
])

const int4Gen: Gen<number> = oneOf([
	int(int4Min.value, int4Max.value),
	element([int4Min.value, int4Max.value, 0, -0])
])

/** Two distinct endpoints, the lower first: a draw that repeats an endpoint draws again. */
const span = <E extends number | bigint>(endpoint: Gen<E>) =>
	map(
		filter(
			(source) => [source.draw(endpoint), source.draw(endpoint)] as const,
			([a, b]) => a !== b,
			10
		),
		([a, b]) => (a < b ? { start: a, end: b } : { start: b, end: a })
	)

/** Values the float8-to-real cast admits: a draw it refuses, overflowing or underflowing, draws again. */
const realGen: Gen<number> = filter(
	oneOf([
		withNonFinite(double(-Number.MAX_VALUE, Number.MAX_VALUE)),
		withNonFinite(float(-realMax, realMax)),
		element([-0, 1 + 2 ** -24, 2 ** -149, realMax, Number.NaN, Number.POSITIVE_INFINITY])
	]),
	(x) => toReal(x).ok,
	100
)

const doubleGen: Gen<number> = oneOf([
	withNonFinite(double(-Number.MAX_VALUE, Number.MAX_VALUE)),
	element([-0, 5e-324, Number.MAX_VALUE, Number.NaN, Number.NEGATIVE_INFINITY, 0.1])
])

/** The UUID versions a uuid is drawn in, every one RFC 9562 defines. */
const uuidVersions = [1, 2, 3, 4, 5, 6, 7, 8] as const

/** A UUID of any version, in canonical lowercase. */
const anyUuid: Gen<string> = (source) => source.draw(uuid(source.draw(element(uuidVersions))))

const caseShuffled: Gen<string> = (source) => {
	const u = source.draw(anyUuid)
	const ups = source.draw(array(boolean, { min: 36, max: 36 }))
	return Arr.join(
		Array.from(u, (c, i) => (ups[i] === true ? Str.toUpperCase(c) : c)),
		""
	)
}

/** The spellings a text comparison trips on: empty, composed and decomposed, beyond the BMP, U+FFFD and U+10FFFF. */
const textEdges = ["", "é", "é", "𝔘", "�", "\u{10ffff}"] as const

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

/**
 * A batch of values a case sends in one statement: up to 100, so a round trip's 15 cases send 1500 values per
 * carrier, the sample each carrier sent before the search.
 */
const batchOf = <A>(values: Gen<A>): Gen<ReadonlyArray<A>> => array(values, { min: 1, max: 100 })

/** The round trips' cases per carrier: 15 batches of up to 100 values. */
const roundTripRuns = 15

/**
 * The values each carrier sent through a cast parameter before the search, one statement each: spread over the round
 * trip's cases.
 */
const castsPerCarrier = 40
const castsPerCase = Math.ceil(castsPerCarrier / roundTripRuns)

interface Case {
	readonly label: string
	readonly type: ScalarType
	readonly values: Gen<unknown>
}

const cases: Arr.NonEmptyReadonlyArray<Case> = [
	{ label: "smallint", type: plainType("int2"), values: int(-32768, 32767) },
	{ label: "integer", type: plainType("int4"), values: int4Gen },
	{ label: "bigint", type: plainType("int8"), values: int8Gen },
	{ label: "numeric", type: anyNumeric, values: decimalGen },
	{
		label: "numeric(7,2)",
		type: scalars.numeric72,
		values: filter(decimalGen, (d) => codecOf(scalars.numeric72, kindCodes).encode(d).ok, 100)
	},
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
	{ label: "int4range", type: scalars.range4, values: span(int4Gen) },
	{ label: "int8range", type: scalars.range8, values: span(int8Gen) },
	{ label: "vector(3)", type: scalars.vector3, values: vectorGen(3) },
	{ label: "vector(16)", type: scalars.vector16, values: vectorGen(16) },
	{ label: "contract Cents", type: scalars.cents, values: int8Gen }
]

/** The carrier a round trip's case names, by its label. */
const caseOf = (label: string): Case =>
	Option.getOrThrowWith(
		Arr.findFirst(cases, (c) => c.label === label),
		() => new Error(`no carrier ${label}`)
	)

/** A round trip's case: a carrier, by its label, and a batch of its values. */
interface RoundTrip {
	readonly label: string
	readonly batch: ReadonlyArray<unknown>
}

const roundTripGen: Gen<RoundTrip> = (source) => {
	const c = source.draw(element(cases))
	return { label: c.label, batch: source.draw(batchOf(c.values)) }
}

/** A carrier a round trip reached, by its label. */
type RoundTripFeature = `round-trips ${string}`

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
 * compared by its structure (sameHost). The sent value is encodable by construction; the conversion is compared as it
 * is, never admitted.
 */
const sameValue = (codec: ScalarCodec, sent: unknown, decoded: CarrierHost[Carrier]): boolean =>
	sameHost(succeeded(admitValue(codec.spec, sent)), decoded)

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
const recordset = (db: RawSession, select: string, column: string, texts: ReadonlyArray<string>) =>
	db.values(
		`SELECT ${select} FROM jsonb_to_recordset($1::text::jsonb) AS r(ord int4, v ${column}) ORDER BY r.ord`,
		[jsonText(Arr.map(texts, (v, ord) => ({ ord: String(ord), v })))]
	)

const setup = Effect.gen(function* () {
	const { session, schema } = yield* Substrate
	const db = yield* session(ownerSession())
	yield* monetaryContext(db)
	const name = yield* schema(freshSchema)
	const vector = yield* vectorSchemaOf(db)
	const names: SqlNames = { schema: quoteIdent(name), vector, codes: kindCodes }
	yield* db.values(
		`CREATE DOMAIN ${names.schema}."cents" AS bigint CONSTRAINT "cents_check" CHECK ((VALUE >= 0) IS TRUE)`,
		[]
	)
	return { db, names }
})

/** One batch of a carrier's values through the recordset, and its first values through a cast parameter. */
const roundTrip = (db: RawSession, names: SqlNames, c: Case, batch: ReadonlyArray<unknown>) =>
	Effect.gen(function* () {
		const codec = codecOf(c.type, kindCodes)
		const texts = Arr.map(batch, (v) => succeeded(codec.encode(v)))
		const rows = yield* recordset(db, textOut(c.type, "r.v"), wireSql(c.type, names), texts)
		const viaRecordset = Arr.flatMap(batch, (v, i) => {
			const text = rows[i]?.[0]
			const decoded = read(codec, text)
			return decoded.ok && sameValue(codec, v, decoded.value)
				? []
				: [{ sent: texts[i], received: text }]
		})
		assert.deepEqual(viaRecordset, [])
		/** The parameter path: the text bound untyped and cast by the statement, $1::type. */
		const viaParam: Array<{ readonly sent: string | undefined; readonly received: unknown }> = []
		for (let i = 0; i < Math.min(castsPerCase, batch.length); i++) {
			const out = yield* db.values(`SELECT ${textOut(c.type, `$1::${wireSql(c.type, names)}`)}`, [
				texts[i]
			])
			const text = out[0]?.[0]
			const decoded = read(codec, text)
			if (!(decoded.ok && sameValue(codec, batch[i], decoded.value))) {
				viaParam.push({ sent: texts[i], received: text })
			}
		}
		assert.deepEqual(viaParam, [])
	})

/** The numeric typmods coerced, each the feature of the cases that draw it. */
const typmods = [
	{ precision: 5, scale: 2 },
	{ precision: 3, scale: 0 },
	{ precision: 4, scale: -2 },
	{ precision: 2, scale: 4 }
] as const

type TypmodFeature = `numeric(${number},${number})`

const typmodName = (typmod: (typeof typmods)[number]): TypmodFeature =>
	`numeric(${typmod.precision},${typmod.scale})`

/** One exploration of `values` in batches, each case one statement; `runs` batches of up to 100. */
const batches = <A>(
	suite: string,
	values: Gen<A>,
	runs: number
): Exploration<ReadonlyArray<A>, ReadonlyArray<A>, never> => ({
	oracle: { kind: "unstated" },
	suite,
	draw: drawn(batchOf(values)),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
})

layer(Substrate.layer)("exact scalar codecs against PostgreSQL", (it) => {
	it.effect("round-trips every carrier exactly through the recordset and a cast parameter", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { db, names } = yield* setup
				return yield* explore(
					{
						suite: "pg/codec/scalar/round-trip",
						draw: drawn(roundTripGen),
						literal: Formatter.format,
						coverage: required<RoundTripFeature>(
							Arr.map(cases, (c): RoundTripFeature => `round-trips ${c.label}`),
							{ cases: roundTripRuns * cases.length, sense: notesOnly }
						),
						kept: [],
						/** Each carrier's 15 batches, as when every carrier searched on its own. */
						runs: roundTripRuns * cases.length,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang,
						oracle: {
							kind: "universal",
							name: "convert ∘ PostgreSQL ∘ encode = id, the strict reader's value of the output text"
						}
					},
					({ label, batch }, c) =>
						Effect.gen(function* () {
							yield* roundTrip(db, names, caseOf(label), batch)
							c.note(`round-trips ${label}`)
						})
				)
			})
		)
	)

	it.effect(
		"coerces numeric(p,s) exactly as PostgreSQL does, overflow by rounding included",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { db } = yield* setup
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							/** 60 batches over four typmods: each typmod's 1500 values, its sample before the search. */
							suite: "pg/codec/scalar/numeric-coercion",
							draw: drawn(
								(source) =>
									[
										source.draw(element<(typeof typmods)[number]>(typmods)),
										source.draw(batchOf(decimalGen))
									] as const
							),
							literal: Formatter.format,
							coverage: required<TypmodFeature>(Arr.map(typmods, typmodName), {
								cases: 60,
								sense: notesOnly
							}),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						([typmod, batch], notes) =>
							Effect.gen(function* () {
								notes.note(typmodName(typmod))
								const type = scalarOf(
									{ kind: "numeric", precision: typmod.precision, scale: typmod.scale },
									{}
								)
								const codec = codecOf(type, kindCodes)
								const sql = typmodName(typmod)
								const admitted = Arr.filter(batch, (d) => codec.encode(d).ok)
								const refusedValues = Arr.filter(batch, (d) => !codec.encode(d).ok)
								const rows = yield* recordset(
									db,
									`(r.v::${sql})::text`,
									"text",
									Arr.map(admitted, (d) => d.toString())
								)
								const mismatches = Arr.flatMap(admitted, (d, i) => {
									const pg = rows[i]?.[0]
									return typeof pg === "string" &&
										Decimal.fromOutput(pg).equals(Decimal.fromOutput(succeeded(codec.encode(d))))
										? []
										: [{ raw: d.toString(), pg }]
								})
								assert.deepEqual(mismatches, [])
								if (!(refusedValues.length > 0)) {
									return
								}
								const codes = yield* recordset(
									db,
									`(pg_input_error_info(r.v, '${sql}')).sql_error_code`,
									"text",
									Arr.map(refusedValues, (d) => d.toString())
								)
								const accepted = Arr.flatMap(refusedValues, (d, i) =>
									codes[i]?.[0] === "22003" ? [] : [{ raw: d.toString(), pg: codes[i]?.[0] }]
								)
								assert.deepEqual(accepted, [])
							})
					)
				})
			)
	)

	it.effect(
		"rounds a binary64 value to real as the float8-to-real cast does, never double-rounding",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { db } = yield* setup
					const real = codecOf(plainType("float4"), kindCodes)
					const float8Text = (x: number) => (Object.is(x, -0) ? "-0" : String(x))
					/** 30 batches: the 3000 values the cast was sampled with before the search. */
					const sampled = batches("pg/codec/scalar/real-cast", realGen, 30)
					return yield* explore(sampled, (sample) =>
						Effect.gen(function* () {
							const rows = yield* recordset(
								db,
								"((r.v::float8)::real)::text",
								"text",
								Arr.map(sample, float8Text)
							)
							const mismatches = Arr.flatMap(sample, (x, i) => {
								const text = rows[i]?.[0]
								const decoded = read(real, text)
								return decoded.ok && real.text(decoded.value) === succeeded(real.encode(x))
									? []
									: [{ x: float8Text(x), pg: text }]
							})
							assert.deepEqual(mismatches, [])
						})
					)
				})
			)
	)

	it.effect("decodes pgvector's output at float32 for vectors PostgreSQL rounds itself", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { db, names } = yield* setup
				/** Components the float8-to-real cast admits: it refuses a nonzero value that underflows. */
				const component = filter(double(-1e30, 1e30), (x) => toReal(x).ok, 100)
				const toFloat8Array = (xs: ReadonlyArray<number>) =>
					`{${Arr.join(
						Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : String(x))),
						","
					)}}`
				const codec = codecOf(scalars.vector16, kindCodes)
				/** 5 batches: the 500 vectors sampled before the search. */
				const sampled = batches(
					"pg/codec/scalar/vector-rounding",
					array(component, { min: 16, max: 16 }),
					5
				)
				return yield* explore(sampled, (sample) =>
					Effect.gen(function* () {
						const rows = yield* recordset(
							db,
							`(r.v::float8[]::real[]::${names.vector}."vector"(16))::text`,
							"text",
							Arr.map(sample, toFloat8Array)
						)
						const mismatches = Arr.flatMap(sample, (xs, i) => {
							const decoded = read(codec, rows[i]?.[0])
							const host = Vector.make(Float32Array.from(xs), 16)
							return decoded.ok && isVector(decoded.value) && Vector.equals(decoded.value, host)
								? []
								: [{ pg: rows[i]?.[0] }]
						})
						assert.deepEqual(mismatches, [])
					})
				)
			})
		)
	)

	it.effect("stores facts through their arrays and decodes the stored rows positionally", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { db, names } = yield* setup
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
				yield* db.values(
					`CREATE TABLE ${table} (${Arr.join(
						Arr.map(columns, (c) => `${quoteIdent(c.field)} ${c.sql} NOT NULL`),
						", "
					)}, CONSTRAINT "reading_key" PRIMARY KEY ("id"))`,
					[]
				)
				const fact = (source: Source) => ({
					id: source.draw(anyUuid),
					amount: source.draw(bigint(0n, int8Max.value)),
					rate: source.draw(map(int(-9999999, 9999999), (n) => Decimal.of(`${n}e-2`))),
					raw: source.draw(realGen),
					charge: source.draw(map(int8Gen, (u) => Money.of(u))),
					kind: source.draw(element(kindHandles)),
					kinds: new Set(source.draw(subset(kindHandles, { min: 0, max: kindHandles.length }))),
					label: source.draw(textGen),
					during: source.draw(span(int8Gen)),
					value: source.draw(vectorGen(16))
				})
				const encode = arraysEncoder({
					relation: "Reading",
					columns: positionalColumns(Arr.map(columns, (c) => ({ name: c.field, type: c.type }))),
					slot: { kind: "none" },
					codes: kindCodes
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
						if (contractOf(c.type) !== undefined) {
							return `(${column})::${c.sql}`
						}
						return column
					}),
					", "
				)
				const decodeRow = headingRecord(
					Arr.map(columns, (c) => ({ name: c.field, type: c.type })),
					kindCodes
				)
				return yield* explore(
					{
						oracle: { kind: "unstated" },
						/**
						 * 3 batches of facts distinct by key: the 300 facts stored before the search, each batch into an empty table.
						 */
						suite: "pg/codec/scalar/stored-row",
						draw: drawn(uniqueArray(fact, (f) => Str.toLowerCase(f.id), { min: 1, max: 100 }, 10)),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 3,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(facts) =>
						Effect.gen(function* () {
							yield* db.values(`TRUNCATE ${table}`, [])
							const { arrays, count } = succeeded(encode(facts))
							const inserted = yield* db.query(
								`INSERT INTO ${table} SELECT ${selectList} FROM (SELECT ${arrayColumns}) AS r0`,
								arrays
							)
							assert.equal(inserted.rowCount, count)
							const rows = yield* db.values(
								`SELECT ${Arr.join(
									Arr.map(columns, (c) => storedTextOut(c.type, `r.${quoteIdent(c.field)}`)),
									", "
								)} FROM ${table} AS r ORDER BY r."id"`,
								[]
							)
							const texts = textRows(rows)
							const decoded = Arr.map(texts, decodeRow)
							const expected = new Map<string, (typeof facts)[number]>(
								Arr.map(facts, (f) => [Str.toLowerCase(f.id), f] as const)
							)
							assert.equal(decoded.length, expected.size)
							for (const row of decoded) {
								const f = typeof row["id"] === "string" ? expected.get(row["id"]) : undefined
								if (f === undefined) {
									return assert.fail(`a stored row of no fact: ${String(row["id"])}`)
								}
								for (const c of columns) {
									const codec = codecOf(c.type, kindCodes)
									const value = row[c.field]
									assert.ok(
										isHostValue(codec.spec.carrier, value),
										`${c.field}: no ${codec.spec.carrier} value`
									)
									assert.ok(sameValue(codec, fieldOf(f, c.field), value), `${c.field} of ${f.id}`)
								}
							}
						})
				)
			})
		)
	)
})
