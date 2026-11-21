/**
 * The RelNode family's structural readers (ir/rel.ts), over the every-kind fixture and generated DAGs.
 *
 * - Structural map: a node's edges and expressions are listed exactly as its structural map meets them, in its order,
 *   and the map restates the node unchanged. Oracle: the structural map, driven, against edgesOf and exprsOf.
 * - Kept rows: a node keeps rows only of a data input whose heading is its own, and delivers that input exactly when it
 *   keeps every row. Oracle: the kept-rows rule as a checker.
 *
 * - Rebuild: a node read with its edges replaced by their values (ir/dag.ts edgeValues, rel.ts replacedEdges) is the
 *   node, its edges yielded in structural order, and every part of it that holds no edge is the node's own part, shared:
 *   a rebuild allocates only the containers its edges stand in, where restating every reference as itself (mapNode over
 *   keptRefs) copied every container and record of the node, which the one constructor then froze again (relNode).
 *   Oracle: the node itself, and an audit of every part of the rebuild (rel.fixtures.ts copiedApart).
 *
 * Features: every node kind; each kind that keeps rows, and one keeping every row.
 */

import { assert, contains } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { edgeValues, topoOrder } from "#compiler/ir/dag.ts"
import type { ScalarExpr } from "#compiler/ir/expr.ts"
import { drive } from "#compiler/ir/fold.ts"
import {
	deliveredInput,
	edgesOf,
	exprsOf,
	inputsOf,
	keptRefs,
	keptRowsOf,
	type LiveRefs,
	mapNode,
	type RelKind,
	relKinds,
	type RelNode
} from "#compiler/ir/rel.ts"
import { copiedApart, dags, type Keeping } from "#test/unit/ir/rel.fixtures.ts"

/**
 * The RelNode family lists a node's edges and expressions exactly as its structural map meets them, and restates it
 * unchanged.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/rel.test.ts:47 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRelNodeFamilyListsANodesEdgesAndExpressionsExactlyAsItsStructuralMapMeetsThemAndRestatesItUnchanged =
	property.explore(dags, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: Arr.map(relKinds, (kind): `a ${RelKind}` => `a ${kind}`) satisfies ReadonlyArray<
			Reached<`a ${RelKind}`>
		>,
		check: (_, c: Case<`a ${RelKind}`>) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					c.note(`a ${node.kind}`)
					const yielded: Array<RelNode> = []
					const restated: Array<ScalarExpr> = []
					const same = drive(
						mapNode<LiveRefs, LiveRefs>(node, {
							...keptRefs,
							expr: (e) => {
								restated.push(e)
								return e
							}
						}),
						(edge) => {
							yielded.push(edge)
							return edge
						}
					)
					assert.deepEqual(same, node)
					assert.deepEqual<ReadonlyArray<RelNode>>(
						yielded,
						edgesOf(node),
						`${node.kind} ${node.id} edges`
					)
					assert.deepEqual<ReadonlyArray<ScalarExpr>>(
						restated,
						exprsOf(node),
						`${node.kind} ${node.id} expressions`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the structural map (mapNode, driven) as the edge and expression listings' reference"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\treturn [n.parent, n.child]",
				replacement: "\t\t\treturn [n.parent]",
				why: "An attachment's child is missing from its edges; the structural map property fails."
			}
		]
	})

/**
 * The RelNode family keeps rows only of a data input whose heading is its own, for every kind.
 *
 * Budget: 100 runs and 100 steered cases, what its suite stated before it became a property
 * (test/unit/ir/rel.test.ts:107 at 8cad5bce, its runs and its coverage's cases).
 */
export const theRelNodeFamilyKeepsRowsOnlyOfADataInputWhoseHeadingIsItsOwnForEveryKind =
	property.explore(dags, {
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: [
			"keeps every row",
			...Arr.map(
				["Filter", "Take", "OrderedResult", "Attach", "Forbid"] satisfies ReadonlyArray<Keeping>,
				(kind): `keeps rows of a ${RelKind}` => `keeps rows of a ${kind}`
			)
		] satisfies ReadonlyArray<Reached<`keeps rows of a ${RelKind}` | "keeps every row">>,
		check: (_, c: Case<`keeps rows of a ${RelKind}` | "keeps every row">) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					const kept = keptRowsOf(node)
					if (kept === undefined) {
						continue
					}
					c.note(`keeps rows of a ${node.kind}`)
					if (kept.keeps === "every") {
						c.note("keeps every row")
					}
					contains(inputsOf(node), kept.input)
					assert.deepEqual(kept.input.heading, node.heading, `${node.kind} ${node.id}`)
					assert.equal(deliveredInput(node), kept.keeps === "every" ? kept.input : undefined)
				}
			}),
		oracle: {
			kind: "specification",
			name: "a node keeps rows only of a data input of its own heading, and delivers it exactly when it keeps every row"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: '\t\t\treturn { input: n.parent, keeps: "every" }',
				replacement: '\t\t\treturn { input: n.child, keeps: "every" }',
				why: "An attachment keeps its child's rows, not its parent's; the kept-rows property fails, and so does the structural map's, whose DAG the delivery rule then refuses."
			}
		]
	})

/** A node read with its edges replaced is the node, sharing every part of it that holds no edge. */
export const aNodeReadWithItsEdgesReplacedIsTheNodeSharingEveryPartOfItThatHoldsNoEdge =
	property.explore(dags, {
		needs: {},
		situations: Arr.map(relKinds, (kind): `a ${RelKind}` => `a ${kind}`) satisfies ReadonlyArray<
			Reached<`a ${RelKind}`>
		>,
		check: (_, c: Case<`a ${RelKind}`>) => (dag) =>
			Effect.sync(() => {
				for (const node of topoOrder(dag)) {
					c.note(`a ${node.kind}`)
					const yielded: Array<RelNode> = []
					const rebuilt = drive(edgeValues<RelNode>(node), (edge) => {
						yielded.push(edge)
						return edge
					})
					assert.deepEqual(rebuilt, node, `${node.kind} ${node.id} read back`)
					assert.deepEqual<ReadonlyArray<RelNode>>(
						yielded,
						edgesOf(node),
						`${node.kind} ${node.id} edges`
					)
					assert.deepEqual(
						copiedApart(node, rebuilt, new Set(edgesOf(node)), "node"),
						[],
						`${node.kind} ${node.id}: no part that holds no edge is copied`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "the node itself, every part of it that holds no edge shared (rel.fixtures.ts copiedApart)"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\t\toccurrences.push({ ...o, source })\n",
				replacement: "\t\t\t\toccurrences.push({ ...o, source, bindings: [...o.bindings] })\n",
				why: "A region's rebuild copies each occurrence's bindings, which hold no edge, as restating every reference copied them: the copied bindings are a part the audit finds built anew, and the search fails."
			},
			{
				file: "packages/engine/src/ir/rel.ts",
				original: "\t\t\treturn { ...n, input }\n",
				replacement: "\t\t\treturn { ...n, input, meta: { ...n.meta } }\n",
				why: "A one-input node's rebuild copies its metadata, which holds no edge: the audit finds it built anew, and the search fails."
			}
		]
	})
