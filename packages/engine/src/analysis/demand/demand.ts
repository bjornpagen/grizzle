import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import { type ColumnRef, columnReads, type ScalarExpr } from "#compiler/ir/expr.ts"
import {
	edgesOf,
	inputsOf,
	type NodeOf,
	type RelDag,
	type RelNode,
	scopeExprs,
	scopeLabels,
	type VarDecl
} from "#compiler/ir/rel.ts"

export interface DemandAnalysis {
	readonly dag: RelDag
	/** The reachable nodes, inputs first (ir/dag.ts topoOrder). */
	readonly order: ReadonlyArray<RelNode>
	/**
	 * The heading columns of a reachable node some consumer's result depends on, and of each node a reachable one reads
	 * laterally: none for a node nothing demands anything of.
	 */
	readonly demanded: (node: RelNode) => ReadonlySet<string>
	/** The variables of a reachable region that must stay bound; a node that is no region binds none. */
	readonly liveVars: (node: RelNode) => ReadonlySet<VarDecl>
	/**
	 * How many references a reachable node has: one per input position that names it (a semi-join reading it on both
	 * sides, or a region matching it twice, references it twice, as the lowering emits it twice), plus the roots naming
	 * it.
	 */
	readonly references: (node: RelNode) => number
	/**
	 * Whether a scope expression reads a column of the node: a rewrite that moved or replaced it would leave the
	 * reference naming nothing in scope.
	 */
	readonly lateral: (node: RelNode) => boolean
}

/**
 * Query demand analysis.
 *
 * "Parameter demands, field liveness, contribution identity, source sharing boundaries, multiplicity-sensitive
 * consumers." For every node the roots reach this module computes which of its heading columns some consumer's result
 * depends on, given what that consumer itself must deliver. The liveness is the exact reading of each node kind's
 * meaning, worked top-down from the roots in reverse topological order, one visit per node
 * (O(V + E)):
 *
 * - a root delivers its whole heading;
 * - a Filter needs what its readers need plus the columns of its predicate; a ProjectSet only the columns its
 *   demanded outputs read (a set's projection onto fewer columns depends on fewer input columns); a Step what its
 *   readers need of it, its rows its input's unchanged, so a column a navigation's step delivers is live only where a
 *   reader of the step reads it (a later step's outer value among them, read laterally), never by the step itself;
 * - a MatchRegion keeps a variable live when it is demanded, joins two bindings, is equated or correlated, or is read
 *   by an outer reference; each occurrence's source then needs the columns bound to live variables and the columns
 *   its constants fix. A column bound to a dead variable is an existential witness;
 * - a SemiJoin or AntiJoin needs its left side's demanded and correlated columns and only the correlated columns of
 *   its right side, whose witness payload is not a contribution;
 * - a single-heading Union needs from each arm what its readers need of the union, and its literal discriminant;
 * - a Group needs its complete bound tuple B whatever its readers need, because B is the contribution identity:
 *   a fold over fewer columns folds another set;
 * - every other kind needs its inputs' whole headings: Take, pages and ordered results (the first k of a projection are
 *   not the projection of the first k), Intersect and Difference (set comparison is over the whole heading),
 *   heterogeneous unions (each group's heading is its delivery shape), recursion (the state is the identity),
 *   attachments, producers, windows, ordered-set aggregates and approximate candidates.
 *
 * A column a scope expression reads (rel.ts scopeExprs: a region's constants and correlated variables, a take's
 * correlation) is read laterally, whichever node it names: the region itself, another occurrence's source of the same
 * region, or a node of an enclosing scope a correlated source names. It is demanded of that node whatever its readers
 * need.
 *
 * A caller that will leave some nodes exactly as they are (pruning keeps every root, and every node on or read by a
 * recursive step) names them as pinned: a pinned node demands its whole heading, and a pinned region keeps
 * every variable live, so what it needs of its inputs is what its unchanged body reads, never less.
 *
 * Contribution identity and consumer sensitivity are the physical analysis's: the complete bound tuple of every
 * fold with its narrowing proof, and whether each node's repeats reach a consumer that observes them. Sharing is the
 * number of references each node has, one per input position naming it: a node referenced twice, by two readers or
 * twice by one, is a sharing boundary the CTE policy decides about.
 */
/**
 * How the vertices a graph's roots reach are read, by the label of each: its references, one per input position that
 * names it plus each root naming it, and whether a scope expression (rel.ts scopeExprs) reads it laterally, naming it in
 * a column reference. A finished DAG's nodes and an editor's cells (lower/optimize/demand/editor.ts CellState) are both
 * read so, one node a cell, labelled alike.
 */
export interface Structure {
	readonly references: (id: NodeId) => number
	readonly lateral: (id: NodeId) => boolean
}

/**
 * The structure (Structure) of the graph whose reachable vertices are `order`, roots `roots`, each vertex's edges
 * `edges` (one per input position) and the labels its scope expressions name in a column reference `lateral` (each
 * expression's dependencies, ir/expr.ts deps.nodes), labelled by `label`: one visit of each vertex.
 */
export const structureOf = <V>(
	order: ReadonlyArray<V>,
	roots: ReadonlyArray<V>,
	edges: (vertex: V) => ReadonlyArray<V>,
	lateral: (vertex: V) => ReadonlyArray<NodeId>,
	label: (vertex: V) => NodeId
): Structure => {
	const references = new Map<NodeId, number>()
	const count = (id: NodeId): void => {
		references.set(id, (references.get(id) ?? 0) + 1)
	}
	for (const r of roots) {
		count(label(r))
	}
	const read = new Set<NodeId>()
	for (const vertex of order) {
		for (const input of edges(vertex)) {
			count(label(input))
		}
		for (const node of lateral(vertex)) {
			read.add(node)
		}
	}
	return {
		references: (id) => references.get(id) ?? 0,
		lateral: (id) => read.has(id)
	}
}

/**
 * The columns the scope expressions (rel.ts scopeExprs) of the vertices `order` read, vertex by vertex in that order,
 * each vertex's in columnReads's order: each names the vertex it reads laterally, which demands the column whatever its
 * readers need.
 */
const lateralReadsOf = <V>(
	order: ReadonlyArray<V>,
	scope: (vertex: V) => ReadonlyArray<ScalarExpr>
): ReadonlyArray<ColumnRef> => order.flatMap((vertex) => columnReads(scope(vertex)))

/** The columns of `input` the expression trees `roots` read (ir/expr.ts columnReads). */
const exprColumns = (roots: ReadonlyArray<ScalarExpr>, input: NodeId): ReadonlyArray<string> =>
	columnReads(roots).flatMap((c) => (c.node === input ? [c.name] : []))

const all = (node: RelNode): ReadonlySet<string> => new Set(node.heading.map((c) => c.name))

/** The variables of a region that must stay bound, given the columns its readers demand. */
const liveVariables = (
	region: NodeOf<"MatchRegion">,
	demanded: ReadonlySet<string>
): ReadonlySet<VarDecl> => {
	const bindings = new Map<VarDecl, number>()
	for (const o of region.occurrences) {
		for (const b of o.bindings) {
			bindings.set(b.var, (bindings.get(b.var) ?? 0) + 1)
		}
	}
	const live = new Set<VarDecl>()
	for (const v of region.vars) {
		if (demanded.has(v.name) || (bindings.get(v) ?? 0) !== 1) {
			live.add(v)
		}
	}
	for (const e of region.equalities) {
		live.add(e.a)
		live.add(e.b)
	}
	for (const c of region.correlated) {
		live.add(c.var)
	}
	return live
}

/** The nodes that keep their current form: each delivers its whole heading and, for a region, binds every variable. */
type Pinned = (node: RelNode) => boolean

/** No node pinned: every node delivers only what its readers demand. */
export const noPins: Pinned = () => false

/**
 * What `reader` needs of its input `input`, given the columns of `reader` that are demanded.
 *
 * A single-heading union needs of each arm what its readers need, and its discriminant: the literal columns
 * that tell its arms apart are what proves them disjoint.
 */
const need = (
	reader: RelNode,
	input: RelNode,
	demanded: ReadonlySet<string>,
	liveVars: (region: NodeOf<"MatchRegion">) => ReadonlySet<VarDecl>
): ReadonlySet<string> => {
	switch (reader.kind) {
		case "Filter":
			return new Set([...demanded, ...exprColumns([reader.pred], input.id)])
		case "Step":
			return demanded
		case "ProjectSet":
			return new Set(
				exprColumns(
					reader.out.filter((o) => demanded.has(o.name)).map((o) => o.expr),
					input.id
				)
			)
		case "MatchRegion": {
			const live = liveVars(reader)
			const reading = reader.occurrences.filter((o) => o.source === input)
			return new Set(
				reading.flatMap((o) => [
					...o.bindings.filter((b) => live.has(b.var)).map((b) => b.column),
					...o.constants.map((c) => c.column)
				])
			)
		}
		case "SemiJoin":
		case "AntiJoin": {
			return new Set([
				...(reader.left === input ? [...demanded, ...reader.on.map((p) => p.left)] : []),
				...(reader.right === input ? reader.on.map((p) => p.right) : [])
			])
		}
		case "Union":
			return reader.groups.length === 1
				? new Set([...demanded, ...reader.discriminant].filter((c) => all(input).has(c)))
				: all(input)
		case "Group":
			return new Set([
				...reader.bound.columns,
				...reader.keys,
				...exprColumns(
					reader.aggs.flatMap((a) => [...a.args, ...(a.filter === undefined ? [] : [a.filter])]),
					input.id
				)
			])
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Intersect":
		case "Difference":
		case "Take":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
		case "Call":
			return all(input)
	}
}

/**
 * The demand of every reachable node.
 *
 * A region's constant reading another occurrence's source is as lateral as a correlated source's reference
 * to an enclosing region, though the region takes the source as an input: moving that occurrence out of
 * the region would move the source out of the constant's scope.
 *
 * Reverse topological order: every reader is visited, with its demand complete, before its inputs.
 */
export const analyzeDemand = (dag: RelDag, pinned: Pinned): DemandAnalysis => {
	const order = topoOrder(dag)
	/** Every count, demand and live set below is keyed by the label of the node it is of (a column reference names one). */
	const structure = structureOf(
		order,
		dag.roots,
		(node) => edgesOf(node),
		(node) => scopeLabels(node),
		(node) => node.id
	)
	const demanded = new Map<NodeId, Set<string>>()
	const add = (id: NodeId, columns: Iterable<string>) => {
		const set = demanded.get(id) ?? new Set<string>()
		for (const c of columns) {
			set.add(c)
		}
		demanded.set(id, set)
	}
	for (const ref of lateralReadsOf(order, (node) => scopeExprs(node))) {
		add(ref.node, [ref.name])
	}
	for (const r of dag.roots) {
		add(r.id, all(r))
	}
	const liveVars = new Map<NodeId, ReadonlySet<VarDecl>>()
	const liveOf = (region: NodeOf<"MatchRegion">): ReadonlySet<VarDecl> => {
		const known = liveVars.get(region.id)
		if (known !== undefined) {
			return known
		}
		const live = pinned(region)
			? new Set(region.vars)
			: liveVariables(region, demanded.get(region.id) ?? new Set())
		liveVars.set(region.id, live)
		return live
	}
	for (const node of order.toReversed()) {
		if (pinned(node)) {
			add(node.id, all(node))
		}
		const mine = demanded.get(node.id) ?? new Set<string>()
		demanded.set(node.id, mine)
		if (node.kind === "MatchRegion") {
			liveOf(node)
		}
		for (const input of inputsOf(node)) {
			add(input.id, need(node, input, mine, liveOf))
		}
	}
	const none: ReadonlySet<never> = new Set()
	return {
		dag,
		order,
		demanded: (node) => demanded.get(node.id) ?? none,
		liveVars: (node) =>
			node.kind === "MatchRegion" ? (liveVars.get(node.id) ?? liveOf(node)) : none,
		references: (node) => structure.references(node.id),
		lateral: (node) => structure.lateral(node.id)
	}
}
