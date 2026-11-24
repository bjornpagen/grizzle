import { appendAll, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import type { NodeId } from "#compiler/core/ids.ts"
import { assembledDag, LabelSupply, relNode } from "#compiler/ir/dag.ts"
import { builtExpr, type LiveArgs, mapArgs, type ScalarExpr, sameArgs } from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	edgesOf,
	exprsOf,
	keptRefs,
	type LiveRefs,
	mapNode,
	mapRoots,
	metaSpecOf,
	type NodeOf,
	type NodeSpec,
	type RelNode,
	type Roots,
	type SpecRefs,
	type ValidDag
} from "#compiler/ir/rel.ts"

/** A DAG whose derived relations read their rows where the lowering reads them, and the node standing there in the
 * place of each node of the DAG it was made from. */
export interface ServedDag<R extends Roots> {
	readonly dag: ValidDag<R>
	readonly of: (node: RelNode) => RelNode
}

/**
 * How the lowering reads a schema's derived relations: whether a relation's table serves the read (analysis/schema.ts
 * CheckedSchema serves), and each relation's definition as the schema checked it (CheckedSchema definition), read where
 * its table does not.
 */
export interface DerivedRows {
	readonly serves: (relation: string) => boolean
	readonly definition: (relation: string) => LogicalQuery
}

/**
 * `dag` as the lowering reads it: every Base over a derived relation whose table does not serve the read (`rows`
 * serves) read as its definition instead, the definition its schema checked (`rows` definition) spliced in under
 * labels past every label of the DAG (ir/dag.ts LabelSupply renamed), one copy of each relation's however many Bases
 * read it, whose own derived relations are read alike, to any depth; every other Base, a stored relation's whose table
 * serves the read among them, read as it is. The checker reads a derived relation as a relation, stored or live alike,
 * keyed by the keys its definition proves (analysis/derived/analyze.ts DerivedDefinition), so no verdict reads where its
 * rows live: the lowering alone decides it, here, before its first pass. A definition delivers the relation's heading,
 * so every column a reader binds or names keeps its name; a column reference to a replaced Base names its definition's
 * root. Each node and expression on a path to a replaced Base is rebuilt under its own label (the one constructor
 * recomputes what it derives), and every other one is kept as it is, so a DAG that reads no derived relation whose
 * table does not serve is itself.
 */
export const servedDag = <R extends Roots>(dag: ValidDag<R>, rows: DerivedRows): ServedDag<R> => {
	/** Whether the lowering reads `node`, a Base, as its definition. */
	const replacedBase = (node: RelNode): node is NodeOf<"Base"> =>
		node.kind === "Base" && node.relationKind === "derived" && !rows.serves(node.relation)
	const supply = new LabelSupply(dag)
	/** Each relation's definition spliced into the DAG's label space once, its root there. */
	const spliced = new Map<string, RelNode>()
	const definitionOf = (relation: string): RelNode => {
		const known = spliced.get(relation)
		if (known !== undefined) {
			return known
		}
		const definition = rows.definition(relation).dag
		const root = supply.renamed(definition)(definition.roots[0])
		spliced.set(relation, root)
		return root
	}
	/**
	 * The label of the definition's root standing in the place of each replaced Base, by the Base's, over every node the
	 * DAG reaches and every definition a replaced Base reads, to any depth: known before any node is rebuilt, so a column
	 * reference names the definition wherever the fold meets it. A rebuilt node keeps its label.
	 */
	const replaced = new Map<NodeId, NodeId>()
	const seen = new Set<RelNode>()
	const pending: Array<RelNode> = [...dag.roots]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (seen.has(node)) {
			continue
		}
		seen.add(node)
		if (replacedBase(node)) {
			const definition = definitionOf(node.relation)
			replaced.set(node.id, definition.id)
			pending.push(definition)
		} else {
			appendAll(pending, edgesOf(node))
		}
	}
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		if (spec.kind === "column") {
			const to = replaced.get(spec.column.node)
			if (to !== undefined) {
				return builtExpr({ ...spec, column: { node: to, name: spec.column.name } }, e.id)
			}
		}
		return sameArgs(e, spec) ? e : builtExpr(spec, e.id)
	})
	const nodes = new Fold<RelNode, RelNode>(function* (node) {
		if (replacedBase(node)) {
			return yield definitionOf(node.relation)
		}
		const spec: NodeSpec = yield* mapNode<LiveRefs, SpecRefs>(node, {
			...keptRefs,
			expr: (e) => exprs.of(e),
			name: (id) => replaced.get(id) ?? id,
			meta: metaSpecOf
		})
		return sameOrder(edgesOf(node), edgesOf(spec)) && sameOrder(exprsOf(node), exprsOf(spec))
			? node
			: relNode(node.id, spec)
	})
	return {
		dag: assembledDag(mapRoots(dag.roots, (root) => nodes.of(root))),
		of: (node) => nodes.of(node)
	}
}

/** `query` as the lowering reads it (`servedDag`): each derived relation whose table does not serve the read read as its
 * definition. */
export const servedQuery = <Q extends LogicalQuery>(query: Q, rows: DerivedRows): Q => ({
	...query,
	dag: servedDag(query.dag, rows).dag
})

/** The relations a read writes: none. A read, a judge and an upkeep read every stored table their COMMIT's upkeep made
 * current (analysis/schema.ts CheckedSchema serves). */
export const noneWritten: ReadonlySet<string> = new Set()
