/**
 * Each step of a region's chain is joined at every variable a step before it bound (lower/shapes/region chainedSelect,
 * match-region RegionParts conditionsIn): the region's conditions are stated in the chain's order, each variable's
 * bindings equated to its first binding in that order, so each term stands at the step that binds the later of its
 * two classes' first binders, never after it. Before, each variable's bindings were equated to its first binding in
 * placement order, whatever order the chain read the occurrences in: a member the region placed first and the chain
 * read last was each control's one partner at the member's place, so the control the chain read after the one that led
 * it was joined to it at the test's package and path alone, every member's control beside every member's, and the
 * member read for each pair. metis's sitting under R02 (184cd9a4) read three such derivations of a test's 34 members
 * per item, 39,304 rows for each, 765 ms of CPU where its parent read 197 ms.
 *
 * On PostgreSQL 19, a learner's sitting of a test of a few members and then of a hundred more, each member's feedback
 * display and time limit in force, each a union of the stated values and a default list of every section member that
 * states none, beside dozens of other packages' tests and learners, so every relation is dozens of pages; its tables in
 * each pg_class state (test/support/advice.ts PgClassState), the read run under its carried advice once the plan laws
 * hold over it.
 *
 * Oracle: a bound, the read's scans read at most four times the learner's own rows (the sitting, and each member, its
 * section membership and its stated controls), however many members the test holds, in any pg_class state.
 *
 * Features: a test of few members and of many; every member stating its controls, or some none; each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ChainFeature,
	chainBindingTemplate,
	chainGen,
	runChainBinding
} from "#test/pg/lower-shapes/chain-binding.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A learner's sitting with its test's members attached, each with its two controls in force, reads each member's
 * controls once: the control that leads the region's chain binds the member's place, and the other control is read at
 * it, never at the test alone.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const eachStepOfARegionsChainIsReadAtEveryVariableAStepBeforeItBound = property.explore(
	chainGen,
	{
		needs: { stored: Substrate.rolledBack(chainBindingTemplate) },
		situations: [
			"beside few members",
			"beside many members",
			"with every member stating its controls",
			"with some member stating none",
			"its tables never vacuumed",
			"its tables counted empty",
			"its tables analyzed",
			"its tables skewed",
			"its tables large"
		] satisfies ReadonlyArray<Reached<ChainFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runChainBinding(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "bound: the read's scans read at most four times the learner's own rows, a test of a few members and of a hundred more, in any pg_class state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original:
					"\tconst terms = parts\n\t\t.conditionsIn(placed.map((p) => p.part.alias))\n\t\t.flatMap(sqlConjuncts)\n\t\t.map((e) => termOf(e, region))\n",
				replacement:
					"\tconst terms = parts.conditions\n\t\t.flatMap(sqlConjuncts)\n\t\t.map((e) => termOf(e, region))\n",
				why: "The chain states the region's conditions in placement order, as before: each control's place equated only to the member's, which the chain reads last, so the control after the one that leads is joined to it at the test alone, every member's control beside every member's."
			}
		]
	}
)
