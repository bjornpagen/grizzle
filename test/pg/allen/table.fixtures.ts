/** What the properties of table.test.ts read: its spaces, models and helpers. */

import { Array as Arr, String as Str } from "effect"
import { AllenMask } from "#compiler/allen/mask.ts"
import { maskSql } from "#test/support/oracle/allen-sql.ts"
import { type Canonical, type RangeType, spanText } from "#test/support/oracle/allen.ts"

/** What a survey's literal came to in PostgreSQL, for a range type: a stored span, an empty range, or a refusal. */
type Outcome = "a span" | "an empty range" | "a refusal"

export const outcomes: Arr.NonEmptyReadonlyArray<Outcome> = [
	"a span",
	"an empty range",
	"a refusal"
]

export type CanonicalFeature = `${RangeType}: ${Outcome}`

/** The outcome a canonical text names. */
export const outcomeOf = (text: string): Outcome =>
	Str.startsWith("error:")(text) ? "a refusal" : text === "empty" ? "an empty range" : "a span"

export const batchSize = 256

export const canonicalText = (c: Canonical): string =>
	c.kind === "span" ? spanText(c.span) : c.kind === "empty" ? "empty" : `error:${c.sqlstate}`

/**
 * The predicate of a mask over the pair table's columns: its table formula (test/support/oracle/allen-sql.ts), the
 * constant true for the full mask.
 */
export const predicate = (mask: number): string => maskSql(AllenMask(mask), "r1.a", "r1.b")
