/**
 * What a node's subtree reads and costs, worked out once a node (lower/optimize/cte-policy/index.ts costClass,
 * analysis/physical/rules.ts outerOf): the share planning's eligibility (lower/shapes/share/statements.ts ShareIndex)
 * and the CTE policy read whether a node's subtree reads a node outside it and the subtree's cost class, which each
 * worked out by walking the node's whole subtree, for every node it asked of: O(nodes) a node. Each is now its own
 * stage's and its inputs', each input's worked out once and kept for as long as the immutable node lives.
 *
 * Oracle: the walks they replace (a second implementation: the old algorithm), the subtree walked whole for each node:
 * readsOutside over subtreeOf, and the dearest stage met on it.
 *
 * Features: a node over a shared input, a node reading outside its subtree, an expensive subtree, a join.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { outerOf } from "#compiler/analysis/physical/rules.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { inputsOf, type RelNode } from "#compiler/ir/rel.ts"
import { costClass } from "#compiler/lower/optimize/cte-policy/index.ts"
import { nodeGraph, readsOutside, subtreeOf } from "#compiler/lower/optimize/demand/editor.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { generatedDags } from "#test/support/unit/ir/population.ts"

type SubtreeFeature =
	| "a node over a shared input"
	| "a node reading outside its subtree"
	| "an expensive subtree"
	| "a join"

/** What the property counts: each node's own stage's cost read (cte-policy ownCost), once a node. */
const costSites = {
	ownCost: { file: "packages/engine/src/lower/optimize/cte-policy/index.ts", name: "ownCost" }
} as const

const expensive: ReadonlySet<RelNode["kind"]> = new Set([
	"Group",
	"Window",
	"OrderedSetAggregate",
	"Recursive",
	"Intersect",
	"Difference",
	"Union",
	"Take",
	"Produce",
	"ApproximateNearest",
	"Call"
])

/** The oracle's cost class: the subtree walked whole, its dearest stage. */
const walkedCost = (node: RelNode): ReturnType<typeof costClass> => {
	let join = false
	for (const at of subtreeOf(nodeGraph, node)) {
		if (expensive.has(at.kind)) {
			return "expensive"
		}
		if (
			(at.kind === "MatchRegion" && at.occurrences.length > 1) ||
			at.kind === "SemiJoin" ||
			at.kind === "AntiJoin"
		) {
			join = true
		}
	}
	return join ? "join" : "scan"
}

/**
 * Every node of a generated DAG reads a node outside its subtree exactly where a walk of its whole subtree finds one,
 * and costs what the dearest stage of that walk costs; and each node's own stage is read once however many nodes over it
 * are asked.
 *
 * Budget: 300 runs and 300 steered cases, the DAG traversal property's, over its space.
 */
export const aNodesSubtreeReadsAndCostAreItsOwnAndItsInputsEachWorkedOutOnce = property.explore(
	generatedDags,
	{
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: [
			"a node over a shared input",
			"a node reading outside its subtree",
			"an expensive subtree",
			"a join"
		] satisfies ReadonlyArray<Reached<SubtreeFeature>>,
		check: (_, c: Case<SubtreeFeature>) => (dag) =>
			Effect.gen(function* () {
				const order = topoOrder(dag)
				const [classes, counts] = yield* callCounts(
					Effect.sync(() => Arr.map(order, (node) => costClass(node))),
					costSites
				)
				const readers = new Map<RelNode, number>()
				for (const [i, node] of order.entries()) {
					for (const input of inputsOf(node)) {
						readers.set(input, (readers.get(input) ?? 0) + 1)
					}
					const cost = walkedCost(node)
					assert.equal(classes[i], cost, `${node.id}'s cost class`)
					const outside = readsOutside(nodeGraph, subtreeOf(nodeGraph, node))
					assert.equal(
						outerOf(node).length > 0,
						outside,
						`whether ${node.id}'s subtree reads outside it`
					)
					if (outside) {
						c.note("a node reading outside its subtree")
					}
					if (cost === "expensive") {
						c.note("an expensive subtree")
					}
					if (cost === "join") {
						c.note("a join")
					}
				}
				if (Arr.some([...readers.values()], (n) => n > 1)) {
					c.note("a node over a shared input")
				}
				assert.equal(
					counts.ownCost,
					order.length,
					`${counts.ownCost} stages read for ${order.length} nodes`
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "each node's subtree walked whole: readsOutside over subtreeOf, and its dearest stage"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original:
					"\tfor (const node of postorder([root], (n) => inputsOf(n).filter((input) => !costs.has(input)))) {\n",
				replacement: "\tfor (const node of postorder([root], (n) => inputsOf(n))) {\n",
				why: "Each node's cost class walks its whole subtree again, as before inputs kept theirs: a node's stage is read once for every node over it asked, and the reads outnumber the nodes."
			}
		]
	}
)
