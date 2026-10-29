import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { features, noFeatures } from "@grizzle/testing/features"
import { array, element, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter } from "effect"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { int8Max, int8Min } from "#compiler/scalar/values/integer.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { jsonText } from "#test/support/json.ts"
import { expectSqlstate } from "#test/support/substrate/expect.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

const units = weighted([
	[6, bigint(int8Min, int8Max)],
	[2, bigint(-100_000n, 100_000n)],
	[1, element([int8Min, int8Max, int8Min + 1n, int8Max - 1n, 0n, -1n, 1n])]
])

/** A batch of up to `max` values, a case's one recordset. */
const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/** Each search's budget beside its draw and literal: no features of its own unless it names them, nothing kept. */
const spec = {
	literal: Formatter.format,
	kept: [],
	runs: 2,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	steering: { kind: "none" },
	caseHang: Duration.minutes(2)
} as const

layer(Substrate.layer)("money agreement with PostgreSQL", (it) => {
	const monetarySession = Effect.gen(function* () {
		const { session } = yield* Substrate
		const db = yield* session(ownerSession())
		yield* db.values("SET lc_monetary TO 'C.UTF-8'", [])
		yield* db.values("SET lc_numeric TO 'C.UTF-8'", [])
		assert.deepEqual(yield* db.values("SELECT ('1.005'::money::numeric = 1.01)::text", []), [
			["true"]
		])
		return db
	})

	it.effect("round-trips every int64 minor-unit count through the numeric wire form", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				return yield* explore(
					{
						...spec,
						suite: "pg/values/money/round-trip",
						draw: drawn(batchOf(units, 5000)),
						features: noFeatures
					},
					(sample) =>
						Effect.gen(function* () {
							const rows = yield* db.values(
								`SELECT c.ord::text, (c.v::numeric::money)::numeric::text, ((c.v::numeric::money)::numeric * 100)::int8::text
								FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord`,
								[
									jsonText(
										Arr.map(sample, (u, ord) => ({ ord, v: Money.of(u).toDecimal().toString() }))
									)
								]
							)
							const mismatches = Arr.flatMap(sample, (u, i) => {
								const money = Money.of(u)
								const [, numeric, minor] = defined(rows[i], `no row for sample ${i}`)
								const back = succeeded(
									Money.fromDecimal(succeeded(Decimal.fromString(String(numeric))))
								)
								return numeric === money.toString() && minor === u.toString() && back.equals(money)
									? []
									: [{ u: u.toString(), numeric, minor }]
							})
							assert.deepEqual(mismatches.slice(0, 5), [])
						})
				)
			})
		)
	)

	it.effect("rounds numeric to money as numeric_cash does, refusing out-of-range amounts", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				const amount: Gen<Decimal> = (source) => {
					const minor = source.draw(bigint(-(10n ** 21n), 10n ** 21n))
					const scale = source.draw(int(0, 6))
					return succeeded(Decimal.fromParts(minor < 0n, minor < 0n ? -minor : minor, scale))
				}
				const value = weighted([
					[8, amount],
					[
						1,
						map(
							element([
								"0.005",
								"-0.005",
								"0.004999",
								"92233720368547758.07",
								"92233720368547758.075"
							]),
							(text) => Decimal.of(text)
						)
					]
				])
				return yield* explore(
					{
						...spec,
						suite: "pg/values/money/rounding",
						draw: drawn(batchOf(value, 4000)),
						features: features<"out of range">(["out of range"])
					},
					(sample, c) =>
						Effect.gen(function* () {
							const admitted = Arr.filter(sample, (d) => Money.fromDecimal(d).ok)
							const rows = yield* db.values(
								"SELECT c.ord::text, (c.v::numeric::money)::numeric::text FROM jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text) ORDER BY c.ord",
								[jsonText(Arr.map(admitted, (d, ord) => ({ ord, v: d.toString() })))]
							)
							const mismatches = Arr.flatMap(admitted, (d, i) => {
								const host = succeeded(Money.fromDecimal(d)).toString()
								return rows[i]?.[1] === host ? [] : [{ d: d.toString(), host, pg: rows[i]?.[1] }]
							})
							assert.deepEqual(mismatches.slice(0, 5), [])
							/**
							 * Every amount the host refuses, PostgreSQL refuses as out of range; a protective cap of 30
							 * refusals checked per case, each its own statement.
							 */
							const out = Arr.filter(sample, (d) => !Money.fromDecimal(d).ok)
							if (out.length > 0) {
								c.note("out of range")
							}
							for (const d of out.slice(0, 30)) {
								yield* expectSqlstate(
									db.values("SELECT ($1::text::numeric::money)::text", [d.toString()]),
									"22003"
								)
							}
						})
				)
			})
		)
	)

	it.effect("orders and deduplicates money by its minor units", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
				return yield* explore(
					{
						...spec,
						suite: "pg/values/money/order",
						draw: drawn(batchOf(bigint(-50n, 50n), 500)),
						features: noFeatures
					},
					(sample) =>
						Effect.gen(function* () {
							const payload = jsonText(
								Arr.map(sample, (u, ord) => ({ ord, v: Money.of(u).toString() }))
							)
							const pg = yield* db.values(
								`SELECT c.ord::text FROM ${source} ORDER BY c.v::numeric::money, c.ord`,
								[payload]
							)
							const host = orderOf(sample, (a, b) => Money.of(a).compare(Money.of(b)))
							const pgOrder: ReadonlyArray<number> = Arr.map(pg, (r) => Number(r[0]))
							assert.deepEqual(pgOrder, host)
							const distinct = yield* db.values(
								`SELECT count(DISTINCT c.v::numeric::money)::text FROM ${source}`,
								[payload]
							)
							assert.deepEqual(
								Arr.map(distinct, (r) => Number(r[0])),
								[new Set(sample).size]
							)
						})
				)
			})
		)
	)
})
