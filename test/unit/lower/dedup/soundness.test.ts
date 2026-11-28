/**
 * Placement is sound on the rows themselves.
 *
 * One population: the oracle generator's query cases, its rooted counterexample cases for what it seldom builds at a
 * root (projections, keyed and fan-out joins, witnesses, groups, projected groups, unions told apart by their tags and
 * not, bounds under EXISTS, closures acyclic or not), and noninjective key expressions; each read in a snapshot or a
 * transaction, its root delivered as it is or as an ordered result over its whole heading, every choice drawn with the
 * case. The plan's realization is evaluated by the fragment evaluator, which keeps exactly the repeats each fragment's
 * SQL would deliver (test/support/unit/analysis/physical/support.ts FragmentReference), and checked against the brute-force
 * reference, which deduplicates every node as the conservative lowering does:
 *
 * - the program's result has no repeated row and is exactly the reference set;
 * - every consumer that observes repeats, a fold, a bound, a page, an attachment, sees an input with one row per value
 *   of the heading it needs; a fold reads every row its input's fragment delivers, so a repeat that reaches one also
 *   changes the program's result;
 * - the kernel verification's recomputation (oracle/verify/multiplicity.ts) finds no problem in the plan.
 *
 * The population must reach every source, every rooted form, both contexts, an ordered delivery, a placed and an elided
 * duplicate elimination, and a delivery the reference evaluated, so a search that silently checks nothing fails.
 * "Unknown evidence gets conservative duplicate elimination, never guessed uniqueness": one counterexample fails the
 * suite.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { genCatalog } from "#test/support/evidence.ts"
import { unobserved } from "#test/support/oracle/reference/evaluate.ts"
import { noFunctions } from "#test/support/oracle/reference/functions.ts"
import {
	type DedupFeature,
	dedupFeatures,
	orderedRoot,
	sound,
	soundCases
} from "#test/unit/lower/dedup/soundness.fixtures.ts"

/**
 * Placement delivers the reference set with no repeats on generated, rooted and noninjective cases in either context,
 * ordered or not.
 *
 * Budget: 1000 runs and 1000 steered cases, what its suite stated before it became a property
 * (test/unit/lower/dedup/soundness.test.ts:232 at 8cad5bce, its runs and its coverage's cases).
 */
export const placementDeliversTheReferenceSetWithNoRepeatsOnGeneratedRootedAndNoninjectiveCasesInEitherContextOrderedOrNot =
	property.explore(soundCases, {
		needs: {},
		budget: { runs: 1000, steered: 1000 },
		situations: dedupFeatures satisfies ReadonlyArray<Reached<DedupFeature>>,
		check: (_, c: Case<DedupFeature>) => (k) =>
			Effect.sync(() => {
				const input = {
					schema: k.c.schema,
					facts: k.c.facts,
					params: k.c.query.params,
					functions: noFunctions,
					observer: unobserved
				}
				const dag = k.ordered ? orderedRoot(k.c.query.dag) : k.c.query.dag
				sound(
					dag,
					input,
					{ context: k.context, catalog: genCatalog(input.schema), roots: "result" },
					c
				)
				c.note(k.source)
				c.note(k.context)
				if (k.ordered) {
					c.note("an ordered delivery")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the brute-force reference, which deduplicates every node"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/analyze.ts",
				original:
					'\t\t\tchanged.has(node.id) ||\n\t\t\t(node.kind === "SelfRef" && changed.has(node.recursive)) ||\n\t\t\tinputsOf(node).some((input) => again.has(input))',
				replacement:
					'\t\t\t(node.kind === "SelfRef" && changed.has(node.recursive)) || inputsOf(node).some((input) => again.has(input))',
				why: 'Operator mutant (disjunct) at packages/engine/src/analysis/physical/analyze.ts:129 in reanalyzePhysical: `changed.has(node.id) ||\n\t\t\t(node.kind === "SelfRef" && changed.has(node.recursiv` becomes `(node.kind === "SelfRef" && changed.has(node.recursive)) || inputsOf(node).some(`; the property fails (lane CATCH, grizzle 0baff5d6).'
			},
			{
				file: "packages/engine/src/analysis/physical/analyze.ts",
				original:
					'\t\t\tchanged.has(node.id) ||\n\t\t\t(node.kind === "SelfRef" && changed.has(node.recursive)) ||\n\t\t\tinputsOf(node).some((input) => again.has(input))',
				replacement:
					'\t\t\t(node.kind === "SelfRef" && changed.has(node.recursive)) || inputsOf(node).some((input) => again.has(input))',
				why: 'Operator mutant (disjunct) at packages/engine/src/analysis/physical/analyze.ts:129 in reanalyzePhysical: `changed.has(node.id) ||\n\t\t\t(node.kind === "SelfRef" && changed.has(node.recursiv` becomes `(node.kind === "SelfRef" && changed.has(node.recursive)) || inputsOf(node).some(`; the property fails (lane CATCH, grizzle 0baff5d6).'
			}
		]
	})
