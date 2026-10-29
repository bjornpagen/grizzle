import { nominal } from "#compiler/core/brand.ts"
import type { IdSupply, NodeId } from "#compiler/core/ids.ts"
import { assembledDag, relNode } from "#compiler/ir/dag.ts"
import { builtExpr, type ExprSpec, type ScalarExpr } from "#compiler/ir/expr.ts"
import type { NodeSpec, RelNode, Roots, ValidDag } from "#compiler/ir/rel.ts"

/**
 * A node label reserved to define later (DagBuilder.reserve), for a node that nodes built before it name: the
 * Recursive its SelfRef names, the region its lateral sources' and its own constants' column references name. Only a
 * reservation is defined, so no node a builder built is defined over.
 */
export type ReservedNode = NodeId & { readonly [reservedNodeBrand]: true }
declare const reservedNodeBrand: unique symbol
const ReservedNode = nominal<NodeId, ReservedNode>()

/**
 * DagBuilder mints labels from one IdSupply per construction and builds nodes and expressions over the nodes and
 * expressions it built before: each expression built over its arguments with its dependencies and effects (expr.ts
 * builtExpr), each node by the one constructor (dag.ts relNode), which computes its structural fields. A node holds its
 * inputs and expressions themselves, so a built DAG is its roots: every label one this builder minted once, every edge
 * a node built before its reader. No builder states a structural field or an effect an expression's kind and arguments
 * decide: every one is derived from the node and its inputs, at its construction.
 */
export class DagBuilder {
	readonly ids: IdSupply

	constructor(ids: IdSupply) {
		this.ids = ids
	}

	/** The node of `spec`, with the metadata it claims (conservativeMeta claims nothing), under a fresh label. */
	node(spec: NodeSpec): RelNode {
		return relNode(this.ids.node(), spec)
	}

	/**
	 * A fresh label to define later, for a node that nodes built before it name: a Recursive its SelfRef names, a
	 * region its constants and lateral sources read.
	 */
	reserve(): ReservedNode {
		return ReservedNode(this.ids.node())
	}

	/** The node of `spec` under a reserved label, once: each reservation is its one node's. */
	define(id: ReservedNode, spec: NodeSpec): RelNode {
		return relNode(id, spec)
	}

	/** The expression of `spec` under a fresh label, built over its arguments (expr.ts builtExpr). */
	expr(spec: ExprSpec): ScalarExpr {
		return builtExpr(spec, this.ids.expr())
	}

	/** The DAG rooted at `roots`, frozen: every node it holds is final when it is built. */
	build<R extends Roots>(roots: R): ValidDag<R> {
		return assembledDag(roots)
	}
}
