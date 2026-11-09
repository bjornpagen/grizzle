import { Array as Arr } from "effect"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import type { ExprId, NodeId } from "#compiler/core/ids.ts"
import type * as Result from "#compiler/core/result.ts"
import { assembledDag, edgeValues, normalizeWithin, topoOrder } from "#compiler/ir/dag.ts"
import {
	exprClosure,
	type LiveArgs,
	outsideSpec,
	type ScalarExpr,
	type TableArgs,
	type TableExpr,
	withArgs
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import {
	type DagTable,
	exprsOf,
	keptRefs,
	type LiveRefs,
	mapNode,
	mapRoots,
	type NodeOver,
	type RelDag,
	type RelNode,
	type Roots,
	type TableNode,
	type TableRefs,
	type ValidDag,
	type ValueRefs
} from "#compiler/ir/rel.ts"
import * as S from "#compiler/ir/shape.ts"

/**
 * The DAG with every node rebuilt by `step`, inputs first: `step` reads the node and its reading with each input
 * replaced by that input's rebuilt node (ir/dag.ts edgeValues), and returns the node standing in its place, under its
 * label (a re-annotation of its logical metadata, a completion of its orders, through relNode). A step that changes
 * nothing returns the node itself, so an unchanged part of the DAG stays the same objects.
 */
export const rebuildDag = <R extends Roots>(
	dag: ValidDag<R>,
	step: (node: RelNode, inputs: NodeOver<ValueRefs<RelNode>>) => RelNode
): ValidDag<R> => {
	const rebuilt = new Fold<RelNode, RelNode>(function* (node) {
		const inputs = yield* edgeValues<RelNode>(node)
		return step(node, inputs)
	})
	return assembledDag(mapRoots(dag.roots, (root) => rebuilt.of(root)))
}

/** An expression's outside form: its arguments by label. */
const tableExprOf = (e: ScalarExpr): TableExpr => {
	const spec = withArgs<LiveArgs, TableArgs>(outsideSpec(e), (a) => a.id)
	return Object.freeze({
		...spec,
		volatility: e.volatility,
		id: e.id,
		deps: e.deps
	})
}

const malformed = (path: S.Path, capability: string): CompileError =>
	S.malformedAt("relational DAG", path, capability)

/**
 * The outside form of a DAG: every node its roots reach and every expression those nodes hold, keyed by label, each
 * reference a label, in topological order (ir/dag.ts topoOrder) and then first-visit order of the expressions, which
 * the strict re-reader and the dumps read. Labels are unique by construction (one construction mints each once, a
 * merge renames); two distinct nodes or expressions under one label, which no construction makes, are
 * MalformedDescription.
 */
export const toTable = (dag: RelDag): Result.Result<DagTable, CompileError> =>
	catchRefusal(() => {
		const nodes: Record<NodeId, TableNode> = {}
		const exprs: Record<ExprId, TableExpr> = {}
		const claimedNodes = new Map<NodeId, RelNode>()
		const claimedExprs = new Map<ExprId, ScalarExpr>()
		const order = topoOrder(dag)
		for (const node of order) {
			const prior = claimedNodes.get(node.id)
			if (prior !== undefined) {
				throw new Refusal(
					malformed(["nodes", node.id], `one node per label; two nodes are labelled ${node.id}`)
				)
			}
			claimedNodes.set(node.id, node)
			const entry = drive(
				mapNode<LiveRefs, TableRefs>(node, { ...keptRefs, expr: (e) => e.id, var: (v) => v.id }),
				(input) => input.id
			)
			nodes[node.id] = Object.freeze({ ...entry, id: node.id })
		}
		for (const e of exprClosure(Arr.flatMap(order, (node) => exprsOf(node)))) {
			const prior = claimedExprs.get(e.id)
			if (prior !== undefined) {
				throw new Refusal(
					malformed(["exprs", e.id], `one expression per label; two are labelled ${e.id}`)
				)
			}
			claimedExprs.set(e.id, e)
			exprs[e.id] = tableExprOf(e)
		}
		return { roots: Arr.map(dag.roots, (root) => root.id), nodes, exprs }
	})

/** The normal form of a whole DAG (ir/dag.ts normalizeWithin from its own roots). */
export const normalizeDag = (dag: RelDag): Result.Result<DagTable, CompileError> =>
	normalizeWithin(dag, dag.roots)
