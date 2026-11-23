/**
 * The diamond and parallel-edge counterexamples of recursive deduplication: a UNION ALL feedback mutant is killed by
 * the diamond case.
 *
 * Each invalid rewrite is the conservative lowering post-processed the way an unsound optimizer would rewrite it, run
 * on PostgreSQL beside the conservative lowering and compared as raw text sets:
 *
 * - feedback UNION ALL on a diamond. Recursive UNION is not replaced with UNION ALL merely because each edge table is
 *   unique, the graph is acyclic, the traversal is depth-bounded, or each transition individually looks unique: two
 *   paths through a diamond can produce the same state. The diamond's edges are a pure set and acyclic, and still, on
 *   every generated diamond rooted at its top, the mutant repeats a state.
 * - a bag recursion on a chain or a tree with parallel edges: no diamond at all, but E keyed by an edge id permits two
 *   distinct edges between the same vertices, so a recursion that trusts each transition to be unique
 *   and drops its deduplication repeats every state below a parallel edge.
 * - erased edge identity before an aggregate: counting the edges that leave the reached vertices by their endpoints
 *   instead of their bound edge id merges the parallel edges, distinct facts, into one contribution (duplicate
 *   elimination never erases a distinct fact merely because its endpoints agree). Without
 *   parallel edges the same rewrite is indistinguishable, which the control population shows.
 *
 * - an endpoint filter moved into the seed. An endpoint filter is not automatically a seed filter: the
 *   completed closure of a chain's or a diamond's top filtered to a vertex below it holds that vertex; the seed filtered
 *   to it holds nothing, so the rewritten recursion is empty (or, seeded on a successor, walks on past it).
 * - a final inequality applied at every state. A predicate on final results is not automatically safe at every
 *   intermediate vertex: on a chain, dropping a vertex inside the recursion drops everything past it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { Array as Arr } from "effect"
import {
	diamondLimits,
	everyCase,
	killsEvery,
	parallelLimits,
	resultLimits
} from "#test/pg/recursion/oracle/counterexamples.fixtures.ts"
import {
	bagRecursion,
	feedbackUnionAllMutant,
	rebuiltAs,
	type RecursionOracleFeature,
	recursiveEquivalence,
	repeatsStates,
	told,
	undercounts
} from "#test/pg/recursion/oracle/support.ts"
import {
	recursiveCaseGen,
	type RecursiveFeature,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"
import { conservative } from "#test/support/oracle/runner.ts"

/** Every generated diamond rooted at its top kills feedback UNION ALL, whatever its vertex type, edge model, seed or state. */
export const diamondKillsFeedbackUnionAll = killsEvery(
	recursiveCaseGen(
		diamondLimits({
			graph: {
				shapes: ["diamond"],
				kinds: vertexKinds,
				edges: "any",
				contained: true,
				second: false,
				blocked: false,
				loops: false,
				minVertices: 4
			},
			forms: ["reach", "walks", "pairs"],
			roots: ["literal", "input", "all", "arms"],
			origin: "any",
			exists: "any",
			oneOrMore: "any",
			minBound: 2,
			maxBound: 4
		})
	),
	{
		situations: [
			...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`),
			"parallel edges"
		] satisfies ReadonlyArray<Reached<RecursionOracleFeature>>,
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and at most
		 * 32 steered cases, the phase that runs only while a required situation is unreached. Its witnesses, the floor and
		 * the steered phase, are fixed by its identity, so every run seed reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property diamondKillsFeedbackUnionAll, its search
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
		 * @workload this property at { runs, steered } of { 300, 300 }, its pre-conversion budget (counterexamples.test.ts at
		 *   4fbc3e95), then { 1, 2000 }, { 13, 2000 }
		 * @result At { 300, 300 }, 375 cases at f1bf91a2f's gate, its kills went red on floor cases 71 and 0. Green, every
		 *   required situation reached by a witness, and every kill killed at { 1, 2000 } (34 cases, 32 steered); { 13, 2000
		 *   } (49 cases, 32 steered); and at { 1, 32 } again under a verdict cache of its own (final1). Worker CPU is a
		 *   loaded machine's and not compared
		 * @decision runs 1 and steered 32, the fewest cases measured: from a floor of 1 or 4 the steered phase reaches every
		 *   situation in 32 cases; both kills are killed at every budget measured, the conservative feedback UNION ALL within
		 *   those witnesses where the floor is too small to reach its case 71. The steered phase stops once every situation
		 *   is reached, so its cap costs no case beyond those it runs. No headroom: a run that reaches fewer situations says
		 *   which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 32 },
		kills: [
			{
				file: "packages/engine/src/lower/conservative/recursive/index.ts",
				original:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })',
				replacement:
					'\tconst body: Select = select({ kind: "setOp", op: "UNION ALL", rows: "operand", arms: [base, step] })',
				why: "The conservative lowering's recursive CTE feeds back with UNION ALL, so repeated states are kept and a cycle never reaches its fixed point."
			},
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		mutant: feedbackUnionAllMutant,
		shape: repeatsStates,
		about: {
			holds: (c) => c.features.includes("diamond") && c.terminatesAsBag,
			otherwise: "no terminating diamond"
		}
	}
)

/** Every generated chain or tree with parallel edges kills a bag recursion from its root. */
export const parallelEdgesKillABagRecursion = killsEvery(
	recursiveCaseGen(
		diamondLimits({
			graph: {
				shapes: ["chain", "tree"],
				kinds: vertexKinds,
				minVertices: 2,
				parallel: "at the root",
				contained: true,
				second: false,
				blocked: false,
				loops: false
			},
			forms: ["reach", "walks"],
			oneOrMore: "any",
			exists: "any",
			origin: "any",
			maxBound: 4
		})
	),
	{
		situations: [],
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no
		 * steered phase, since it requires no situation. Its floor is fixed by its identity, so every run seed judges its
		 * kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property parallelEdgesKillABagRecursion, its search
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
		 * @workload this property at { runs, steered } of { 200, 0 }, its pre-conversion budget (counterexamples.test.ts at
		 *   4fbc3e95), then { 1, 0 }
		 * @result At { 200, 0 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every case passing,
		 *   and every kill killed at { 1, 0 } (2 cases, 0 steered); and at { 1, 0 } again under a verdict cache of its own
		 *   (final1). Worker CPU is a loaded machine's and not compared
		 * @decision runs 1, the fewest a rotating stream runs: its kill is red on floor case 0 at every budget measured;
		 *   steered 0, as it requires no situation.
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		mutant: bagRecursion,
		shape: repeatsStates,
		about: {
			holds: (c) => !c.features.includes("diamond") && c.terminatesAsBag,
			otherwise: "a diamond, or no terminating bag"
		}
	}
)

/** Every generated graph with parallel edges kills the erased edge identity. */
export const parallelEdgesKillTheErasedEdgeIdentity = killsEvery(
	recursiveCaseGen(parallelLimits("always")),
	{
		situations: [],
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no
		 * steered phase, since it requires no situation. Its floor is fixed by its identity, so every run seed judges its
		 * kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property parallelEdgesKillTheErasedEdgeIdentity, its
		 *   search
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
		 * @workload this property at { runs, steered } of { 200, 0 }, its pre-conversion budget (counterexamples.test.ts at
		 *   4fbc3e95), then { 1, 0 }
		 * @result At { 200, 0 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every case passing,
		 *   and every kill killed at { 1, 0 } (2 cases, 0 steered); and at { 1, 0 } again under a verdict cache of its own
		 *   (final1). Worker CPU is a loaded machine's and not compared
		 * @decision runs 1, the fewest a rotating stream runs: its kill is red on floor case 0 at every budget measured;
		 *   steered 0, as it requires no situation.
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		mutant: rebuiltAs("edgeIdentityErased"),
		shape: (o) => undercounts(o, "edges") && !o.comparison.equal,
		about: {
			holds: (c) => c.features.includes("parallel edges"),
			otherwise: "no parallel edges"
		}
	}
)

/** Without parallel edges the erased edge identity is invisible: the same rewrite over keyed edges agrees on every case. */
export const withoutParallelEdgesTheErasedEdgeIdentityAgrees = recursiveEquivalence(
	recursiveCaseGen(parallelLimits("never")),
	rebuiltAs("edgeIdentityErased"),
	conservative,
	{
		oracle: {
			kind: "second-implementation",
			name: "the conservative lowering's raw text sets, which the erased edge identity matches where no edge is parallel"
		},
		situations: [],
		/** Facts repeated under fresh edge ids are parallel edges, which this population excludes. */
		perturb: "planner",
		/**
		 * Its search budget: 1 run of its rotating stream, so a floor of 1 (a quarter of the runs, rounded up), and no
		 * steered phase, since it requires no situation. Its floor is fixed by its identity, so every run seed judges its
		 * kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property withoutParallelEdgesTheErasedEdgeIdentityAgrees,
		 *   its search
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
		 * @workload this property at { runs, steered } of { 200, 0 }, its pre-conversion budget (counterexamples.test.ts, its
		 *   control, at 4fbc3e95), then { 1, 0 }
		 * @result At { 200, 0 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every case passing,
		 *   and every kill killed at { 1, 0 } (2 cases, 0 steered); and at { 1, 0 } again under a verdict cache of its own
		 *   (final1). Worker CPU is a loaded machine's and not compared
		 * @decision runs 1, the fewest a rotating stream runs: its kill is red on floor case 0 at every budget measured;
		 *   steered 0, as it requires no situation.
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 1, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the old test this control was half of caught it (CATCH census, mutant 94e73871bd)."
			}
		]
	}
)

/** Every generated chain, tree or diamond filtered to a vertex its root reaches kills the endpoint filter in the seed. */
export const anEndpointFilterInTheSeedIsKilled = killsEvery(
	recursiveCaseGen(
		resultLimits("endFilter", ["chain", "tree", "diamond"], ["reach", "walks", "pairs"], {
			kind: "reached",
			root: 0
		})
	),
	{
		situations: [
			"shape:chain",
			"shape:tree",
			"shape:diamond",
			"form:reach",
			"form:walks",
			"form:pairs",
			"result filter:param",
			"result filter:literal"
		] satisfies ReadonlyArray<Reached<RecursionOracleFeature>>,
		/**
		 * Its search budget: 13 runs of its rotating stream, so a floor of 4 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property anEndpointFilterInTheSeedIsKilled, its search
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
		 * @workload this property at { runs, steered } of { 200, 200 }, its pre-conversion budget (counterexamples.test.ts at
		 *   4fbc3e95), then { 1, 2000 }, { 13, 2000 }
		 * @result At { 200, 200 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (34 cases, 32 steered); { 13, 2000 } (17
		 *   cases, 0 steered); and at { 13, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 13 and steered 0, the fewest cases measured: a floor of 4 reaches every situation with no steered
		 *   case, where a floor of 1 needs 32; its kill is red on floor case 0 at every budget measured. The steered phase
		 *   stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom: a run that
		 *   reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 13, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		mutant: rebuiltAs("endFilterIntoSeed"),
		shape: told,
		about: everyCase
	}
)

/** Every generated chain without a vertex before its end kills the inequality applied at every state. */
export const anInequalityAtEveryStateIsKilled = killsEvery(
	recursiveCaseGen(
		resultLimits("endNe", ["chain"], ["reach", "pairs"], { kind: "before the chain's end" })
	),
	{
		situations: ["form:reach", "form:pairs"] satisfies ReadonlyArray<
			Reached<RecursionOracleFeature>
		>,
		/**
		 * Its search budget: 5 runs of its rotating stream, so a floor of 2 (a quarter of the runs, rounded up), and no
		 * steered case: its floor reaches every required situation. Its floor is fixed by its identity, so every run seed
		 * reaches its situations and judges its kills alike.
		 *
		 * @limitKind measured
		 * @owner test/pg/recursion/oracle/counterexamples.test.ts's property anInequalityAtEveryStateIsKilled, its search
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
		 * @workload this property at { runs, steered } of { 200, 200 }, its pre-conversion budget (counterexamples.test.ts at
		 *   4fbc3e95), then { 1, 2000 }, { 5, 2000 }
		 * @result At { 200, 200 }, 250 cases at f1bf91a2f's gate, its kill went red on floor case 0. Green, every required
		 *   situation reached by a witness, and every kill killed at { 1, 2000 } (18 cases, 16 steered); { 5, 2000 } (7
		 *   cases, 0 steered); and at { 5, 0 } again under a verdict cache of its own (final1). Worker CPU is a loaded
		 *   machine's and not compared
		 * @decision runs 5 and steered 0, the fewest cases measured: a floor of 2 reaches every situation with no steered
		 *   case, where a floor of 1 needs 16; its kill is red on floor case 0 at every budget measured. The steered phase
		 *   stops once every situation is reached, so its cap costs no case beyond those it runs. No headroom: a run that
		 *   reaches fewer situations says which
		 * @revalidate a red naming an unreached situation; a kill added or changed; an edit to the property's identity (its
		 *   file or name), its generator or its situations; the runner's floor and steering (the toolchain's
		 *   runner/search.ts, random.ts and limits.ts)
		 */
		budget: { runs: 5, steered: 0 },
		kills: [
			{
				file: "packages/engine/src/sql/ast.ts",
				original: '\t\t\treturn body.distinct !== false || body.rows !== "operand"',
				replacement: '\t\t\treturn body.distinct !== false || body.rows === "operand"',
				why: "Operator mutant (comparison) at packages/engine/src/sql/ast.ts:957 in isSetBody: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		],
		mutant: rebuiltAs("neFilterIntoStep"),
		shape: told,
		about: everyCase
	}
)
