/**
 * Money against PostgreSQL 19, its monetary locale C.UTF-8: the host's Money (scalar/values/money.ts) is PostgreSQL's
 * money, value for value.
 *
 * - Round trip: every int64 count of minor units, written as the host's text, cast to money and back to numeric, reads
 *   as the host's text and as the same count, and the host reads that text back as the same Money.
 * - Rounding: every amount the host admits (Money.fromDecimal), cast numeric to money in one recordset, is the host's
 *   amount: numeric_cash rounds half away from zero to two places.
 * - Refusal: an amount at the edge of money's range, or anywhere, cast alone, is refused by PostgreSQL with 22003
 *   exactly when the host refuses it, and is the host's amount otherwise.
 * - Order: PostgreSQL's positions of a batch of amounts under `ORDER BY v::money, ord` are the host's under
 *   Money.compare, ties by position, and count(DISTINCT v::money) is the number of distinct minor-unit counts.
 *
 * Oracle: PostgreSQL itself: money's casts to and from numeric, its refusals and its comparison.
 *
 * Plants: values-money-text-padding (Money.toString pads its digits one short, so an amount below one unit loses its
 * leading zero), values-money-round-half-down (roundHalfAway rounds a tie toward zero), values-money-range-open
 * (Money.make admits int8Max + 1), values-money-order-magnitude (Money.compare orders by magnitude).
 *
 * Features: "out of range" and "admitted at the edge", an edge amount on each side of the refusal.
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { jsonText } from "#compiler/core/trusted.ts"
import { moneyFractionDigits } from "#compiler/ir/carriers.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

const units = weighted([
	[6, bigint(int8Min.value, int8Max.value)],
	[2, bigint(-100_000n, 100_000n)],
	[1, element([int8Min.value, int8Max.value, int8Min.value + 1n, int8Max.value - 1n, 0n, -1n, 1n])]
])

/** An amount anywhere: a minor-unit count of up to 21 digits at a scale of up to six places. */
const amount: Gen<Decimal> = (source) => {
	const minor = source.draw(bigint(-(10n ** 21n), 10n ** 21n))
	const scale = source.draw(int(0, 6))
	return succeeded(Decimal.fromParts(minor < 0n, minor < 0n ? -minor : minor, scale))
}

/** How many places past money's two an edge amount's fraction reaches: on numeric_cash's tie and either side of it. */
const edgePlaces = 2

/**
 * An amount at the edge of money's range: a minor-unit count within a few units of int8's either bound, with a
 * fraction of a unit past it, so it lands on, below and above the tie that rounds it out of range.
 */
const edge: Gen<Decimal> = (source) => {
	const bound = source.draw(element([int8Max.value, int8Min.value]))
	const minor = bound + source.draw(bigint(-2n, 2n))
	const fraction = source.draw(
		bigint(-(10n ** BigInt(edgePlaces)) + 1n, 10n ** BigInt(edgePlaces) - 1n)
	)
	const scaled = minor * 10n ** BigInt(edgePlaces) + fraction
	return succeeded(
		Decimal.fromParts(
			scaled < 0n,
			scaled < 0n ? -scaled : scaled,
			moneyFractionDigits.value + edgePlaces
		)
	)
}

/** A batch of up to `max` values, a case's one recordset. */
const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/** Each search's budget beside its draw and literal: no features of its own unless it names them. */
const spec = {
	literal: Formatter.format,
	kept: [],
	runs: 2,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

/** What a refusal case reached: an edge amount PostgreSQL refuses, and one it admits. */
type EdgeFeature = "out of range" | "admitted at the edge"

/** PostgreSQL's answer to one amount cast alone: its money's numeric text, or the SQLSTATE it refused it with. */
const castAlone = (db: RawSession, d: Decimal) =>
	Effect.map(
		Effect.result(db.values("SELECT ($1::text::numeric::money)::numeric::text", [d.toString()])),
		(rows): string =>
			Result.isSuccess(rows)
				? String(rows.success[0]?.[0])
				: defined(pgErrorFields(rows.failure), "a server error").code
	)

layer(Substrate.layer)("money agreement with PostgreSQL", (it) => {
	const monetarySession = Effect.gen(function* () {
		const { session } = yield* Substrate
		const db = yield* session(ownerSession())
		yield* db.values("SET lc_monetary TO 'C.UTF-8'", [])
		yield* db.values("SET lc_numeric TO 'C.UTF-8'", [])
		return db
	})

	it.effect("round-trips every int64 minor-unit count through the numeric wire form", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				return yield* explore(
					{
						oracle: { kind: "postgresql", name: "money's casts from and to numeric and int8" },
						...spec,
						suite: "pg/values/money/round-trip",
						draw: drawn(batchOf(units, 5000)),
						coverage: noCoverage
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

	it.effect("rounds every amount the host admits to money as numeric_cash does", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				return yield* explore(
					{
						oracle: { kind: "postgresql", name: "numeric_cash, the numeric-to-money cast" },
						...spec,
						suite: "pg/values/money/rounding",
						draw: drawn(
							batchOf(
								weighted([
									[8, amount],
									[1, edge]
								]),
								4000
							)
						),
						coverage: noCoverage
					},
					(sample) =>
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
						})
				)
			})
		)
	)

	it.effect("refuses exactly the amounts PostgreSQL refuses as out of range", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const db = yield* monetarySession
				return yield* explore(
					{
						oracle: {
							kind: "postgresql",
							name: "numeric_cash's refusal, 22003, of each amount cast alone"
						},
						...spec,
						runs: 60,
						suite: "pg/values/money/refusal",
						draw: drawn(
							batchOf(
								weighted([
									[3, edge],
									[1, amount]
								]),
								8
							)
						),
						coverage: required<EdgeFeature>(["out of range", "admitted at the edge"], {
							cases: 60,
							sense: notesOnly
						})
					},
					(sample, c) =>
						Effect.gen(function* () {
							for (const d of sample) {
								const host = Money.fromDecimal(d)
								const pg = yield* castAlone(db, d)
								assert.equal(pg, host.ok ? host.value.toString() : "22003", d.toString())
								c.note(host.ok ? "admitted at the edge" : "out of range")
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
						oracle: { kind: "postgresql", name: "money's ORDER BY and count(DISTINCT)" },
						...spec,
						suite: "pg/values/money/order",
						draw: drawn(batchOf(bigint(-50n, 50n), 500)),
						coverage: noCoverage
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
