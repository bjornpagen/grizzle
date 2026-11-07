import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	filter,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, pipe, Result, String as Str } from "effect"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { compareSpan, makeSpan, spanText } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { exactVectorText, type InputVerdict, vectorInVerdict } from "#test/pg/vector/support.ts"
import { assert, defined, nonEmpty, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** A batch of up to `max` values, a case's one recordset. */
const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/**
 * Each search's budget beside its suite and draw: the rotating 2 batches and the floor's 1, about the sample each
 * property drew before the search, and no features.
 */
const spec = {
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: 2,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/** One row of one column, trusted from what PostgreSQL answers. */
const oneCellOf = (rows: unknown): readonly [readonly [unknown]] =>
	trusted<readonly [readonly [unknown]]>(rows)

const pgFloatArray = (text: unknown): ReadonlyArray<number> => {
	const inner = pipe(String(text), Str.slice(1, -1))
	return inner.length === 0 ? [] : Arr.map(Str.split(inner, ","), Number)
}

/** The pinned pgvector installation's schema, quoted, and its vector type. */
const vectorTypeOf = (db: RawSession) =>
	Effect.map(
		db.values(
			"SELECT n.nspname::text FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector'",
			[]
		),
		(rows) => {
			const extension = quoteIdent(String(rows[0]?.[0]))
			return { extension, vectorType: `${extension}."vector"` }
		}
	)

/** The binary64 midpoint between FLT_MAX and 2^128: nearest-even rounds it, and everything above it, to infinity. */
const overflowTie = 2 ** 128 - 2 ** 103

/**
 * Binary64 values whose binary32 rounding is a tie or an edge: a tie to even down to 1 and one up to 1 + 2^-22, a
 * subnormal tie, the smallest subnormal, FLT_MAX, and the largest values that still round to FLT_MAX.
 */
const roundingEdges: Arr.NonEmptyReadonlyArray<number> = [
	-0,
	0,
	1 + 2 ** -24,
	1 + 3 * 2 ** -24,
	1.5 * 2 ** -149,
	2 ** -149,
	-(2 ** -149),
	3.4028234663852886e38,
	overflowTie - 2 ** 75,
	-(overflowTie - 2 ** 75)
]

/**
 * A float8[] literal that PostgreSQL reads back as exactly these binary64 values: JavaScript's number text is the
 * shortest round-trip form, and -0 keeps its sign.
 */
const float8ArrayText = (xs: ReadonlyArray<number>): string =>
	`{${Arr.join(
		Arr.map(xs, (x) => (Object.is(x, -0) ? "-0" : String(x))),
		","
	)}}`

/** Every int4 span of bounds within -5..5, its lower bound below its upper. */
const spanBounds = Arr.flatMap(Arr.range(-5, 4), (lower) =>
	Arr.map(Arr.range(lower + 1, 5), (upper) => [lower, upper] as const)
)

/**
 * A vector input: its first components, drawn, and its length, theirs or near the storage limit, the rest ones. A
 * component is any binary64 across and past binary32's range, a rounding edge, NaN or an infinity.
 */
interface InputSketch {
	readonly head: Arr.NonEmptyReadonlyArray<number>
	readonly length: number
}

/**
 * The binary64 values cast to real and then to vector: float8_to_float4 refuses an overflow and an underflow to zero
 * (22003) as it casts each in order, then pgvector's array_to_vector refuses a length past the limit (54000) and then a
 * non-finite component (22000).
 */
const binaryVerdict = (xs: ReadonlyArray<number>): InputVerdict => {
	for (const x of xs) {
		const rounded = Math.fround(x)
		if ((Number.isFinite(x) && !Number.isFinite(rounded)) || (x !== 0 && rounded === 0)) {
			return "22003"
		}
	}
	if (xs.length > vectorMaxDimensions.value) {
		return "54000"
	}
	return Arr.every(xs, Number.isFinite) ? "admitted" : "22000"
}

/** What a vector input reached. */
type InputFeature =
	| "admitted"
	| "at the storage limit"
	| "a component past binary32"
	| "a non-finite component"
	| "past the storage limit"
	| "an underflow read as zero"

/** A component of a vector input. */
const inputComponent: Gen<number> = oneOf([
	(source) => {
		const negative = source.draw(boolean)
		const m = source.draw(double(1, 2 - 2 ** -52))
		const e = source.draw(int(-160, 135))
		return (negative ? -1 : 1) * m * 2 ** e
	},
	element(roundingEdges),
	element([
		overflowTie,
		-overflowTie,
		2 ** -150,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY
	])
])

const inputGen: Gen<InputSketch> = (source) => {
	const head = nonEmpty(source.draw(array(inputComponent, { min: 1, max: 4 })), "a component")
	return {
		head,
		length: source.draw(
			weighted([
				[3, constant(head.length)],
				[1, int(vectorMaxDimensions.value - 1, vectorMaxDimensions.value + 1)]
			])
		)
	}
}

/** A sketch's components: its head, then ones up to its length. */
const inputOf = (sketch: InputSketch): ReadonlyArray<number> =>
	Arr.appendAll(sketch.head, ones(Math.max(0, sketch.length - sketch.head.length)))

const ones = (n: number) => Array.from({ length: n }, () => 1)

/** The host's encode-time construction of the binary64 inputs once a Float32Array holds them. */
const hostVector = (xs: ReadonlyArray<number>) => Vector.from(Float32Array.from(xs), xs.length)

layer(Substrate.layer)("span and vector agreement with PostgreSQL", (it) => {
	it.effect("orders spans as range_cmp does", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				const span = map(element(spanBounds), ([a, b]) => succeeded(makeSpan("int4", a, b)))
				return yield* explore(
					{
						...spec,
						suite: "pg/values/carriers/span-order",
						draw: drawn(batchOf(span, 600))
					},
					(spans) =>
						Effect.gen(function* () {
							const payload = jsonText(Arr.map(spans, (s, ord) => ({ ord, v: spanText(s) })))
							const rows = yield* db.values(
								"SELECT c.ord::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.v::int4range, c.ord",
								[payload]
							)
							const host = orderOf(spans, compareSpan)
							const rowsOrder: ReadonlyArray<number> = Arr.map(rows, (r) => Number(r[0]))
							assert.deepEqual(rowsOrder, host)
						})
				)
			})
		)
	)

	it.effect(
		"rounds binary64 components as PostgreSQL's float8-to-real cast does, and pgvector reads the codec text exactly",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					const { vectorType } = yield* vectorTypeOf(db)
					/**
					 * Components drawn across the whole binary32 exponent range, subnormals included, with mantissas that are
					 * arbitrary binary64 values so most of them need rounding. The float8-to-real cast raises on underflow and
					 * on overflow (float8_to_float4), so the drawn magnitudes stay strictly between the binary32 underflow tie
					 * 2^-150 and the overflow tie 2^128 - 2^103; the input search below draws past both.
					 */
					const magnitude = filter(
						(source) => {
							const negative = source.draw(boolean)
							const m = source.draw(double(1, 2 - 2 ** -52))
							const e = source.draw(int(-152, 127))
							return (negative ? -1 : 1) * m * 2 ** e
						},
						(x) => Math.abs(x) > 2 ** -150 && Math.abs(x) < overflowTie,
						10
					)
					const components = array(oneOf([magnitude, element(roundingEdges)]), { min: 1, max: 12 })
					const sameComponents = (pg: ReadonlyArray<number>, host: ReadonlyArray<number>) =>
						pg.length === host.length && Arr.every(pg, (x, k) => x === host[k])
					return yield* explore(
						{
							...spec,
							suite: "pg/values/carriers/vector-rounding",
							draw: drawn(batchOf(components, 1000))
						},
						(inputs) =>
							Effect.gen(function* () {
								const vectors = Arr.map(inputs, (xs) => ({
									xs,
									v: Vector.make(Float32Array.from(xs), xs.length)
								}))
								/**
								 * Column 1 is PostgreSQL's own rounding of the original binary64 inputs, handed to pgvector
								 * as real[]; column 2 is pgvector reading the text the codec sends.
								 */
								const rows = yield* db.values(
									`SELECT ((c.xs::float8[]::real[])::${vectorType})::real[]::float8[]::text,
									((c.v::${vectorType})::real[])::float8[]::text
								FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, xs text, v text) ORDER BY c.ord`,
									[
										jsonText(
											Arr.map(vectors, ({ xs, v }, ord) => ({
												ord,
												xs: float8ArrayText(xs),
												v: Vector.componentText(v)
											}))
										)
									]
								)
								assert.equal(rows.length, vectors.length)
								const mismatches = Arr.flatMap(vectors, ({ xs, v }, i) => {
									const host = Array.from(v)
									const rounded = pgFloatArray(rows[i]?.[0])
									const read = pgFloatArray(rows[i]?.[1])
									return sameComponents(rounded, host) && sameComponents(read, host)
										? []
										: [{ input: float8ArrayText(xs), host: Vector.componentText(v), pg: rows[i] }]
								})
								assert.deepEqual(mismatches.slice(0, 5), [])
							})
					)
				})
			)
	)

	it.effect(
		"refuses what pgvector refuses, by text and through real, reads every admitted component as its binary32 rounding, and the host refuses alike",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					const { vectorType } = yield* vectorTypeOf(db)
					/** PostgreSQL's answer to an input: the SQLSTATE it refused it with, or the value it read. */
					const answer = (sql: string, text: string) =>
						Effect.map(Effect.result(db.values(sql, [text])), (rows) =>
							Result.isSuccess(rows)
								? { verdict: "admitted" as const, read: oneCellOf(rows.success)[0][0] }
								: {
										verdict: defined(pgErrorFields(rows.failure), "a server error").code,
										read: undefined
									}
						)
					return yield* explore(
						{
							suite: "pg/values/carriers/vector-input",
							draw: drawn(inputGen),
							literal: Formatter.format,
							oracle: {
								kind: "postgresql",
								name: "pgvector's vector_in and array_to_vector, and float8_to_float4, against a model of their checks"
							},
							coverage: required<InputFeature>(
								[
									"admitted",
									"at the storage limit",
									"a component past binary32",
									"a non-finite component",
									"past the storage limit",
									"an underflow read as zero"
								],
								{ cases: 60, sense: notesOnly }
							),
							kept: [],
							runs: 60,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 8,
							caseHang
						},
						(sketch, c) =>
							Effect.gen(function* () {
								const xs = inputOf(sketch)
								const expected = vectorInVerdict(xs, Option.none())
								const text = yield* answer(
									`SELECT (($1::text::${vectorType})::real[])::float8[]::text`,
									exactVectorText(xs)
								)
								assert.equal(text.verdict, expected, "the text input")
								const binary = yield* answer(
									`SELECT (($1::text::float8[]::real[])::${vectorType})::text`,
									float8ArrayText(xs)
								)
								assert.equal(binary.verdict, binaryVerdict(xs), "the input through real")
								const host = hostVector(xs)
								const hostRefuses =
									!host.ok &&
									(host.error.reason._tag === "vectorDimensions" ||
										host.error.reason._tag === "vectorNonFinite")
								assert.equal(hostRefuses, expected !== "admitted", "the host refuses alike")
								switch (expected) {
									case "admitted": {
										c.note("admitted")
										assert.deepEqual(
											pgFloatArray(text.read),
											Arr.map(xs, Math.fround),
											"pgvector reads each component as its binary32 rounding"
										)
										if (xs.length === vectorMaxDimensions.value) {
											c.note("at the storage limit")
										}
										if (Arr.some(xs, (x) => x !== 0 && Math.fround(x) === 0)) {
											c.note("an underflow read as zero")
										}
										return
									}
									case "22003":
										c.note("a component past binary32")
										return
									case "22000":
										c.note("a non-finite component")
										return
									case "54000":
										c.note("past the storage limit")
										return
								}
							})
					)
				})
			)
	)

	it.effect("orders vectors as vector_cmp does", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				const { vectorType } = yield* vectorTypeOf(db)
				const vector = map(array(element([-1, -0, 0, 0.5, 1]), { min: 1, max: 3 }), (xs) =>
					Vector.make(Float32Array.from(xs), xs.length)
				)
				return yield* explore(
					{
						...spec,
						suite: "pg/values/carriers/vector-order",
						draw: drawn(batchOf(vector, 400))
					},
					(vectors) =>
						Effect.gen(function* () {
							const rows = yield* db.values(
								`SELECT c.ord::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.v::${vectorType}, c.ord`,
								[jsonText(Arr.map(vectors, (v, ord) => ({ ord, v: Vector.componentText(v) })))]
							)
							const host = orderOf(vectors, Vector.compare)
							const rowsOrder: ReadonlyArray<number> = Arr.map(rows, (r) => Number(r[0]))
							assert.deepEqual(rowsOrder, host)
						})
				)
			})
		)
	)
})
