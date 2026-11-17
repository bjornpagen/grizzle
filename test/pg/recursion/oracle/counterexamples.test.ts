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
		/** Its pre-conversion budget: runs 300, coverage cases 300 (counterexamples.test.ts at 4fbc3e95). */
		budget: { runs: 300, steered: 300 },
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
		/** Its pre-conversion budget: runs 200, no coverage (counterexamples.test.ts at 4fbc3e95). */
		budget: { runs: 200, steered: 0 },
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
		/** Its pre-conversion budget: runs 200, no coverage (counterexamples.test.ts at 4fbc3e95). */
		budget: { runs: 200, steered: 0 },
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
		/** Its pre-conversion budget: runs 200, no coverage (counterexamples.test.ts, its control, at 4fbc3e95). */
		budget: { runs: 200, steered: 0 },
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
		/** Its pre-conversion budget: runs 200, coverage cases 200 (counterexamples.test.ts at 4fbc3e95). */
		budget: { runs: 200, steered: 200 },
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
		/** Its pre-conversion budget: runs 200, coverage cases 200 (counterexamples.test.ts at 4fbc3e95). */
		budget: { runs: 200, steered: 200 },
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
