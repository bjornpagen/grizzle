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
	/**
	 * Its search budget: 61 runs of its rotating stream, so a floor of 16 (a quarter of the runs, rounded up), and at most
	 * 16 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and the
	 * steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
	 *
	 * @limitKind measured
	 * @owner test/pg/recursion/lowering/counterexamples.test.ts's property, its search
	 * @unit cases: the rotating stream's runs, and the steered phase's most
	 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
	 *   stream
	 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
	 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
	 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
	 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged after
	 *   its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under a
	 *   verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
	 * @observed 2026-11-23 03:27 to 04:39 UTC
	 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
	 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
	 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
	 * @workload this property at { runs, steered } of { 300, 300 }, its pre-conversion budget (counterexamples.test.ts at
	 *   4fbc3e95), then { 1, 2000 }, { 61, 2000 }
	 * @result At { 300, 300 }, 375 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
	 *   situation reached by a witness, and every kill killed at { 1, 2000 } (130 cases, 128 steered); { 61, 2000 } (93
	 *   cases, 16 steered); and at { 61, 16 } again under a verdict cache of its own (final1). Worker CPU is a loaded
	 *   machine's and not compared
	 * @decision runs 61 and steered 16, the fewest cases measured: from a floor of 16 the steered phase reaches every
	 *   situation in 16 cases, from a floor of 1 in 128; its kill is red on floor case 0 at every budget measured. The
	 *   steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom: a
	 *   run that reaches fewer situations says which
	 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
	 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's runner/search.ts,
	 *   random.ts and limits.ts)
	 */
	budget: { runs: 61, steered: 16 },
	kills: [
		{
			file: "packages/engine/src/lower/shapes/recursion/index.ts",
			original: '\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION", arms: [base, step] }),',
			replacement:
				'\t\t\t\t\t\tselect({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] }),',
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
