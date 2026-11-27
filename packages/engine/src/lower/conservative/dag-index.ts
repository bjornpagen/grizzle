import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { exprClosure, type ScalarExpr } from "#compiler/ir/expr.ts"
import { exprsOf, inputsOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"

/**
 * What a lowering asks of one DAG about a node beside the node itself: the nodes that take it as an input, the column
 * references that read its heading by its label, and whether it is a root. A lowering asks it of the nodes it lowers
 * alone: a region whose only reader may be a filter (region/index.ts readerComparisons), and a union a take alone reads
 * (take/index.ts armBoundable). Each question is answered from the index, where each walked the whole DAG, the closure
 * of all its expressions or both again: work linear in the DAG for every node asked, quadratic over a DAG of many
 * regions and takes.
 *
 * Built by one walk of the DAG's nodes in topological order (ir/dag.ts topoOrder), each node's distinct inputs given it
 * as a reader in that order, and one closure of every node's expressions (ir/expr.ts exprClosure), each column
 * reference filed under the label it reads: the reversed adjacency lists of the DAG, the textbook inversion of a
 * graph's edges, in time linear in its nodes, edges and expressions.
 */
export class DagIndex {
	readonly #readers = new Map<RelNode, Array<RelNode>>()
	readonly #columnReads = new Map<NodeId, Array<ScalarExpr>>()
	readonly #roots: ReadonlySet<RelNode>
	/** How many nodes the build visited: each node of the DAG once, the index's whole work. */
	readonly visited: number

	constructor(dag: RelDag) {
		const nodes = topoOrder(dag)
		for (const node of nodes) {
			for (const input of inputsOf(node)) {
				const readers = this.#readers.get(input)
				if (readers === undefined) {
					this.#readers.set(input, [node])
				} else {
					readers.push(node)
				}
			}
		}
		for (const e of exprClosure(nodes.flatMap((n) => exprsOf(n)))) {
			if (e.kind !== "column") {
				continue
			}
			const reads = this.#columnReads.get(e.column.node)
			if (reads === undefined) {
				this.#columnReads.set(e.column.node, [e])
			} else {
				reads.push(e)
			}
		}
		this.#roots = new Set(dag.roots)
		this.visited = nodes.length
	}

	/** The nodes that take `node` as an input, each once, in topological order. */
	readersOf(node: RelNode): ReadonlyArray<RelNode> {
		return this.#readers.get(node) ?? []
	}

	/** The column references among the DAG's expressions that read the heading labeled `label`, each once. */
	columnReadsOf(label: NodeId): ReadonlyArray<ScalarExpr> {
		return this.#columnReads.get(label) ?? []
	}

	/** Whether `node` is a root of the DAG: a statement delivers its rows. */
	isRoot(node: RelNode): boolean {
		return this.#roots.has(node)
	}
}
