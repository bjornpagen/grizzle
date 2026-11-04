import { layer } from "@effect/vitest"
import { drawn, exhaust, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { array, boolean, element, filter, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, pipe, String as Str } from "effect"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { vectorMaxDimensions } from "#compiler/ir/carriers.ts"
import { compareSpan, makeSpan, spanText } from "#compiler/scalar/values/span.ts"
import { Vector } from "#compiler/scalar/values/vector.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf, type ValueFault } from "#test/unit/values/support.ts"

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
	caseHang: Duration.minutes(2)
} as const

/** An exhaustive check's budget beside its suite and generator. */
const exhaustive = {
	literal: Formatter.format,
	limit: 16,
	coverage: noCoverage,
	caseHang: Duration.minutes(2)
} as const

/** One row of one and of two columns, trusted from what PostgreSQL answers. */
const oneCellOf = (rows: unknown): readonly [readonly [unknown]] =>
	trusted<readonly [readonly [unknown]]>(rows)
const twoCellsOf = (rows: unknown): readonly [readonly [unknown, unknown]] =>
	trusted<readonly [readonly [unknown, unknown]]>(rows)

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

/** The host's encode-time construction of the binary64 inputs once a Float32Array holds them. */
const hostVector = (xs: ReadonlyArray<number>) => Vector.from(Float32Array.from(xs), xs.length)

const ones = (n: number) => Array.from({ length: n }, () => 1)

/** Every int4 span of bounds within -5..5, its lower bound below its upper. */
const spanBounds = Arr.flatMap(Arr.range(-5, 4), (lower) =>
	Arr.map(Arr.range(lower + 1, 5), (upper) => [lower, upper] as const)
)

/**
 * A refused input: the host fault, pgvector's SQLSTATE for the decimal text, and PostgreSQL's SQLSTATE for the binary64
 * value cast to real and then to vector. A component beyond binary32 range is infinity in a Float32Array, so the host
 * refuses float32 overflow as a non-finite component.
 */
interface Refusal {
	readonly xs: ReadonlyArray<number>
	readonly fault: ValueFault
	readonly text: string
	readonly binary: string
}

const refusals: Arr.NonEmptyReadonlyArray<Refusal> = [
	{ xs: [Number.NaN], fault: "vectorNonFinite", text: "22000", binary: "22000" },
	{
		xs: [Number.POSITIVE_INFINITY],
		fault: "vectorNonFinite",
		text: "22000",
		binary: "22000"
	},
	{
		xs: [1, Number.NEGATIVE_INFINITY],
		fault: "vectorNonFinite",
		text: "22000",
		binary: "22000"
	},
	{ xs: [3.5e38], fault: "vectorNonFinite", text: "22003", binary: "22003" },
	{ xs: [-1e39], fault: "vectorNonFinite", text: "22003", binary: "22003" },
	{
		xs: ones(vectorMaxDimensions + 1),
		fault: "vectorDimensions",
		text: "54000",
		binary: "54000"
	}
]

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
					const { extension, vectorType } = yield* vectorTypeOf(db)
					/**
					 * Components drawn across the whole binary32 exponent range, subnormals included, with mantissas that are
					 * arbitrary binary64 values so most of them need rounding. The float8-to-real cast raises on underflow and
					 * on overflow (float8_to_float4), so the drawn magnitudes stay strictly between the binary32 underflow tie
					 * 2^-150 and the overflow tie 2^128 - 2^103; both edges are pinned by the refusal test below.
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
					const explored = yield* explore(
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
					const [[signedZero, tie]] = yield* Effect.map(
						db.values(
							`SELECT ('[-0,1]'::${vectorType} OPERATOR(${extension}.=) $1::text::${vectorType})::text, ('[1.0000000596046448]'::${vectorType})::real[]::float8[]::text`,
							[Vector.componentText(Vector.make(Float32Array.of(-0, 1), 2))]
						),
						twoCellsOf
					)
					assert.equal(signedZero, "true")
					assert.deepEqual(pgFloatArray(tie), [1.0000001192092896])
					assert.equal(Vector.componentText(Vector.make(Float32Array.of(1 + 2 ** -24), 1)), "[1]")
					return explored
				})
			)
	)

	it.effect("refuses what pgvector refuses, the overflow tie included", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				const { vectorType } = yield* vectorTypeOf(db)
				assert.equal(Float32Array.of(overflowTie)[0], Number.POSITIVE_INFINITY)
				refused(hostVector([overflowTie]), "vectorNonFinite")
				yield* expectSqlstate(
					db.values(`SELECT (($1::text::float8[]::real[])::${vectorType})::text`, [
						float8ArrayText([overflowTie])
					]),
					"22003"
				)
				return yield* exhaust(
					{
						...exhaustive,
						suite: "pg/values/carriers/vector-refusals",
						generator: element(refusals)
					},
					({ xs, fault, text, binary }) =>
						Effect.gen(function* () {
							refused(hostVector(xs), fault)
							yield* expectSqlstate(
								db.values(`SELECT ($1::text::${vectorType})::text`, [
									`[${Arr.join(Arr.map(xs, String), ",")}]`
								]),
								text
							)
							yield* expectSqlstate(
								db.values(`SELECT (($1::text::float8[]::real[])::${vectorType})::text`, [
									float8ArrayText(xs)
								]),
								binary
							)
						})
				)
			})
		)
	)

	it.effect(
		"admits the storage limit and a component that underflows as zero, which the cast to real refuses",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					const { extension, vectorType } = yield* vectorTypeOf(db)
					/** The storage limit itself is admitted by both. */
					const widest = succeeded(
						Vector.admit(Float32Array.from(ones(vectorMaxDimensions)), vectorMaxDimensions)
					)
					const [[dims]] = yield* Effect.map(
						db.values(`SELECT ${extension}.vector_dims($1::text::${vectorType})::text`, [
							Vector.componentText(widest)
						]),
						oneCellOf
					)
					assert.equal(Number(dims), vectorMaxDimensions)
					yield* expectSqlstate(
						db.values(`SELECT (($1::text::float8[]::real[])::${vectorType})::text`, [
							float8ArrayText([1e-50])
						]),
						"22003"
					)
					return yield* exhaust(
						{
							...exhaustive,
							suite: "pg/values/carriers/vector-underflow",
							generator: element([1e-50, -1e-50, 1e-46])
						},
						(tiny) =>
							Effect.gen(function* () {
								assert.equal(
									Vector.componentText(Vector.make(Float32Array.of(tiny, 1), 2)),
									"[0,1]"
								)
								const [[read]] = yield* Effect.map(
									db.values(`SELECT (($1::text::${vectorType})::real[])::float8[]::text`, [
										`[${String(tiny)},1]`
									]),
									oneCellOf
								)
								assert.deepEqual(
									Arr.map(pgFloatArray(read), (x) => x === 0),
									[true, false]
								)
								assert.equal(pgFloatArray(read)[1], 1)
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
