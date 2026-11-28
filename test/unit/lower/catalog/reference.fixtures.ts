/** What the properties of reference.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import type { QueryDesc } from "#test/support/fixtures/ir/desc.ts"
import * as Q from "#test/support/pg/catalog/queries.ts"

/** The entries, one per target form the catalog lowers to. */
export const entries: Arr.NonEmptyReadonlyArray<readonly [label: string, desc: QueryDesc]> = [
	["ordinal asc", Q.ordinal(["asc", "asc"])],
	["ordinal day desc, id asc", Q.ordinal(["desc", "asc"])],
	["running aggregates", Q.running(Q.plainSelfMatch)],
	["successor bound", Q.boundNeighbor("next", [], "every")],
	["as-of le bound", Q.boundAsOf("le", [], "day", "every")],
	["grouped share", Q.groupedShare("Sitting", false)],
	["keyed share", Q.keyedShare(false)],
	["discrete percentile", Q.discretePercentile([0.5], Q.ordinalStage)],
	["continuous percentile", Q.continuousPercentile(0.5, "score")],
	["mode of days", Q.modeOfDays("asc", Q.plainMode)]
]

export type JudgedFeature = `judged: ${string}`

export const judged: Arr.NonEmptyReadonlyArray<JudgedFeature> = Arr.map(
	entries,
	([label]): JudgedFeature => `judged: ${label}`
)
