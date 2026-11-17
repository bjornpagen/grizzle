/**
 * The UNION ALL feedback mutant against the optimized lowering: a UNION ALL feedback mutant is killed by the diamond
 * case.
 *
 * The mutant is applied in the shape an optimizer emits: the V6 form, recursive UNION with plain seed and step
 * SELECTs, with that UNION then turned into UNION ALL. The optimized lowering is that V6 form (its seed, step and
 * feedback scan carry no DISTINCT, test/pg/recursion/lowering/walks.test.ts), so the mutant here is its own output with
 * each recursion's feedback union made UNION ALL: the recursive CTE's UNION (lower/shapes/recursion). Two paths
 * through a diamond can produce the same state, although the diamond's edges are a pure set, it is acyclic and the
 * walk is bounded; on every generated diamond rooted at its top the mutant repeats a state the optimized lowering
 * delivers once, with the same distinct rows, a bounded walk and an unbounded one alike. Each case's program shows its
 * recursion as a WITH RECURSIVE, observed over the whole statement AST.
 */

import type { Reached } from "@bjornpagen/testing/features"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter } from "effect"
import { formsHold, reachableRecursions } from "#test/pg/recursion/graph/support.ts"
import {
	type DiamondFeature,
	diamondCases,
	diamondSituations,
	NotKilled,
	run,
	sites
} from "#test/pg/recursion/lowering/counterexamples.fixtures.ts"
import {
	optimizedFeedbackUnionAll,
	optimizedLowering
} from "#test/pg/recursion/lowering/support.ts"
import { repeatsStates } from "#test/pg/recursion/oracle/support.ts"
import { oracleProperty, printOutcome } from "#test/support/oracle/runner.ts"

/** Every generated diamond rooted at its top kills the optimized lowering's UNION ALL feedback mutant, whatever its vertex type, edges, seed or state. */
export const diamondKillsTheOptimizedFeedbackUnionAll = oracleProperty(diamondCases, {
	situations: diamondSituations satisfies ReadonlyArray<Reached<DiamondFeature>>,
	perturb: "none",
	oracle: {
		kind: "second-implementation",
		name: "the optimized lowering, which the UNION ALL feedback mutant must break on the diamond"
	},
	kept: [],
	/** Its pre-conversion budget: runs 300, coverage cases 300 (counterexamples.test.ts at 4fbc3e95). */
	budget: { runs: 300, steered: 300 },
	kills: [
		{
			file: "packages/engine/src/lower/shapes/recursion/index.ts",
			original: '\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION", arms: [base, step] }),',
			replacement:
				'\t\t\t\t\tquery: select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
			why: "The optimized lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
		}
	],
	show: Formatter.format,
	check: (notes: Case<DiamondFeature>) => (c) =>
		Effect.gen(function* () {
			notes.noteAll(c.features)
			if (!c.features.includes("diamond") || !c.terminatesAsBag) {
				return yield* new NotKilled({
					message: `not a terminating diamond: ${Arr.join(c.features, ", ")}`
				})
			}
			const counted = sites(c)
			const recursions = reachableRecursions(c.query.dag.roots[0])
			if (!formsHold(recursions, counted.recursive)) {
				return yield* new NotKilled({
					message: `${recursions} reachable recursions, a WITH RECURSIVE shown: ${counted.recursive}`
				})
			}
			if (counted.sites === 0) {
				return yield* new NotKilled({
					message: "the mutant found no feedback union to rewrite"
				})
			}
			const outcome = yield* run(c, optimizedLowering("optimized"), optimizedFeedbackUnionAll)
			if (!repeatsStates(outcome)) {
				return yield* new NotKilled({ message: `not killed:\n${printOutcome(outcome)}` })
			}
			notes.note("killed")
		})
})
