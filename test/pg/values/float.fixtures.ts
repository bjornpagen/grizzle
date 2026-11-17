import type { Reached } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	map,
	weighted
} from "@bjornpagen/testing/gen"
/** What the properties of float.test.ts read: their spaces, PostgreSQL's answers, and the order property's builder. */
import { property } from "@bjornpagen/testing/property"
import type { Case } from "@bjornpagen/testing/property"
import { double, float } from "@bjornpagen/testing/values"
import { Array as Arr, Effect, Result } from "effect"
import { jsonText, trusted } from "#compiler/core/trusted.ts"
import { canonicalZero, compareFloat, floatText, toReal } from "#compiler/scalar/values/float.ts"
import { assert, defined } from "#test/support/assert.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** One row of one column, trusted from what PostgreSQL answers. */
const oneCellOf = (rows: unknown): readonly [readonly [unknown]] =>
	trusted<readonly [readonly [unknown]]>(rows)

/** The float8 text PostgreSQL reads back as exactly `x`: the shortest round-trip form, and -0 spelled out. */
export const float8Text = (x: number): string => (Object.is(x, -0) ? "-0" : String(x))

export const fromPg = (text: unknown): number => Number(text)

/**
 * Midpoints between adjacent binary32 values are binary64-exact; ties round to even, which a decimal string read
 * by strtof would not reproduce. Every value within ±3e38 has a finite neighbour, so every midpoint is finite.
 */
const midpoint = map(float(Math.fround(-3e38), Math.fround(3e38)), (f) => {
	const buffer = new DataView(new ArrayBuffer(4))
	buffer.setFloat32(0, f)
	buffer.setUint32(0, buffer.getUint32(0) + 1)
	return (f + buffer.getFloat32(0)) / 2
})

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

export const doubles = weighted([
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

/** The binary64 midpoint between FLT_MAX and 2^128: nearest-even rounds it, and everything above it, to infinity. */
const overflowTie = 2 ** 128 - 2 ** 103

/** Half the least subnormal binary32, 2^-150: nearest-even rounds it, and everything below it, to zero. */
const underflowTie = 2 ** -150

/**
 * A binary64 value at an edge of binary32's range, either sign: the overflow or the underflow tie, moved by up to a few
 * binary64 units of the last place either way, so it lands on, below and above the value the cast refuses.
 */
export const edge: Gen<number> = (source) => {
	const tie = source.draw(element([overflowTie, underflowTie]))
	const steps = source.draw(int(-4, 4))
	const view = new DataView(new ArrayBuffer(8))
	view.setFloat64(0, tie)
	view.setBigUint64(0, view.getBigUint64(0) + BigInt(steps))
	const x = view.getFloat64(0)
	return source.draw(boolean) ? -x : x
}

/** PostgreSQL's answer to one value cast float8 to real alone: the real it stores, or the SQLSTATE it refused it. */
export const castAlone = (db: CaseSession, x: number) =>
	Effect.map(
		Effect.result(db.values("SELECT ($1::text::float8::real)::float8::text", [float8Text(x)])),
		(rows): number | string =>
			Result.isSuccess(rows)
				? fromPg(rows.success[0]?.[0])
				: defined(pgErrorFields(rows.failure), "a server error").code
	)

/** A batch of up to `max` values, a case's one recordset. */
export const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/**
 * What a case reached: a value the cast stores; an overflow and an underflow the cast refuses; NaN and the signed zero.
 */
export type FloatFeature = "admitted" | "overflow" | "underflow" | "NaN" | "signed zero"

const orderValue = weighted([
	[3, doubleOrNaN(-10, 10)],
	[1, anyDouble],
	[2, element([-0, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1, -1])]
])

/** The order and DISTINCT of one float type against the host's: NaN last, NaN = NaN, -0 = +0. */
export const ordersAs = (type: "float8" | "real") => {
	const cast = type === "real" ? "c.v::float8::real" : "c.v::float8"
	const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
	return property.explore(batchOf(orderValue, 3000), {
		needs: { tx: Substrate.transaction },
		situations: ["NaN", "signed zero"] satisfies ReadonlyArray<Reached<FloatFeature>>,
		/** Its pre-conversion budget: runs 2, coverage cases 2 (float.test.ts's order suites at 4fbc3e95). */
		budget: { runs: 2, steered: 2 },
		check:
			({ tx }, c: Case<FloatFeature>) =>
			(sample) =>
				Effect.gen(function* () {
					const { session: db } = yield* tx
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
					const kept = yield* db.values(`SELECT DISTINCT (${cast})::float8::text FROM ${source}`, [
						payload
					])
					assert.deepEqual(
						new Set(Arr.map(kept, (r) => floatText(canonicalZero(fromPg(r[0]))))),
						identities
					)
				}),
		oracle: { kind: "postgresql", name: `${type}'s ORDER BY and DISTINCT` },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/float.ts",
				original: "\t\treturn aNaN === bNaN ? 0 : aNaN ? 1 : -1",
				replacement: "\t\treturn aNaN === bNaN ? 0 : aNaN ? -1 : 1",
				why: "compareFloat orders NaN first."
			}
		]
	})
}
