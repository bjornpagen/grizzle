/**
 * A rule's judge reads its region as the set of bindings a transaction's writes give it, never as the bag of rows it
 * wrote: a step of a chain runs once per row of the occurrences before it (ir/rel.ts Step), so every occurrence before a
 * step is made distinct (analysis/physical/consumers.ts), and a whole rule's region of unit keys is a step of its own
 * (analysis/theory/unit.ts regionOf), made distinct before the rule's step reads it. On PostgreSQL 19, over
 * ProbedRegion and WholeRegion (rule-region.fixtures.ts): T keyed by its unit, Stated, a derived relation of each unit's
 * g, and a rule over Stated, a key by the unit, probed, or a check, judged whole.
 *
 * Each case writes rows of one unit that all state one g, so they derive one fact, and explains every judged statement
 * over the deltas that hold them, before the judge reads them, since it deletes them once its statements have; then
 * writes three times as many rows of the unit and explains them again over the deltas that hold them all. Without the set, a probe's
 * region and a whole rule's repeat their binding once per row, and the read of the unit after it runs once per repeat,
 * the work of a whole package's publish squared: pantry's key over SourcePointer by package read the 37,578 node rows
 * g3-11 wrote once for each of them, 1,412,106,084 rows filtered away (SELECTWHOLE's auto_explain at ce22f1f35).
 *
 * Oracle: universal, bound: each judged statement's work, every row each node of its plan handles over all of its
 * loops, grows under eight times for four times the rows that derive one fact.
 *
 * Features: a probed rule's region, and a whole rule's.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	probedRegionTemplate,
	type RepeatsFeature,
	repeatsGen,
	runRepeats,
	wholeRegionTemplate
} from "#test/pg/laws/rule-region.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A rule's judge reads the rows a transaction wrote as the set of bindings they give it: its work grows with the rows,
 * never with their square, where every row derives one fact.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRulesJudgeReadsItsRegionAsTheSetOfBindingsItsRowsGiveNeverOnceAgainPerRowThatDerivesTheSameFact =
	property.explore(repeatsGen, {
		needs: {
			whole: Substrate.rolledBack(wholeRegionTemplate),
			probed: Substrate.rolledBack(probedRegionTemplate)
		},
		situations: [
			"a probed rule's region",
			"a whole rule's region"
		] satisfies ReadonlyArray<RepeatsFeature>,
		check:
			({ whole, probed }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* drawn.judged === "probed" ? probed : whole
					yield* runRepeats(value, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: each judged statement's work grows under eight times for four times the rows that derive one fact"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/consumers.ts",
				original:
					'\t\t\t\tnode.occurrences.slice(at + 1).some((later) => later.source.kind === "Step")',
				replacement: "\t\t\t\tfalse",
				why: "An occurrence before a step passes its repeats on, so a probe's region delivers one binding per row it read of the delta and a whole rule's region one unit per row, and the read of the unit after it runs once per row: each box's work grows sixteen times for four times the rows."
			},
			{
				file: "packages/engine/src/analysis/theory/unit.ts",
				original: '\t\tsource: { kind: "step", query: queryOf([first, ...more], loc), bind: {} },',
				replacement:
					'\t\tsource: { kind: "query", query: queryOf([first, ...more], loc), bind: {} },',
				why: "A whole rule's region is an import, which the rewrites inline into the region that reads it, so the occurrence before the rule's step is the delta itself, a set by its own key with the unit once per row, and the step runs once per row: the whole box's work grows sixteen times for four times the rows."
			}
		]
	})
