/**
 * A derived relation read by its whole key is read at that key in every rule, and so is every relation a reader joins to
 * it at the values it delivers (lower/shapes/share/keys.ts KeyAnalysis, cte-policy keyedRegionChain, share/sites.ts
 * regionChain): edullm's AttemptValueAt, an attempt's values instant, two rules, each keyed by the attempt (an answer
 * attempt's own instant, or the instant of the save a submission names), read at an attempt's key is one seek of each
 * rule's relations by its key, the union derived at the key and never whole, no relation scanned, and a read joining it
 * to the values
 * recorded at the instant seeks the values at (learner, instant) beside it. The bound, from first principles: the key
 * reaches the attempt's answer, or its submission and the one save it names, and the values at its instant, each a seek
 * of a B-tree, O(k log n) for the k rows reached, however many learners the store holds.
 *
 * On PostgreSQL 19 (keyed-reach.fixtures.ts): a few children's attempts, the odd ones answers and the even ones
 * submissions of a save of their own, each instant's values; the read of child 1's answer or submission, its instant
 * alone or its values; then a few hundred children more.
 *
 * Oracle: the plan laws over the read under its carried advice (test/support/advice.ts), Law 2 among them: every column
 * of a relation's key the read binds, the learner among them, is its scan's index condition, inside a CTE as anywhere;
 * and the bound, the read's scans, explained with ANALYZE, read at most twice the rows its key reaches, beside a few
 * children and beside a few hundred, in any pg_class state.
 *
 * Features: an answer's instant and a submission's save's, the values at the instant, and each pg_class state.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type KeyedReachFeature,
	keyedReachGen,
	keyedReachTemplate,
	runKeyedReach
} from "#test/pg/lower-shapes/keyed-reach.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * An attempt's values instant, a derived relation of two rules each keyed by the attempt, read at the attempt's key,
 * alone or joined to the values recorded then, seeks each relation it reads by its key, its union materialized nowhere,
 * and reads the rows that key reaches alone however many learners stand beside it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aDerivedRelationReadByItsWholeKeySeeksEachRuleAndEachRelationJoinedToItAtThatKey =
	property.explore(keyedReachGen, {
		needs: { stored: Substrate.rolledBack(keyedReachTemplate) },
		situations: [
			"an answer's instant",
			"a submission's save's instant",
			"the values at the instant",
			"its tables never vacuumed",
			"its tables counted empty",
			"its tables analyzed",
			"its tables skewed",
			"its tables large"
		] satisfies ReadonlyArray<Reached<KeyedReachFeature>>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { connection, value } = yield* stored
					yield* runKeyedReach(value.installed, connection, drawn, c)
				}),
		oracle: {
			kind: "universal",
			name: "the plan laws under the read's carried advice, Law 2's every key column the read binds an index condition, inside a CTE as anywhere; and the bound, the read's scans read at most twice the rows its key reaches, beside a few children and a few hundred more, in any pg_class state"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\tif (heldSet(source) && leadOf(source) === "key") {\n',
				replacement: '\t\tif (heldSet(source) && leadOf(source) === "held") {\n',
				why: "A held set its values bind at a key ranks below a stored relation its values bind at a unit: the values are read first at the learner alone, every value of the learner, then joined to the attempt's instant."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\tcase "Filter": {\n\t\t\tconst region = node.input\n',
				replacement:
					'\t\tcase "Filter": {\n\t\t\treturn leadOf(node.input)\n\t\t\tconst region = node.input\n',
				why: "A filter that holds its region's key at the call's values proves no rank: the attempt's instant, each rule read at the attempt's key by a filter, ranks below the values the learner binds, which are read first at the learner alone."
			}
		]
	})
