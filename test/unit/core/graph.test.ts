/**
 * The walks of a directed graph (packages/engine/src/core/graph.ts) by which the engine orders what reads what: the
 * strongly connected components a walk from some roots meets, which the termination check counts a recursion's state
 * columns by, the law model finds the foreign key cycles by and the key analysis factors a table's minimal keys by.
 *
 * - Components: over drawn graphs of a few vertices (self loops, repeated successors, roots drawn twice, vertices no
 *   root reaches), stronglyConnected gives exactly the components of mutual reachability among the vertices the roots
 *   reach, each once, in the order a depth-first walk finishes each component's first entered vertex, each component's
 *   vertices last entered first. Oracle: a recursive depth-first walk numbering entries and finishes, and each vertex's
 *   reach by a search of its own, the definitions read directly.
 * - Depth: a chain of any depth, past what a small stack's recursion holds, open or closed into one component, walks.
 *   Oracle: the chain's own construction.
 * - postorder's properties are the relational DAG's traversals (test/unit/ir/dag.test.ts), which read it.
 *
 * Features: a cycle of several vertices, a self loop, an edge into a component already closed, a root already entered,
 * a vertex no root reaches; a chain a recursion holds and one past it, open and closed.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { stronglyConnected } from "#compiler/core/graph.ts"
import { assert } from "#test/support/assert.ts"
import {
	type Chain,
	type ChainWalkFeature,
	chainComponents,
	expectedComponents,
	type GraphFeature,
	graphFeatures,
	graphGen,
	successorsOf,
	walked
} from "#test/unit/core/graph.fixtures.ts"
import { chainDepth, smallStackRecursion } from "#test/unit/ir/dag.fixtures.ts"

/**
 * stronglyConnected gives every component of mutual reachability the roots reach once, in the order a depth-first
 * walk finishes its first entered vertex, its vertices last entered first.
 */
export const stronglyConnectedGivesEveryComponentTheRootsReachOnceInTheOrderADepthFirstWalkFinishesItsFirstEnteredVertex =
	property.explore(graphGen, {
		needs: {},
		situations: [
			"a cycle of several vertices",
			"a self loop",
			"an edge into a component already closed",
			"a root already entered",
			"a vertex no root reaches"
		] satisfies ReadonlyArray<Reached<GraphFeature>>,
		check: (_, c: Case<GraphFeature>) => (graph) =>
			Effect.sync(() => {
				const w = walked(graph)
				for (const feature of graphFeatures(graph, w)) {
					c.note(feature)
				}
				assert.deepEqual(
					stronglyConnected(graph.roots, successorsOf(graph)),
					expectedComponents(w),
					"the components, in the order the walk closes them, each last entered first"
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "a recursive depth-first walk numbering entries and finishes, and each vertex's reach searched apart"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/core/graph.ts",
				original: "\t\t\t\t\tframe.low = Math.min(frame.low, index)",
				replacement: "\t\t\t\t\tframe.low = Math.min(frame.low, frame.index)",
				why: "An edge back to an open vertex lowers nothing, so a cycle of several vertices is split into one component a vertex; the components differ."
			},
			{
				file: "packages/engine/src/core/graph.ts",
				original: "\t\t\t\tparent.low = Math.min(parent.low, frame.low)",
				replacement: "\t\t\t\tparent.low = Math.min(parent.low, parent.index)",
				why: "A vertex's low link never reaches its parent, so a cycle longer than one edge back is split; the components differ."
			},
			{
				file: "packages/engine/src/core/graph.ts",
				original: "components.push(appendNonEmpty(above.toReversed(), frame.vertex))",
				replacement: "components.push(appendNonEmpty(above, frame.vertex))",
				why: "A component of three vertices or more lists those above its root first entered first; the order within it differs."
			}
		]
	})

/**
 * A chain of any depth, past what a small stack's recursion holds, walks: open, it is one component per vertex, its
 * last first; closed from its last vertex back to its first, it is one component, its vertices last entered first.
 *
 * Budget: 6 runs and 12 steered cases, as the relational DAG's deep chain states.
 */
export const aChainOfAnyDepthPastWhatASmallStacksRecursionHoldsWalksOpenOrClosedIntoOneComponent =
	property.explore(
		(source): Chain => ({ depth: 1 + source.draw(chainDepth), closed: source.draw(boolean) }),
		{
			needs: {},
			budget: { runs: 6, steered: 12 },
			situations: [
				"a chain of one component per vertex",
				"a chain closed into one component",
				"a chain past a small stack's recursion"
			] satisfies ReadonlyArray<Reached<ChainWalkFeature>>,
			check: (_, c: Case<ChainWalkFeature>) => (chain) =>
				Effect.sync(() => {
					c.note(
						chain.closed
							? "a chain closed into one component"
							: "a chain of one component per vertex"
					)
					if (chain.depth > smallStackRecursion) {
						c.note("a chain past a small stack's recursion")
					}
					const last = chain.depth - 1
					const next = (v: number): ReadonlyArray<number> =>
						v < last ? [v + 1] : chain.closed ? [0] : []
					assert.deepEqual(
						stronglyConnected([0], next),
						chainComponents(chain),
						chain.closed
							? "one component, its vertices last entered first"
							: "one component a vertex, the chain's last closed first"
					)
				}),
			oracle: {
				kind: "specification",
				name: "the chain's own construction: its depth and whether its last vertex leads back to its first"
			},
			kept: [],
			kills: [
				{
					file: "packages/engine/src/core/graph.ts",
					original:
						"\tfor (const root of roots) {\n\t\tif (entered.has(root)) {\n\t\t\tcontinue\n\t\t}\n\t\tconst walk: Array<Frame<V>> = [enter(root)]\n\t\tfor (let frame = walk.at(-1); frame !== undefined; frame = walk.at(-1)) {\n\t\t\tconst successor = frame.successors[frame.next]\n\t\t\tif (successor !== undefined) {\n\t\t\t\tframe.next++\n\t\t\t\tconst index = open.get(successor)\n\t\t\t\tif (!entered.has(successor)) {\n\t\t\t\t\twalk.push(enter(successor))\n\t\t\t\t} else if (index !== undefined) {\n\t\t\t\t\tframe.low = Math.min(frame.low, index)\n\t\t\t\t}\n\t\t\t\tcontinue\n\t\t\t}\n\t\t\twalk.pop()\n\t\t\tconst parent = walk.at(-1)\n\t\t\tif (parent !== undefined) {\n\t\t\t\tparent.low = Math.min(parent.low, frame.low)\n\t\t\t}\n\t\t\tif (frame.low === frame.index) {\n\t\t\t\tconst above = stack.splice(frame.depth).slice(1)\n\t\t\t\tfor (const vertex of above) {\n\t\t\t\t\topen.delete(vertex)\n\t\t\t\t}\n\t\t\t\topen.delete(frame.vertex)\n\t\t\t\tcomponents.push(appendNonEmpty(above.toReversed(), frame.vertex))\n\t\t\t}\n\t\t}\n\t}\n",
					replacement:
						"\tconst strong = (vertex: V): number => {\n\t\tconst frame = enter(vertex)\n\t\tfor (const successor of frame.successors) {\n\t\t\tconst index = open.get(successor)\n\t\t\tif (!entered.has(successor)) {\n\t\t\t\tframe.low = Math.min(frame.low, strong(successor))\n\t\t\t} else if (index !== undefined) {\n\t\t\t\tframe.low = Math.min(frame.low, index)\n\t\t\t}\n\t\t}\n\t\tif (frame.low === frame.index) {\n\t\t\tconst above = stack.splice(frame.depth).slice(1)\n\t\t\tfor (const vertex of above) {\n\t\t\t\topen.delete(vertex)\n\t\t\t}\n\t\t\topen.delete(frame.vertex)\n\t\t\tcomponents.push(appendNonEmpty(above.toReversed(), frame.vertex))\n\t\t}\n\t\treturn frame.low\n\t}\n\tfor (const root of roots) {\n\t\tif (!entered.has(root)) {\n\t\t\tstrong(root)\n\t\t}\n\t}\n",
					why: "stronglyConnected recurses, so a chain past a small stack's recursion overflows it; the deep chain's property fails."
				}
			]
		}
	)
