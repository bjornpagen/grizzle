/** What the generated refresh oracle's property reads: its situations, its aims and its budget. */

import type { Reached } from "@bjornpagen/testing/features"
import { constant, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { aggregateKeys, type CaseSketch, plantedAggregates } from "#test/pg/derived/oracle/gen.ts"
import type { DerivedFeature } from "#test/pg/derived/oracle/property.ts"

/** The generated refresh oracle's search budget per seed, of the four seeds its Vitest suites ran. */
export const casesPerSeed = 200

/** What every seed's cases must reach, so the oracle is not vacuous: every feature a case notes, each aggregate over
 * every kind it takes, the four over an aggregate's own result planted (`plantedNumSketchGen`), and a second reading
 * over a respelled value. */
export const situations: Arr.NonEmptyReadonlyArray<DerivedFeature> = [
	"form rule",
	"form union",
	"form take",
	"level 2",
	"level 3",
	"negation",
	...aggregateKeys,
	"plain statements",
	"concurrent statements",
	"nonempty views",
	"no-change checks",
	"unaffected-view checks",
	"multi-view commits",
	"unpopulated reads",
	"identical reloads",
	"reordered reloads",
	"base changes",
	"a fact respelled on a second reading"
]

/**
 * Every aggregate over every kind it takes, planted (gen.ts plantedAggregates): the aim of each aggregate's situation,
 * which the search kept by value and replayed on every run; it never caught a bug (git log -S on the module).
 */
export const aggregateAims: ReadonlyArray<readonly [Reached<DerivedFeature>, Gen<CaseSketch>]> =
	Arr.map(aggregateKeys, (key) => [key, constant(plantedAggregates)] as const)
