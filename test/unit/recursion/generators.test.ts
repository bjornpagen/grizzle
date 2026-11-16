/**
 * The graph-shaped recursive generators themselves (test/support/oracle/gen/recursive.ts), whose features every
 * recursion suite's coverage rests on. Host only: these checks need no database.
 *
 * - Each graph shape is the shape it names: a chain is the path 0 -> 1 -> ... -> n-1, a tree n-1 edges into distinct
 *   vertices with no cycle, a diamond holds its four edges and no cycle, a self-loop graph a loop, a dense cycle every
 *   edge i -> i+1 around and a cycle, and parallel edges each an edge of its own id beside its repeats.
 * - terminatesAsBag holds exactly when every recursion's derivations stay finite without deduplication: a walk, or a
 *   traversal of edges with no cycle in the direction it runs.
 *
 * Oracle: each shape's definition as a checker, and a cycle search over the traversed edges (a second implementation).
 * Features: each form, direction and termination the bag search must reach.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { indices } from "#compiler/core/array.ts"
import { assert, containsEqual, like, matchers } from "#test/support/assert.ts"
import {
	defaultRecursiveLimits,
	edgePairs,
	graphSketchGen,
	isAcyclic,
	recursiveCaseSketchGen,
	resolveGraph,
	resolveRecursiveCase
} from "#test/support/oracle/gen/recursive.ts"
import {
	type BagFeature,
	cyclic,
	limits,
	pairsOf
} from "#test/unit/recursion/generators.fixtures.ts"

/**
 * Graph-shaped recursive generators build each graph shape as named.
 *
 * Budget: 600 runs and 0 steered cases, what its suite stated before it became a property
 * (test/unit/recursion/generators.test.ts:39 at 8cad5bce, its runs and its coverage's cases).
 */
export const graphShapedRecursiveGeneratorsBuildEachGraphShapeAsNamed = property.explore(
	graphSketchGen,
	{
		needs: {},
		budget: { runs: 600, steered: 0 },
		situations: [],
		check: () => (sketch) =>
			Effect.gen(function* () {
				const plain = { loops: false, parallel: "never" as const, edges: "set" as const }
				return yield* Effect.sync(() => {
					const chain = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						...plain,
						shapes: ["chain"]
					})
					assert.deepEqual(
						edgePairs(chain),
						Arr.map(indices(chain.n - 1), (i) => [i, i + 1])
					)
					const tree = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						...plain,
						shapes: ["tree"]
					})
					assert.equal(pairsOf(tree).length, tree.n - 1)
					assert.equal(new Set(Arr.map(pairsOf(tree), ([, b]) => b)).size, tree.n - 1)
					assert.equal(isAcyclic(edgePairs(tree), tree.n), true)
					const diamond = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						...plain,
						shapes: ["diamond"],
						minVertices: 4
					})
					like(
						edgePairs(diamond),
						matchers.arrayContaining([
							[0, 1],
							[0, 2],
							[1, 3],
							[2, 3]
						])
					)
					assert.equal(isAcyclic(edgePairs(diamond), diamond.n), true)
					const loop = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						...plain,
						shapes: ["selfLoop"]
					})
					assert.equal(
						Arr.some(edgePairs(loop), ([a, b]) => a === b),
						true
					)
					const dense = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						...plain,
						shapes: ["denseCycle"]
					})
					for (let i = 0; i < dense.n; i++) {
						containsEqual(edgePairs(dense), [i, (i + 1) % dense.n])
					}
					assert.equal(isAcyclic(edgePairs(dense), dense.n), false)
					const parallel = resolveGraph(sketch, {
						...defaultRecursiveLimits.graph,
						parallel: "always"
					})
					assert.equal(parallel.keyed, true)
					assert.ok(parallel.edges.length > edgePairs(parallel).length)
					assert.equal(new Set(Arr.map(parallel.edges, (e) => e.id)).size, parallel.edges.length)
				})
			}),
		oracle: { kind: "specification", name: "each graph shape's definition" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/array.ts",
				original: "\t\tout.push(i)",
				replacement: "\t\t{}",
				why: "Operator mutant (statement) at packages/engine/src/core/array.ts:26 in indices: `out.push(i)` becomes `{}`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	}
)

/**
 * Graph-shaped recursive generators mark the cases whose recursions terminate without feedback deduplication.
 *
 * Budget: 300 runs and 300 steered cases, what its suite stated before it became a property
 * (test/unit/recursion/generators.test.ts:126 at 8cad5bce, its runs and its coverage's cases).
 */
export const graphShapedRecursiveGeneratorsMarkTheCasesWhoseRecursionsTerminateWithoutFeedbackDeduplication =
	property.explore(recursiveCaseSketchGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"reach forward terminates",
			"reach forward loops",
			"reach reverse loops",
			"reach both loops",
			"walks both terminates",
			"pairs forward terminates",
			"pairs forward loops"
		] satisfies ReadonlyArray<Reached<BagFeature>>,
		check: (_, n: Case<BagFeature>) => (sketch) =>
			Effect.gen(function* () {
				const c = resolveRecursiveCase(sketch, limits, "unmutated")
				return yield* Effect.sync(() => {
					const forward = edgePairs(c.graph)
					const traversed =
						c.parts.direction === "forward"
							? forward
							: c.parts.direction === "reverse"
								? Arr.map(forward, ([a, b]) => [b, a] as const)
								: [...forward, ...Arr.map(forward, ([a, b]) => [b, a] as const)]
					const terminates = c.parts.form === "walks" || !cyclic(traversed, c.graph.n)
					n.note(`${c.parts.form} ${c.parts.direction} ${terminates ? "terminates" : "loops"}`)
					assert.equal(c.terminatesAsBag, terminates, c.label)
				})
			}),
		oracle: {
			kind: "second-implementation",
			name: "a cycle search over the edges each recursion traverses"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/array.ts",
				original: "\ta === b || (a.length === b.length && a.every((x, i) => x === b[i]))",
				replacement: "\ta === b || (a.length !== b.length && a.every((x, i) => x === b[i]))",
				why: "Operator mutant (comparison) at packages/engine/src/core/array.ts:16 in sameOrder: `===` becomes `!==`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
