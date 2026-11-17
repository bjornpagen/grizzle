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
 * Features: "out of range" and "admitted at the edge", an edge amount on each side of the refusal.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { bigint } from "@bjornpagen/testing/values"
import { Array as Arr, Effect } from "effect"
import { jsonText } from "#compiler/core/trusted.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import {
	amount,
	batchOf,
	castAlone,
	edge,
	type EdgeFeature,
	monetarySession,
	source,
	units
} from "#test/pg/values/money.fixtures.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { orderOf } from "#test/unit/values/support.ts"

/** Money agreement with PostgreSQL round-trips every int64 minor-unit count through the numeric wire form. */
export const moneyAgreementWithPostgreSQLRoundTripsEveryInt64MinorUnitCountThroughTheNumericWireForm =
	property.explore(batchOf(units, 5000), {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (money.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(sample) =>
				Effect.gen(function* () {
					const { session } = yield* tx
					const db = yield* monetarySession(session)

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
				}),
		oracle: { kind: "postgresql", name: "money's casts from and to numeric and int8" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/money.ts",
				original: '\t\t\t.padStart(moneyFractionDigits + 1, "0")',
				replacement: '\t\t\t.padStart(moneyFractionDigits, "0")',
				why: "Money.toString pads its digits one short, so an amount below one unit loses its leading zero."
			}
		]
	})

/** Money agreement with PostgreSQL rounds every amount the host admits to money as numeric_cash does. */
export const moneyAgreementWithPostgreSQLRoundsEveryAmountTheHostAdmitsToMoneyAsNumericCashDoes =
	property.explore(
		batchOf(
			weighted([
				[8, amount],
				[1, edge]
			]),
			4000
		),
		{
			needs: { tx: Substrate.transaction },
			situations: [],
			/** Its pre-conversion budget: runs 2, no coverage (money.test.ts at 4fbc3e95). */
			budget: { runs: 2, steered: 0 },
			check:
				({ tx }) =>
				(sample) =>
					Effect.gen(function* () {
						const { session } = yield* tx
						const db = yield* monetarySession(session)

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
					}),
			oracle: { kind: "postgresql", name: "numeric_cash, the numeric-to-money cast" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/decimal.ts",
					original: "\treturn (c % divisor) * 2n >= divisor ? q + 1n : q",
					replacement: "\treturn (c % divisor) * 2n > divisor ? q + 1n : q",
					why: "roundHalfAway rounds a tie toward zero."
				}
			]
		}
	)

/** Money agreement with PostgreSQL refuses exactly the amounts PostgreSQL refuses as out of range. */
export const moneyAgreementWithPostgreSQLRefusesExactlyTheAmountsPostgreSQLRefusesAsOutOfRange =
	property.explore(
		batchOf(
			weighted([
				[3, edge],
				[1, amount]
			]),
			8
		),
		{
			needs: { tx: Substrate.transaction },
			situations: ["out of range", "admitted at the edge"] satisfies ReadonlyArray<
				Reached<EdgeFeature>
			>,
			/** Its pre-conversion budget: runs 60, coverage cases 60 (money.test.ts at 4fbc3e95). */
			budget: { runs: 60, steered: 60 },
			check:
				({ tx }, c: Case<EdgeFeature>) =>
				(sample) =>
					Effect.gen(function* () {
						const { session } = yield* tx
						const db = yield* monetarySession(session)

						for (const d of sample) {
							const host = Money.fromDecimal(d)
							const pg = yield* castAlone(db, d)
							assert.equal(pg, host.ok ? host.value.toString() : "22003", d.toString())
							c.note(host.ok ? "admitted at the edge" : "out of range")
						}
					}),
			oracle: {
				kind: "postgresql",
				name: "numeric_cash's refusal, 22003, of each amount cast alone"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/scalar/values/money.ts",
					original: "\t\tif (minorUnits < int8Min || minorUnits > int8Max) {",
					replacement: "\t\tif (minorUnits < int8Min || minorUnits > int8Max + 1n) {",
					why: "Money.make admits int8Max + 1."
				}
			]
		}
	)

/** Money agreement with PostgreSQL orders and deduplicates money by its minor units. */
export const moneyAgreementWithPostgreSQLOrdersAndDeduplicatesMoneyByItsMinorUnits =
	property.explore(batchOf(bigint(-50n, 50n), 500), {
		needs: { tx: Substrate.transaction },
		situations: [],
		/** Its pre-conversion budget: runs 2, no coverage (money.test.ts at 4fbc3e95). */
		budget: { runs: 2, steered: 0 },
		check:
			({ tx }) =>
			(sample) =>
				Effect.gen(function* () {
					const { session } = yield* tx
					const db = yield* monetarySession(session)

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
				}),
		oracle: { kind: "postgresql", name: "money's ORDER BY and count(DISTINCT)" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/money.ts",
				original:
					"\t\treturn this.minorUnits < that.minorUnits ? -1 : this.minorUnits > that.minorUnits ? 1 : 0",
				replacement:
					"\t\treturn this.minorUnits * this.minorUnits < that.minorUnits * that.minorUnits ? -1 : this.minorUnits * this.minorUnits > that.minorUnits * that.minorUnits ? 1 : 0",
				why: "Money.compare orders by magnitude."
			}
		]
	})
