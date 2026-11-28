/** What the properties of money.test.ts read: its spaces, models and helpers. */

import { defined } from "@bjornpagen/testing/assert"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { Effect, Result } from "effect"
import { int8Max, int8Min } from "#compiler/ir/carriers.ts"
import { moneyFractionDigits, Numeric } from "#compiler/scalar/values/decimal.ts"
import { succeeded } from "#test/support/assert.ts"
import { pgErrorFields } from "#test/support/substrate/errors.ts"
import type { CaseSession } from "#test/support/substrate/session.ts"

export const units = weighted([
	[6, bigint(int8Min, int8Max)],
	[2, bigint(-100_000n, 100_000n)],
	[1, element([int8Min, int8Max, int8Min + 1n, int8Max - 1n, 0n, -1n, 1n])]
])

/** An amount anywhere: a minor-unit count of up to 21 digits at a scale of up to six places. */
export const amount: Gen<Numeric> = (source) => {
	const minor = source.draw(bigint(-(10n ** 21n), 10n ** 21n))
	const scale = source.draw(int(0, 6))
	return succeeded(Numeric.fromParts(minor < 0n, minor < 0n ? -minor : minor, scale))
}

/** How many places past money's two an edge amount's fraction reaches: on numeric_cash's tie and either side of it. */
const edgePlaces = 2

/**
 * An amount at the edge of money's range: a minor-unit count within a few units of int8's either bound, with a
 * fraction of a unit past it, so it lands on, below and above the tie that rounds it out of range.
 */
export const edge: Gen<Numeric> = (source) => {
	const bound = source.draw(element([int8Max, int8Min]))
	const minor = bound + source.draw(bigint(-2n, 2n))
	const fraction = source.draw(
		bigint(-(10n ** BigInt(edgePlaces)) + 1n, 10n ** BigInt(edgePlaces) - 1n)
	)
	const scaled = minor * 10n ** BigInt(edgePlaces) + fraction
	return succeeded(
		Numeric.fromParts(scaled < 0n, scaled < 0n ? -scaled : scaled, moneyFractionDigits + edgePlaces)
	)
}

/** A batch of up to `max` values, a case's one recordset. */
export const batchOf = <A>(values: Gen<A>, max: number): Gen<ReadonlyArray<A>> =>
	array(values, { min: 1, max })

/** What a refusal case reached: an edge amount PostgreSQL refuses, and one it admits. */
export type EdgeFeature = "out of range" | "admitted at the edge"

/** PostgreSQL's answer to one amount cast alone: its money's numeric text, or the SQLSTATE it refused it with. */
export const castAlone = (db: CaseSession, d: Numeric) =>
	Effect.map(
		Effect.result(db.values("SELECT ($1::text::numeric::money)::numeric::text", [d.toString()])),
		(rows): string =>
			Result.isSuccess(rows)
				? String(rows.success[0]?.[0])
				: defined(pgErrorFields(rows.failure), "a server error").code
	)

/** `db` with money's and numerics' locale settings of the C.UTF-8 locale, set in the case's transaction. */
export const monetarySession = (db: CaseSession) =>
	Effect.gen(function* () {
		yield* db.values("SET lc_monetary TO 'C.UTF-8'", [])
		yield* db.values("SET lc_numeric TO 'C.UTF-8'", [])
		return db
	})

export const source = "jsonb_to_recordset($1::text::jsonb) AS c(ord int4, v text)"
