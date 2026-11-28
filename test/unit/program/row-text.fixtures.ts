/** What the property of row-text.test.ts reads: a query of two texts, a set and a numeric, and a box of its rows. */
import { Array as Arr } from "effect"
import { Bits, Decimal } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import type { HeadOf } from "#compiler/types/query/query.ts"
import { succeeded } from "#test/support/assert.ts"
import { Item, Rec, Tier } from "#test/support/unit/program/records.fixtures.ts"

/** The query: Item's two refined texts, its set over Tier and its numeric of scale 2, beside a head literal. */
export const textQuery = query(Rec).rule((r) => {
	const { word, name, tiers, dec } = v(Item, "item")
	return r.match(Item, { word, name, tiers, dec }).find({ word, name, tiers, dec, kind: "found" })
})

/** A row of the query. */
export type TextRow = HeadOf<typeof textQuery>

const decimal = (text: string): Decimal =>
	succeeded(Decimal.fromString(text), `the Decimal ${text}`)

/**
 * The box: every row of words "a", "ab" and "b", names "", "c" and "bc", the sets {}, {Low}, {Low, Mid} and {Mid, Low}
 * (one set, its members in another order), and the numerics 1.5 and 1.50 (one value, two spellings): rows whose texts
 * concatenated without frames meet ("ab" then "c", "a" then "bc"), and rows that are one row however spelled.
 */
export const textRows: Arr.NonEmptyReadonlyArray<TextRow> = Arr.flatMap(
	["a", "ab", "b"] as const,
	(word) =>
		Arr.flatMap(["", "c", "bc"] as const, (name) =>
			Arr.flatMap(
				[
					Bits.of(Tier, []),
					Bits.of(Tier, ["Low"]),
					Bits.of(Tier, ["Low", "Mid"]),
					Bits.of(Tier, ["Mid", "Low"])
				] as const,
				(tiers) =>
					Arr.map([decimal("1.5"), decimal("1.50")] as const, (dec): TextRow => ({
						word,
						name,
						tiers,
						dec,
						kind: "found"
					}))
			)
		)
)

/** Whether two rows are one row: each text equal, each set of one membership, each numeric one value. */
export const sameRow = (a: TextRow, b: TextRow): boolean =>
	a.word === b.word &&
	a.name === b.name &&
	a.tiers.size === b.tiers.size &&
	Arr.every([...a.tiers], (handle) => b.tiers.has(handle)) &&
	a.dec.equals(b.dec)
