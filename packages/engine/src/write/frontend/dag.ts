import { compareText } from "#compiler/core/canonical.ts"
import { allocatedKinds, ExprId, NodeId, type ParamId } from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { assembledDag, emptyDag, mergeDags, relNode, topoOrder } from "#compiler/ir/dag.ts"
import {
	builtExpr,
	type ExprSpec,
	exprClosure,
	type LiveArgs,
	mapArgs,
	type ScalarExpr,
	sameArgs
} from "#compiler/ir/expr.ts"
import { Fold } from "#compiler/ir/fold.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import {
	conservativeMeta,
	edgesOf,
	exprsOf,
	type Heading,
	keptRefs,
	type LiveRefs,
	mapNode,
	metaSpecOf,
	type NodeOf,
	type NodeSpec,
	type RelDag,
	type RelNode,
	type Roots,
	type SpecRefs,
	type ValidDag
} from "#compiler/ir/rel.ts"
import { isRefined, sameScalarType } from "#compiler/ir/scalar.ts"
import { columnType } from "#compiler/lower/conservative/context.ts"

/** Queries' DAGs merged into one, each added in turn.
 *
 * The write DAG: every described member's and read-back's query in one RelDag (`WriteIR.dag`), plus the
 * glue nodes the frontend adds itself, and each writable entry's fill with its relation parameter substituted by the
 * source that fills it (substitute).
 *
 * Each member and read-back is checked on its own, so each LogicalQuery has its own label space. They are merged
 * one after another (`mergeDags`), which renames every allocated label past the DAG so far;
 * parameter identifiers are declared names and are shared, which is what makes a ChangeSet's parameters one
 * namespace. The glue is what a put needs when several sources of one relation meet in one stratum: one
 * put action reads their union, so the InputSet of the enumerated facts and the described members' roots
 * become arms of one Union. Every arm must deliver the group heading exactly, so an arm whose head is
 * typed only compatibly with the relation, such as a text column with another refinement, is wrapped in a ProjectSet
 * that casts each such column into the relation's type, the cast the write into the column performs anyway.
 * Every glue node is built by the one constructor (ir/dag.ts relNode) and every glue expression by builtExpr, so their
 * structural fields, dependencies and effects are computed as a builder's are. */
export class QueryMerger {
	#dag: ValidDag = emptyDag

	/** Merges `query` past the queries added before it, answering its root in the merged DAG. */
	add(query: LogicalQuery): RelNode {
		const merged = mergeDags(this.#dag, query.dag)
		this.#dag = merged.dag
		return merged.node(query.dag.roots[0])
	}

	get dag(): ValidDag {
		return this.#dag
	}
}

const suffixOf = (prefix: string, id: string): number => {
	if (!id.startsWith(prefix)) {
		return 0
	}
	const n = Number(id.slice(prefix.length))
	return Number.isSafeInteger(n) ? n : 0
}

/** The glue the frontend builds over the merged queries, under fresh labels past every label they hold. */
export class GlueBuilder {
	#node: number
	#expr: number

	constructor(dag: RelDag) {
		const nodes = topoOrder(dag)
		this.#node = Math.max(0, ...nodes.map((n) => suffixOf(allocatedKinds.node, n.id)))
		this.#expr = Math.max(
			0,
			...exprClosure(nodes.flatMap((n) => exprsOf(n))).map((e) =>
				suffixOf(allocatedKinds.expr, e.id)
			)
		)
	}

	#add(spec: NodeSpec): RelNode {
		this.#node += 1
		return relNode(NodeId(`${allocatedKinds.node}${this.#node}`), spec)
	}

	/** An expression of `spec`, its dependencies and effects derived from its arguments' (`builtExpr`). */
	#expression(spec: ExprSpec): ScalarExpr {
		this.#expr += 1
		return builtExpr(spec, ExprId(`${allocatedKinds.expr}${this.#expr}`))
	}

	/** A write's enumerated member slot of `relation` as a source of `heading`. */
	inputSet(slot: ParamId, relation: string, heading: Heading): RelNode {
		return this.#add({
			kind: "InputSet",
			input: { kind: "member", slot, relation },
			heading,
			meta: conservativeMeta,
			loc: undefined
		})
	}

	/** `arm` delivering exactly `heading`: the arm itself when it already does, otherwise a ProjectSet that casts each
	 * column whose type differs into the heading's type. */
	conform(arm: RelNode, heading: Heading): RelNode {
		const delivered = arm.heading
		const differs = heading.some((c) => {
			const d = delivered.find((x) => x.name === c.name)
			return d === undefined || !sameScalarType(d.type, c.type)
		})
		if (!differs && delivered.length === heading.length) {
			return arm
		}
		const out = heading.map((c) => {
			const type = columnType(delivered, c.name)
			const column = this.#expression({
				kind: "column",
				column: { node: arm.id, name: c.name },
				args: [],
				type,
				nonNull: "storage"
			})
			if (sameScalarType(type, c.type)) {
				return { name: c.name, expr: column }
			}
			const cast = this.#expression(
				isRefined(c.type)
					? { kind: "domainCast", args: [column], type: c.type, nonNull: "strict" }
					: {
							kind: "cast",
							checked: true,
							args: [column],
							type: c.type,
							nonNull: "strict",
							volatility: "immutable"
						}
			)
			return { name: c.name, expr: cast }
		})
		return this.#add({
			kind: "ProjectSet",
			input: arm,
			out,
			heading: heading.map((c) => ({ name: c.name, type: c.type })),
			meta: conservativeMeta,
			loc: undefined
		})
	}

	union(arms: NonEmptyReadonlyArray<RelNode>, heading: Heading): RelNode {
		const conformed = mapNonEmpty(arms, (a) => this.conform(a, heading))
		const h = heading.map((c) => ({ name: c.name, type: c.type }))
		return this.#add({
			kind: "Union",
			groups: [{ heading: h, arms: conformed }],
			discriminant: [],
			heading: h,
			meta: conservativeMeta,
			loc: undefined
		})
	}

	/** The DAG rooted at `roots`, every node of which the one constructor built (ir/dag.ts assembledDag). */
	build<R extends Roots>(roots: R): ValidDag<R> {
		return assembledDag(roots)
	}
}

/** Whether two lists hold the same items, position by position. */
const sameItems = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean =>
	a.length === b.length && a.every((x, i) => b[i] === x)

/**
 * `root` applied to a source: every InputSet that reads the relation parameter `param` read as the source `source`
 * builds for that InputSet's heading instead, as a writable entry's fill is applied to the sources that fill it. The
 * source delivers the parameter's heading, so every column a reader binds or names keeps its name; a column reference
 * to a replaced InputSet names its source. Each node and expression on a path to a replaced InputSet is rebuilt under
 * its own label (the one constructor recomputes what it derives), and every other one is kept as it is, so the result
 * shares everything the substitution leaves alone; a root that reads no such InputSet is itself.
 */
export const substitute = (
	root: RelNode,
	param: ParamId,
	source: (heading: Heading) => RelNode
): RelNode => {
	const replaced = new Map(
		topoOrder({ roots: [root] }).flatMap((node) =>
			node.kind === "InputSet" && node.input.kind === "declared" && node.input.param === param
				? [[node.id, source(node.heading)] as const]
				: []
		)
	)
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		if (spec.kind === "column") {
			const to = replaced.get(spec.column.node)
			if (to !== undefined) {
				return builtExpr({ ...spec, column: { node: to.id, name: spec.column.name } }, e.id)
			}
		}
		return sameArgs(e, spec) ? e : builtExpr(spec, e.id)
	})
	const nodes = new Fold<RelNode, RelNode>(function* (node) {
		const to = replaced.get(node.id)
		if (to !== undefined) {
			return to
		}
		const spec: NodeSpec = yield* mapNode<LiveRefs, SpecRefs>(node, {
			...keptRefs,
			expr: (e) => exprs.of(e),
			name: (id) => replaced.get(id)?.id ?? id,
			meta: metaSpecOf
		})
		/** A label the node holds, a certificate premise's node, names a replaced InputSet. */
		const names =
			node.kind === "Recursive" &&
			node.termination.premises.some((p) => p.kind === "node" && replaced.has(p.node))
		return !names &&
			sameItems(edgesOf(node), edgesOf(spec)) &&
			sameItems(exprsOf(node), exprsOf(spec))
			? node
			: relNode(node.id, spec)
	})
	return nodes.of(root)
}

/**
 * The delta sources reachable from `start` through data inputs: each Delta node it reaches, one per relation and side,
 * in code point order of relation and side.
 */
export const deltaSources = (start: RelNode): ReadonlyArray<NodeOf<"Delta">> => {
	const out = new Map<string, NodeOf<"Delta">>()
	for (const node of topoOrder({ roots: [start] })) {
		if (node.kind === "Delta") {
			out.set(`${node.relation}\u0000${node.side}`, node)
		}
	}
	return [...out.entries()].toSorted(([a], [b]) => compareText(a, b)).map(([, d]) => d)
}
