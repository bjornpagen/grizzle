/**
 * What a lowering asks of its DAG about a node beside the node itself, who reads it (lower/conservative/dag-index.ts
 * DagIndex), is answered from one index of the DAG built at the lowering's first question: the nodes that take a node
 * as an input, the column references that read a label's heading, and the roots. Each question walked the whole DAG
 * again before, a region's for its only reader (region/index.ts readerComparisons) and a take's for its union's
 * (take/index.ts armBoundable): work linear in the DAG for every node asked, quadratic over a DAG of many.
 *
 * The box, drawn: a union of two to six arms, each a region a filter bounds by a parameter, a region two arms read, a
 * region matching one source twice, or the first row of a union of two regions.
 *
 * Properties: every answer of the index is the walk's it replaced (a second implementation); and a lowering of the
 * whole program builds the index once, its build visiting each node of the DAG once, however many regions and takes it
 * asks about. Kills: a node's readers filed against topological order; and the index built again at each question, the
 * walk each question took before.
 *
 * Features: a node two read, a reader of one input at two edges, a bounded region, a take's union.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import { edgesOf, inputsOf } from "#compiler/ir/rel.ts"
import { DagIndex } from "#compiler/lower/conservative/dag-index.ts"
import { armsGen, lowered, programOf, walked } from "#test/unit/lower/shapes/dag-index.fixtures.ts"

type Situation = "a node two read" | "an input at two edges" | "a bounded region" | "a take's union"

/** Every answer of a DAG's index is the walk's it replaced. */
export const everyAnswerOfADagsIndexIsTheWalksItReplaced = property.explore(armsGen, {
	needs: {},
	situations: [
		"a node two read",
		"an input at two edges",
		"a bounded region",
		"a take's union"
	] satisfies ReadonlyArray<Reached<Situation>>,
	check: (_, c: Case<Situation>) => (drawn) =>
		Effect.sync(() => {
			const { dag } = programOf(drawn)
			const index = new DagIndex(dag)
			const walk = walked(dag)
			const nodes = topoOrder(dag)
			for (const node of nodes) {
				assert.deepEqual(index.readersOf(node), walk.readersOf(node), `the readers of ${node.id}`)
				assert.deepEqual(
					new Set(index.columnReadsOf(node.id)),
					new Set(walk.columnReadsOf(node.id)),
					`the column reads of ${node.id}`
				)
				assert.equal(index.columnReadsOf(node.id).length, walk.columnReadsOf(node.id).length)
				assert.equal(index.isRoot(node), walk.isRoot(node), `whether ${node.id} is a root`)
			}
			assert.equal(index.visited, nodes.length, "the build visits each node once")
			if (Arr.some(nodes, (n) => index.readersOf(n).length > 1)) {
				c.note("a node two read")
			}
			if (Arr.some(nodes, (n) => edgesOf(n).length > inputsOf(n).length)) {
				c.note("an input at two edges")
			}
			if (Arr.contains(drawn, "bounded")) {
				c.note("a bounded region")
			}
			if (Arr.contains(drawn, "first of a union")) {
				c.note("a take's union")
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "the walks of the whole DAG each question took (dag-index.fixtures.ts walked)"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/conservative/dag-index.ts",
			original: "\t\t\t\t\treaders.push(node)\n",
			replacement: "\t\t\t\t\treaders.unshift(node)\n",
			why: "A node's readers are filed latest first, against topological order: a region two arms read lists its readers in the reverse of the walk's order, and the search fails."
		}
	]
})

/** A lowering builds its DAG's index once, visiting each node once, however many nodes it asks about. */
export const aLoweringBuildsItsDagsIndexOnceVisitingEachNodeOnceHoweverManyNodesItAsksAbout =
	property.explore(armsGen, {
		needs: {},
		situations: [],
		check: () => (drawn) =>
			Effect.sync(() => {
				const query = programOf(drawn)
				const { visits, regions } = lowered(query)
				assert.ok(regions >= 2, "the lowering asks about two regions at least")
				assert.equal(
					visits,
					topoOrder(query.dag).length,
					`the index's builds visit the DAG's ${topoOrder(query.dag).length} nodes once over ${regions} regions`
				)
			}),
		oracle: {
			kind: "specification",
			name: "one build of the index for the whole lowering, linear in its DAG"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/conservative/context.ts",
				original: "\t\tconst made = this.#shared.index\n",
				replacement: "\t\tconst made: DagIndex | undefined = undefined\n",
				why: "Every question builds the index again, the walk of the whole DAG each region's and each take's question took before: the builds visit the DAG once per question, two regions at least, and the search fails."
			}
		]
	})
