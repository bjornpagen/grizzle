/**
 * The recursion equivalence suite.
 *
 * Seeded graph-shaped recursive queries over chains, trees, diamonds, self-loops, dense cycles, random graphs,
 * parallel edges and multiple roots carrying origin, each run on PostgreSQL 19 through the conservative lowering and
 * computed by definition through the reference evaluator, compared statement by statement as raw text sets with
 * no repeated row on the lowering's side (every statement delivers a set). The population covers every
 * recursion family (endpoint closure, bounded computed walks, left- and right-linear pair closure), every root binding
 * (a parameter, a literal, a relation parameter of roots that may repeat or name no vertex, every vertex, two base
 * arms), zero-or-more and one-or-more seeds, all three directions and alternative edge relations as
 * factored transition arms, explicit existence matches over dangling edges,
 * negation of a fixed relation and of an earlier completed stratum in the step, and every consumer: the
 * complete state, a state-dropping projection, a minimum-length filter, aggregates over
 * the completed recursion and over its edges by edge id, two differently bound imports, a
 * second recursive stage, an attachment by origin, a negated completed closure, and
 * predicates on the completed recursion's end vertex and origin, which an optimizer must not push into
 * the seed or the step unless they name the origin. Text vertices are seeded from relation parameters and parent-key
 * recordsets like every other type.
 *
 * recursiveEquivalence is the reusable form: the graph suite runs the same population with the optimized lowering on the left
 * and the conservative lowering on the right.
 *
 * Its cases are CPU-bound.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { equivalenceSituations } from "#test/pg/recursion/oracle/equivalence.fixtures.ts"
import {
	type RecursionOracleFeature,
	recursiveEquivalence
} from "#test/pg/recursion/oracle/support.ts"
import { defaultRecursiveLimits, recursiveCaseGen } from "#test/support/oracle/gen/recursive.ts"
import { conservative, reference } from "#test/support/oracle/runner.ts"

/**
 * Recursive queries agree, the conservative lowering against the reference evaluator, on seeded graph-shaped recursive
 * queries of every shape, family, binding and consumer, with no repeated row.
 */
export const conservativeAgainstReference = recursiveEquivalence(
	recursiveCaseGen(defaultRecursiveLimits),
	conservative,
	reference,
	{
		oracle: {
			kind: "second-implementation",
			name: "the reference evaluator, computing each recursion by definition"
		},
		situations: equivalenceSituations satisfies ReadonlyArray<Reached<RecursionOracleFeature>>,
		perturb: "all",
		/**
		 * Its search budget: 61 runs of its rotating stream, so a floor of 16 (a quarter of the runs, rounded up), and at
		 * most 32 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor
		 * and the steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills
		 * alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/equivalence.test.ts's property, its search
		 * @unit cases: the rotating stream's runs, and the steered phase's most
		 * @scope one run of the property, on any run seed: its kept cases, its floor, its steered phase and its rotating
		 *   stream
		 * @evidence ~/.cache/grizzle/CULL-PAGEREC-notes: kills0.log, `toolchain-test kills test/pg/recursion
		 *   test/pg/page/generated-optimized.test.ts` at the pre-conversion budgets, each kill's first red witness printed by
		 *   a local line in the kills command's report, never committed; m1run.log and m2run.log with their run records
		 *   m1run.json and m2run.json, `toolchain-test run` of the module at the budgets in @workload, every kill judged
		 *   after its search and none answered by a cached verdict; final1.log and final1.json, the same at this budget under
		 *   a verdict cache of its own; each run under TEST_SEED=2219874524, its budget rewritten for the run
		 * @observed 2026-11-23 03:27 to 04:39 UTC
		 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, shared with other lanes' runs (1-minute
		 *   load 390 to 550); PostgreSQL 19.0, the in-memory family grizzle-m-cull-pagerec, two members settled by
		 *   toolchain-pg settle; grizzle f87b2aaab with test/pg/page's cull; vendor/toolchain 2cc4817; Node 26.13.1
		 * @workload this property at { runs, steered } of { 3200, 3200 }, its pre-conversion budget (equivalence.test.ts at
		 *   4fbc3e95, twice its 1,600 cases), then { 1, 2000 }, { 61, 2000 }
		 * @result At { 3200, 3200 }, 4000 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (210 cases, 208 steered); { 61, 2000 } (109
		 *   cases, 32 steered); and at { 61, 32 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 61 and steered 32, the fewest cases measured: from a floor of 16 the steered phase reaches every
		 *   situation in 32 cases, from a floor of 1 in 208; its kill is red on floor case 0 at every budget measured. The
		 *   steered phase stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom:
		 *   a run that reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 61, steered: 32 },
		kills: [
			{
				file: "packages/engine/src/lower/conservative/recursive/index.ts",
				original:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })',
				replacement:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, base] })',
				why: "The conservative lowering's recursive CTE unions its base with itself where its step belongs (lower/conservative/recursive), so it never steps past its seeds."
			}
		]
	}
)
