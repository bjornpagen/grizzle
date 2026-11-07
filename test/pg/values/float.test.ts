import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, filter, type Gen, map, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import {
	canonicalZero,
	compareFloat,
	floatText,
	fround,
	toReal
} from "#compiler/scalar/values/float.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** One row of one column, trusted from what PostgreSQL answers. */
const oneCellOf = (rows: unknown): readonly [readonly [unknown]] =>
	trusted<readonly [readonly [unknown]]>(rows)

/** The float8 text PostgreSQL reads back as exactly `x`: the shortest round-trip form, and -0 spelled out. */
const float8Text = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))

const fromPg = (text: unknown): number => Number(text)

/**
 * Midpoints between adjacent binary32 values are binary64-exact; ties round to even, which a decimal string read
 * by strtof would not reproduce.
 */
const midpoint = filter(
	map(float(Math.fround(-3e38), Math.fround(3e38)), (f) => {
		const buffer = new DataView(new ArrayBuffer(4))
		buffer.setFloat32(0, f)
		buffer.setUint32(0, buffer.getUint32(0) + 1)
		return (f + buffer.getFloat32(0)) / 2
	}),
	(x) => Number.isFinite(x),
	10
)

/** A double between `min` and `max`, and now and then NaN, as a bounded draw that does not rule NaN out. */
const doubleOrNaN = (min: number, max: number): Gen<number> =>
	weighted([
		[19, double(min, max)],
		[1, constant(Number.NaN)]
	])

/** Any double: every finite one, and now and then NaN or an infinity. */
const anyDouble: Gen<number> = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

const doubles = weighted([
	[4, anyDouble],
	[
		4,
		(source) => {
			const x = source.draw(double(1e-37, 3e38))
			return source.draw(element([x, -x]))
		}
	],
	[2, midpoint],
	[1, doubleOrNaN(-1e-38, 1e-38)],
	[1, doubleOrNaN(3.4e38, 3.5e38)],
	[
		1,
		element([
			-0,
			0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			1.0000000596046448
		])
	]
])

/** A batch of up to `max` values, a case's one recordset. */
const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/**
 * The cases of each search: the rotating 2 batches and the floor's 1, about the sample each property drew before the
 * search.
 */
const runs = 2

/**
 * What a case reached: a value the cast stores; an overflow and an underflow the cast refuses; NaN and the signed zero.
 */
type FloatFeature = "admitted" | "overflow" | "underflow" | "NaN" | "signed zero"

layer(Substrate.layer)("float agreement with PostgreSQL", (it) => {
	it.effect(
		"rounds every binary64 value to the real PostgreSQL's float8-to-float4 cast stores",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const { session } = yield* Substrate
					const db = yield* session(ownerSession())
					return yield* explore(
						{
							oracle: { kind: "unstated" },
							suite: "pg/values/float/rounding",
							draw: drawn(batchOf(doubles, 10_000)),
							literal: Formatter.format,
							coverage: required<FloatFeature>(["admitted"], { cases: runs, sense: notesOnly }),
							kept: [],
							runs,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(doubles, c) =>
							Effect.gen(function* () {
								const admitted = Arr.filter(doubles, (x) => toReal(x).ok)
								if (admitted.length > 0) {
									c.note("admitted")
								}
								const rows = yield* db.values(
									"SELECT c.ord::text, (c.v::float8::real)::float8::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
									[jsonText(Arr.map(admitted, (x, ord) => ({ ord, v: float8Text(x) })))]
								)
								assert.equal(rows.length, admitted.length)
								const mismatches = Arr.flatMap(admitted, (x, i) => {
									const pg = canonicalZero(fromPg(rows[i]?.[1]))
									const host = succeeded(toReal(x))
									const rounded = fround(x)
									return Object.is(pg, host) && Object.is(pg, rounded)
										? []
										: [{ x, pg, host, rounded }]
								})
								assert.deepEqual(mismatches.slice(0, 5), [])
							})
					)
				})
			)
	)

	it.effect("refuses exactly the overflows and underflows PostgreSQL refuses", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { session } = yield* Substrate
				const db = yield* session(ownerSession())
				return yield* explore(
					{
						oracle: { kind: "unstated" },
						suite: "pg/values/float/refusals",
						draw: drawn(batchOf(doubles, 10_000)),
						literal: Formatter.format,
						coverage: required<FloatFeature>(["overflow", "underflow"], {
							cases: runs,
							sense: notesOnly
						}),
						kept: [],
						runs,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(doubles, c) =>
						Effect.gen(function* () {
							const refusedValues = Arr.filter(doubles, (x) => !toReal(x).ok)
							const overflow = Arr.filter(refusedValues, (x) => Math.abs(x) > 1)
							const underflow = Arr.filter(refusedValues, (x) => Math.abs(x) < 1)
							if (overflow.length > 0) {
								c.note("overflow")
							}
							if (underflow.length > 0) {
								c.note("underflow")
							}
							assert.deepEqual(
								Arr.filter(
									overflow,
									(x) =>
										!Object.is(
											fround(x),
											x > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
										)
								),
								[]
							)
							assert.deepEqual(
								Arr.filter(underflow, (x) => !Object.is(fround(x), 0)),
								[]
							)
							for (const x of Arr.appendAll(overflow.slice(0, 40), underflow.slice(0, 40))) {
								yield* expectSqlstate(
									db.values("SELECT ($1::text::float8::real)::text", [float8Text(x)]),
									"22003"
								)
							}
						})
				)
			})
		)
	)

	const orderValue = weighted([
		[3, doubleOrNaN(-10, 10)],
		[1, anyDouble],
		[2, element([-0, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1, -1])]
	])

	/** The order and DISTINCT of one float type against the host's. */
	const ordersAs = (type: "float8" | "real") =>
		it.effect(
			`orders and deduplicates ${type} as PostgreSQL does: NaN last, NaN = NaN, -0 = +0`,
			(ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const { session } = yield* Substrate
						const db = yield* session(ownerSession())
						const cast = type === "real" ? "c.v::float8::real" : "c.v::float8"
						const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
						return yield* explore(
							{
								oracle: { kind: "unstated" },
								suite: `pg/values/float/order-${type}`,
								draw: drawn(batchOf(orderValue, 3000)),
								literal: Formatter.format,
								coverage: required<FloatFeature>(["NaN", "signed zero"], {
									cases: runs,
									sense: notesOnly
								}),
								kept: [],
								runs,
								shrink: completeShrink,
								concurrency: 1,
								steerEvery: 16,
								caseHang
							},
							(sample, c) =>
								Effect.gen(function* () {
									/**
									 * Real positions hold real values: round first, and keep the -0 spelling to test the signed
									 * zero.
									 */
									const values = Arr.flatMap(sample, (x) => {
										if (type === "float8") {
											return [x]
										}
										const real = toReal(x)
										return real.ok ? [Object.is(x, -0) ? -0 : real.value] : []
									})
									if (Arr.some(values, (x) => Object.is(x, -0))) {
										c.note("signed zero")
									}
									if (Arr.some(values, (x) => Number.isNaN(x))) {
										c.note("NaN")
									}
									const payload = jsonText(Arr.map(values, (x, ord) => ({ ord, v: float8Text(x) })))
									const asc = orderOf(values, compareFloat)
									const desc = orderOf(values, (a, b) => compareFloat(b, a))
									const pgAsc = yield* db.values(
										`SELECT c.ord::text FROM ${source} ORDER BY ${cast}, c.ord`,
										[payload]
									)
									const pgDesc = yield* db.values(
										`SELECT c.ord::text FROM ${source} ORDER BY ${cast} DESC, c.ord`,
										[payload]
									)
									const pgAscOrder: ReadonlyArray<number> = Arr.map(pgAsc, (r) => Number(r[0]))
									assert.deepEqual(pgAscOrder, asc)
									const pgDescOrder: ReadonlyArray<number> = Arr.map(pgDesc, (r) => Number(r[0]))
									assert.deepEqual(pgDescOrder, desc)
									const identities = new Set(Arr.map(values, floatText))
									const [[count]] = yield* Effect.map(
										db.values(`SELECT count(DISTINCT ${cast})::text FROM ${source}`, [payload]),
										oneCellOf
									)
									assert.equal(Number(count), identities.size)
									const kept = yield* db.values(
										`SELECT DISTINCT (${cast})::float8::text FROM ${source}`,
										[payload]
									)
									assert.deepEqual(
										new Set(Arr.map(kept, (r) => floatText(canonicalZero(fromPg(r[0]))))),
										identities
									)
								})
						)
					})
				)
		)

	ordersAs("float8")
	ordersAs("real")
})
