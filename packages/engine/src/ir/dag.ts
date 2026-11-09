import { appendAll } from "#compiler/core/array.ts"
import { nominal } from "#compiler/core/brand.ts"
import { catchRefusal, omitSourceLocs, Refusal } from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { digest } from "#compiler/core/fingerprint.ts"
import {
	allocatedKinds,
	ExprId,
	type LawId,
	NodeId,
	OccurrenceId,
	type ParamId,
	ScopeId,
	VarId
} from "#compiler/core/ids.ts"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import {
	builtExpr,
	type ExprSpec,
	type ExprSpecOver,
	exprClosure,
	type LiveArgs,
	mapArgs,
	outsideSpec,
	type ScalarExpr,
	sortedUnique,
	type TableArgs,
	type TableExpr,
	withArgs
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import {
	type Cell,
	type DagTable,
	type EditRefs,
	edgesOf,
	exprsOf,
	fieldParams,
	inputsOf,
	keptRefs,
	keptRowsOf,
	type LiveRefs,
	mapNode,
	mapRoots,
	metaSpecOf,
	type NodeMeta,
	type NodeOf,
	type NodeOver,
	type NodeSpec,
	type RefMap,
	type RelDag,
	type RelNode,
	type Rooted,
	type RootedDag,
	type Roots,
	type SpecRefs,
	scopeExprs,
	type TableNode,
	type TableRefs,
	type ValidDag,
	type ValueRefs,
	type VarDecl,
	conservativeMeta
} from "#compiler/ir/rel.ts"
import * as S from "#compiler/ir/shape.ts"

const malformed = (path: S.Path, capability: string): CompileError =>
	S.malformedAt("relational DAG", path, capability)

const noIds: ReadonlyArray<never> = Object.freeze([])

/** `value`, frozen in place, at its own type. */
const freeze = <A>(value: A): A => {
	Object.freeze(value)
	return value
}

/**
 * `value` frozen throughout, stopping at what is frozen already: a node's inputs and its expressions are frozen when
 * they are built, so freezing a new node walks only its own fields, never the DAG below it.
 */
const deepFreeze = <A>(value: A): A => {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value)
		const children: ReadonlyArray<unknown> = Object.values(value)
		for (const child of children) {
			deepFreeze(child)
		}
	}
	return value
}

/**
 * The one constructor of a node: `spec` labelled `id`, with its structural fields computed, frozen. Its parameters are
 * its own fields' (rel.ts fieldParams), its expressions' (each expression's dependencies are already its whole tree's)
 * and its inputs'; its stored reads are a Base's relation and its inputs'. Both are lexical: a SelfRef's feedback is a
 * name and is not followed, and a Recursive, whose base, step and SelfRef are its inputs, covers its region. Every
 * input is a node this constructor built, so its fields are final, and so are the new node's.
 */
export const relNode = (id: NodeId, spec: NodeSpec): RelNode => {
	const params = new Set<ParamId>(fieldParams(spec))
	for (const e of exprsOf(spec)) {
		for (const p of e.deps.params) {
			params.add(p)
		}
	}
	const reads = new Set<string>(spec.kind === "Base" ? [spec.relation] : [])
	for (const input of edgesOf(spec)) {
		for (const p of input.meta.paramDeps) {
			params.add(p)
		}
		for (const r of input.meta.reads) {
			reads.add(r)
		}
	}
	const meta: NodeMeta = {
		logicalKeys: spec.meta.logicalKeys,
		card: spec.meta.card,
		context: spec.meta.context,
		paramDeps: sortedUnique(params),
		reads: sortedUnique(reads)
	}
	return deepFreeze({ ...spec, id, meta })
}

/** The one mint of ValidDag, which only the constructions below reach. */
const valid = <R extends Roots>(dag: RelDag<R>): ValidDag<R> =>
	nominal<RelDag<R>, ValidDag<R>>()(dag)

/**
 * The DAG of `roots`, each a node the one constructor built (relNode) under a label its construction minted once: a
 * builder's (DagBuilder.build) or an editor's. Its nodes need no further assembly: their structural fields are final
 * when they are built.
 */
export const assembledDag = <R extends Roots>(roots: R): ValidDag<R> =>
	valid(freeze({ roots: freeze(roots) }))

/** A valid DAG read from other roots, each a node of it: a write's read-back, a query's root moved first. */
export const rooted = (roots: Rooted): RootedDag => assembledDag(roots)

type AllocatedKind = keyof typeof allocatedKinds

/** The highest numeric suffix of each allocated kind among a DAG's labels: the supply its merges' fresh labels follow. */
export type LabelTops = Readonly<Record<AllocatedKind, number>>

/**
 * A valid DAG with its label supply: no allocated label it holds is past its kind's top (LabelTops), so a merge into it
 * labels the extension past the tops and reads none of its labels. A merge answers one (mergeDags), the empty DAG is
 * one, and so is the DAG of a theory's laws (LabelSupply.dag), which starts from its builder's DAG's labels, read once.
 */
export type LabelledDag<R extends Roots = Roots> = ValidDag<R> & { readonly tops: LabelTops }

/** The one mint of LabelledDag: `roots`, each a node a construction built, with the tops of the labels they reach. */
const labelledDag = <R extends Roots>(roots: R, tops: LabelTops): LabelledDag<R> =>
	nominal<RelDag<R> & { readonly tops: LabelTops }, LabelledDag<R>>()(
		freeze({ roots: freeze(roots), tops: freeze(tops) })
	)

/** The empty DAG of no roots, which holds no label: what a merge of queries starts from. */
export const emptyDag: LabelledDag = labelledDag(noIds, {
	node: 0,
	expr: 0,
	var: 0,
	occurrence: 0,
	scope: 0
})

/**
 * A fold step's reading of `node`: each data edge yielded in structural order (rel.ts mapNode) and its value received,
 * the node returned with every edge replaced by its value, so a step reads `values.input`, `values.base` or
 * `values.left` by role. Every other field is the node's own.
 */
export function* edgeValues<A>(node: RelNode): Generator<RelNode, NodeOver<ValueRefs<A>>, A> {
	return yield* mapNode<LiveRefs, ValueRefs<A>>(node, keptRefs)
}

/** Whether a rebuilt reading of `node` (edgeValues over a rebuild) holds the node's own inputs, edge for edge. */
export const unchangedEdges = (node: RelNode, rebuilt: NodeOver<ValueRefs<RelNode>>): boolean => {
	const before = edgesOf(node)
	const after = edgesOf(rebuilt)
	return before.length === after.length && before.every((edge, i) => after[i] === edge)
}

/**
 * The vertices `roots` reach through `inputs`, in topological order: every vertex after its inputs, depth-first from
 * each root in order and through each vertex's inputs in their order, each vertex once (a vertex met again, on a path
 * or off it, is not entered again, so the walk ends over any graph). Its frames are on the heap: a chain of any depth
 * walks.
 */
export const postorder = <V>(
	roots: ReadonlyArray<V>,
	inputs: (vertex: V) => ReadonlyArray<V>
): ReadonlyArray<V> => {
	const order: Array<V> = []
	const seen = new Set<V>()
	for (const root of roots) {
		if (seen.has(root)) {
			continue
		}
		seen.add(root)
		const stack: Array<{ readonly vertex: V; readonly inputs: ReadonlyArray<V>; next: number }> = [
			{ vertex: root, inputs: inputs(root), next: 0 }
		]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const input = frame.inputs[frame.next]
			if (input === undefined) {
				stack.pop()
				order.push(frame.vertex)
				continue
			}
			frame.next++
			if (!seen.has(input)) {
				seen.add(input)
				stack.push({ vertex: input, inputs: inputs(input), next: 0 })
			}
		}
	}
	return order
}

/**
 * The nodes the roots reach through data edges, in topological order: every node after its inputs, depth-first from
 * each root in order and through each node's distinct inputs in structural order (postorder over rel.ts inputsOf),
 * each node once. A SelfRef's feedback is a name, not followed.
 */
export const topoOrder = (dag: RelDag): ReadonlyArray<RelNode> =>
	postorder(dag.roots, (node) => inputsOf(node))

/** An editor's cells the roots reach through their current inputs, in topological order (postorder). */
export const cellOrder = (roots: ReadonlyArray<Cell>): ReadonlyArray<Cell> =>
	postorder(roots, (cell) => inputsOf(cell.current))

/**
 * The nodes a DAG holds by label, built by one walk for one reader's call: the tolerant reading of a name a node holds
 * (a column reference's node, a SelfRef's Recursive), where a miss is a property of the input, never a defect. It is
 * per-call traversal state, as a walk's seen-set is.
 */
export const nodesByLabel = (dag: RelDag): ReadonlyMap<NodeId, RelNode> => {
	const index = new Map<NodeId, RelNode>()
	for (const node of topoOrder(dag)) {
		if (!index.has(node.id)) {
			index.set(node.id, node)
		}
	}
	return index
}

/**
 * The rows a root delivers and every delivery node on them: the nodes whose rows are the root's delivered rows
 * under its heading, outermost first; the attachments met on them, each with its child's own spine; the ordered
 * results met; and, where the walk ends at a union of several arms, each arm's own spine, in group then arm order.
 */
export interface DeliverySpine {
	readonly nodes: NonEmptyReadonlyArray<RelNode>
	readonly attachments: ReadonlyArray<{
		readonly attach: NodeOf<"Attach">
		readonly child: DeliverySpine
	}>
	readonly ordered: ReadonlyArray<NodeOf<"OrderedResult">>
	/** The union of several arms the walk ends at, and each arm's own spine; undefined where it ends elsewhere. */
	readonly arms:
		| { readonly union: NodeOf<"Union">; readonly spines: NonEmptyReadonlyArray<DeliverySpine> }
		| undefined
}

/**
 * The one walk of a root's delivered rows: down the kept rows (keptRowsOf), into the one arm of a union of one arm,
 * ending at a node that computes its rows or at a union of several arms. Every node it reads is an input of the one
 * before, built before it, so the walk ends.
 */
export const deliverySpine = (root: RelNode): DeliverySpine => {
	const nodes: [RelNode, ...Array<RelNode>] = [root]
	const attachments: Array<{ readonly attach: NodeOf<"Attach">; readonly child: DeliverySpine }> =
		[]
	const ordered: Array<NodeOf<"OrderedResult">> = []
	for (let node = root; ;) {
		if (node.kind === "Attach") {
			attachments.push({ attach: node, child: deliverySpine(node.child) })
		} else if (node.kind === "OrderedResult") {
			ordered.push(node)
		}
		let next: RelNode | undefined
		if (node.kind === "Union") {
			const [group, ...groups] = node.groups
			const [first, ...more] = group.arms
			const arms = [first, ...more, ...groups.flatMap((g) => g.arms)] as const
			if (arms.length > 1) {
				const spines = mapNonEmpty(arms, (arm) => deliverySpine(arm))
				return { nodes, attachments, ordered, arms: { union: node, spines } }
			}
			next = first
		} else {
			next = keptRowsOf(node)?.input
		}
		if (next === undefined) {
			return { nodes, attachments, ordered, arms: undefined }
		}
		nodes.push(next)
		node = next
	}
}

/** Columns of other nodes, by the label of the node they belong to. */
export type OuterRefs = ReadonlyMap<NodeId, ReadonlySet<string>>

export interface NodeScope {
	/** The columns of nodes outside the node's own scope that its evaluation reads. */
	readonly outer: OuterRefs
	/** The variables those columns name, sorted. */
	readonly freeVars: ReadonlyArray<VarId>
}

const noRefs: OuterRefs = new Map()

const noNodes: ReadonlyArray<NodeId> = Object.freeze([])

/**
 * The scope of a node that reads no column from outside it: a source, or a node that binds every reference below it.
 */
const closed: NodeScope = Object.freeze({ outer: noRefs, freeVars: noIds })

/**
 * What a node evaluates in its own scope: the expressions outer values enter through; the labels of the nodes besides
 * itself those expressions are evaluated over, which it binds for every reference; and each input it evaluates per row
 * of another, with the labels of the nodes whose columns that row supplies, which it binds for that input's references
 * alone.
 */
interface Entry {
	readonly exprs: ReadonlyArray<ScalarExpr>
	readonly over: ReadonlyArray<NodeId>
	readonly perRow: ReadonlyArray<{ readonly input: RelNode; readonly rows: ReadonlyArray<NodeId> }>
}

const noEntry: Entry = Object.freeze({ exprs: [], over: [], perRow: [] })

const entryOf = (node: RelNode): Entry => {
	switch (node.kind) {
		case "MatchRegion":
			return { exprs: scopeExprs(node), over: node.occurrences.map((o) => o.source.id), perRow: [] }
		case "Take":
			return { exprs: scopeExprs(node), over: [node.input.id], perRow: [] }
		case "Attach":
			return {
				exprs: [],
				over: [],
				perRow: [{ input: node.child, rows: deliverySpine(node.parent).nodes.map((n) => n.id) }]
			}
		case "SemiJoin":
		case "AntiJoin":
			return { exprs: [], over: [], perRow: [{ input: node.right, rows: [node.left.id] }] }
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "Filter":
		case "ProjectSet":
		case "Union":
		case "Intersect":
		case "Difference":
		case "Group":
		case "Produce":
		case "Recursive":
		case "SelfRef":
		case "ApproximateNearest":
		case "OrderedResult":
		case "Forbid":
		case "Window":
		case "OrderedSetAggregate":
			return noEntry
	}
}

/** The column references the expression trees `exprs` make to nodes `bound` does not hold. */
const refsOf = (exprs: ReadonlyArray<ScalarExpr>, bound: (id: NodeId) => boolean): OuterRefs => {
	if (exprs.length === 0) {
		return noRefs
	}
	const out = new Map<NodeId, Set<string>>()
	for (const e of exprClosure(exprs)) {
		if (e.kind !== "column" || bound(e.column.node)) {
			continue
		}
		const columns = out.get(e.column.node)
		if (columns === undefined) {
			out.set(e.column.node, new Set([e.column.name]))
		} else {
			columns.add(e.column.name)
		}
	}
	return out.size === 0 ? noRefs : out
}

/** The variables outer references name: a region's columns, by their names; a label no region holds names none. */
const named = (index: ReadonlyMap<NodeId, RelNode>, refs: OuterRefs): ReadonlyArray<VarId> => {
	const vars: Array<VarId> = []
	for (const [id, columns] of refs) {
		const node = index.get(id)
		if (node?.kind === "MatchRegion") {
			appendAll(
				vars,
				node.vars.filter((v) => columns.has(v.name)).map((v) => v.id)
			)
		}
	}
	return sortedUnique(vars)
}

/** One input's scope as its reader receives it: the scope, and the labels the reader binds for that input alone. */
interface Carried {
	readonly scope: NodeScope
	readonly rows: ReadonlyArray<NodeId>
}

/**
 * The scope of `node` from its distinct inputs' scopes. A node that adds no reference of its own and binds none of the
 * one input scope carrying any has that input's scope, the same value, so a chain of nodes shares one; a node none of
 * whose inputs carries a reference and that makes none is closed, its entry never read.
 */
const scopeOf = (
	index: ReadonlyMap<NodeId, RelNode>,
	node: RelNode,
	inputs: ReadonlyArray<{ readonly input: RelNode; readonly scope: NodeScope }>
): NodeScope => {
	if (scopeExprs(node).length === 0 && inputs.every(({ scope }) => scope.outer.size === 0)) {
		return closed
	}
	const entry = entryOf(node)
	const binds = (rows: ReadonlyArray<NodeId>, id: NodeId): boolean =>
		id === node.id || entry.over.includes(id) || rows.includes(id)
	const own = refsOf(entry.exprs, (id) => binds(noNodes, id))
	const carried: Array<Carried> = []
	for (const { input, scope } of inputs) {
		if (scope.outer.size === 0) {
			continue
		}
		const rows = entry.perRow.flatMap((p) => (p.input === input ? p.rows : []))
		if (!carried.some((c) => c.scope === scope && c.rows.length === 0 && rows.length === 0)) {
			carried.push({ scope, rows })
		}
	}
	const [only, ...more] = carried
	if (only === undefined) {
		return own.size === 0 ? closed : { outer: own, freeVars: named(index, own) }
	}
	const refs = only.scope.outer
	if (
		own.size === 0 &&
		more.length === 0 &&
		!refs.has(node.id) &&
		!entry.over.some((id) => refs.has(id)) &&
		!only.rows.some((id) => refs.has(id))
	) {
		return only.scope
	}
	const outer = new Map<NodeId, Set<string>>()
	const add = (from: OuterRefs, rows: ReadonlyArray<NodeId>): void => {
		for (const [id, columns] of from) {
			if (!binds(rows, id)) {
				outer.set(id, new Set([...(outer.get(id) ?? []), ...columns]))
			}
		}
	}
	add(own, noNodes)
	for (const c of carried) {
		add(c.scope.outer, c.rows)
	}
	return outer.size === 0 ? closed : { outer, freeVars: named(index, outer) }
}

/**
 * The scope of every node of `dag`, each computed from its inputs' (a fold): `nodeScopes(dag).of(node)`. A root's is
 * closed in a valid DAG: its statement is lowered with nothing in scope. Logical analysis reads a lateral source's outer
 * references from it; a node whose scope has free variables reads an enclosing region per row.
 *
 * The scope of a node: the columns of other nodes its evaluation reads, and the variables they name, its free
 * variables.
 *
 * Outer values enter a node only through the expressions it evaluates in its own scope (rel.ts scopeExprs): a take's
 * correlation, and a region's constants and correlated variables. Every other expression a node evaluates reads its
 * own input alone.
 *
 * Rule: a node's outer references are its inputs' outer references and the column references its own scope expressions
 * make, but those to a node it binds. A node binds:
 *
 * - itself;
 * - the nodes its scope expressions are evaluated over: a region's occurrences' sources, a take's input;
 * - for an input it evaluates per row of another, the nodes whose columns that row supplies: an attachment binds, for
 *   its child alone, the nodes of its parent's delivered rows (deliverySpine), and a semi-join or anti-join, for
 *   its right side alone, its left input.
 *
 * So a reference passes up through every input until a node binds what it names: a lateral source's reference to its
 * region, or to an earlier occurrence's source, is bound at that region, an attachment's child's reference to a parent
 * variable at the attachment, and a semi-join's right side's reference to its left at the semi-join. A node's free
 * variables are the variables its outer references name: a column of a region is its variable of that name, and a
 * column of any other node names none. The region a reference names is read through the DAG's labels (nodesByLabel),
 * built once for the fold.
 *
 * The per-row bindings change no evaluation, only the record of the binding node and the nodes above it. The child of
 * an attachment is still evaluated per delivered parent row: the delivery maps every node of the statement's delivered
 * rows, which hold the parent's (deliverySpine walks through an attachment into its parent), to that row's columns
 * (lower/conservative/deliver.ts attachmentQuery; lower/shapes/attach childRows and pipelinedAttachment), and inside
 * the child the reference stays free, so the child and every node in it keep their record. An attachment's rows, as a
 * relation, are its parent's (lower/conservative/attach lowerAttach, which the optimized lowering delivers as it is),
 * and so are those of every node above it built on them: no relation from the attachment up evaluates the child, so
 * none reads an outer row for it, and one may be shared or computed once. A semi-join's or anti-join's right side is
 * evaluated inside its existence test with the left input's row in scope (lower/conservative/semi-join/exists.ts), so
 * its references to the left resolve there, and the semi-join's rows are some of its left's. A reference to any other
 * node, such as the input of a parent that computes its own rows, or a node below a semi-join's left, which the
 * lowering does not map, or one reaching the binding node from its other input, is not bound there.
 */
export const nodeScopes = (dag: RelDag): Fold<RelNode, NodeScope> => {
	const index = nodesByLabel(dag)
	return new Fold<RelNode, NodeScope>(function* (node) {
		const inputs: Array<{ readonly input: RelNode; readonly scope: NodeScope }> = []
		for (const input of inputsOf(node)) {
			const scope: NodeScope = yield input
			inputs.push({ input, scope })
		}
		return scopeOf(index, node, inputs)
	})
}

/**
 * The cell of each node `roots` reach, and of no other: its label, and its edit form, whose inputs are its inputs'
 * cells and whose metadata is what the node states (rel.ts metaSpecOf). The cells are made inputs first from each root
 * in turn, and `made` receives every cell as it is made, so an editor keeps them in creation order.
 */
export const cellTable = (
	roots: ReadonlyArray<RelNode>,
	made: (cell: Cell) => void
): ReadonlyMap<RelNode, Cell> => {
	const cells = new Fold<RelNode, Cell>(function* (node) {
		const current = yield* mapNode<LiveRefs, EditRefs>(node, { ...keptRefs, meta: metaSpecOf })
		const cell: Cell = { id: node.id, current }
		made(cell)
		return cell
	})
	for (const root of roots) {
		cells.of(root)
	}
	return new Map(postorder(roots, (node) => inputsOf(node)).map((node) => [node, cells.of(node)]))
}

/**
 * The first cell that reaches itself through its current inputs, by an iterative depth-first search from each of
 * `roots` in order; undefined when the cells' edges are acyclic. Cells are the one form whose edges can close a cycle,
 * since a rewrite redefines them in place.
 */
const cellCycle = (roots: ReadonlyArray<Cell>): Cell | undefined => {
	const state = new Map<Cell, "open" | "done">()
	for (const root of roots) {
		if (state.has(root)) {
			continue
		}
		state.set(root, "open")
		const stack: Array<{
			readonly cell: Cell
			readonly inputs: ReadonlyArray<Cell>
			next: number
		}> = [{ cell: root, inputs: inputsOf(root.current), next: 0 }]
		for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
			const input = frame.inputs[frame.next]
			if (input === undefined) {
				stack.pop()
				state.set(frame.cell, "done")
				continue
			}
			frame.next++
			const inputState = state.get(input)
			if (inputState === "open") {
				return input
			}
			if (inputState === undefined) {
				state.set(input, "open")
				stack.push({ cell: input, inputs: inputsOf(input.current), next: 0 })
			}
		}
	}
	return undefined
}

/** What an editor's cells hold now: the DAG, and the node each cell stands as in it. */
export interface FinishedCells<R extends Roots> {
	readonly dag: ValidDag<R>
	/**
	 * The node `cell` stands as in `dag`: a cell the roots reach is folded already; any other is folded on demand, over
	 * inputs no rewrite left in a cycle.
	 */
	readonly node: (cell: Cell) => RelNode
}

/**
 * The DAG an editor's cells hold now, rooted where each of `roots` stands (`cellOf`, the cell of a root of the DAG the
 * editor started from, after every move): each cell folded into a node by the one constructor (relNode), inputs first,
 * so every structural field is computed from what the edits left; `node` reads each cell's node in it, so a rewrite
 * holding cells analyzes the finished DAG. A cell no root reaches is left behind. A cycle a rewrite made through the
 * cells' edges is MalformedDescription, the CompileError the rewrite throws, as builders do.
 */
export const finishCells = <R extends Roots>(
	roots: R,
	cellOf: (root: RelNode) => Cell
): Result.Result<FinishedCells<R>, CompileError> => {
	const cycle = cellCycle(roots.map((root) => cellOf(root)))
	if (cycle !== undefined) {
		return Result.err(
			malformed(["nodes", cycle.id], "an acyclic DAG: the node reaches itself through its inputs")
		)
	}
	const built = new Fold<Cell, RelNode>(function* (cell) {
		const spec = yield* mapNode<EditRefs, SpecRefs>(cell.current, keptRefs)
		return relNode(cell.id, spec)
	})
	const dag = assembledDag(mapRoots(roots, (root) => built.of(cellOf(root))))
	return Result.ok({ dag, node: (cell) => built.of(cell) })
}

/** The highest numeric suffix of each allocated kind among a DAG's labels, so fresh labels can follow it. */
const highest = (dag: RelDag): Record<AllocatedKind, number> => {
	const top: Record<AllocatedKind, number> = { node: 0, expr: 0, var: 0, occurrence: 0, scope: 0 }
	const see = (kind: AllocatedKind, id: string): void => {
		const prefix = allocatedKinds[kind]
		const n = id.startsWith(prefix) ? Number(id.slice(prefix.length)) : 0
		if (Number.isSafeInteger(n) && n > top[kind]) {
			top[kind] = n
		}
	}
	const nodes = topoOrder(dag)
	for (const node of nodes) {
		see("node", node.id)
		if (node.kind === "Base") {
			see("occurrence", node.occurrence)
		}
		if (node.kind === "Group") {
			for (const k of node.bound.keyed) {
				see("occurrence", k.occurrence)
			}
		}
		if (node.kind === "MatchRegion") {
			see("scope", node.scope)
			for (const v of node.vars) {
				see("var", v.id)
			}
			for (const o of node.occurrences) {
				see("occurrence", o.id)
			}
		}
	}
	for (const e of exprClosure(nodes.flatMap((node) => exprsOf(node)))) {
		see("expr", e.id)
	}
	return top
}

/** An extension renamed into a label space: its roots' counterparts, and any node's or expression's. */
interface Renamed {
	readonly roots: Roots
	/** The renamed counterpart of a node of the extension. */
	readonly node: (node: RelNode) => RelNode
	/** The renamed counterpart of an expression of the extension. */
	readonly expr: (expr: ScalarExpr) => ScalarExpr
}

/**
 * The extension's nodes and expressions under fresh labels past `tops`, which advance past each one given: a fold over
 * the extension that renames every allocated label, and every name a renamed node or expression holds (a column
 * reference's node, a SelfRef's Recursive, a premise's node) with it. Each renamed node is built by the one constructor.
 */
const renamedPast = (tops: Record<AllocatedKind, number>, extension: ValidDag): Renamed => {
	const fresh = <A extends string>(kind: AllocatedKind, make: (s: string) => A) => {
		const seen = new Map<string, A>()
		return (id: A): A => {
			const known = seen.get(id)
			if (known !== undefined) {
				return known
			}
			tops[kind] += 1
			const next = make(`${allocatedKinds[kind]}${tops[kind]}`)
			seen.set(id, next)
			return next
		}
	}
	const nodeName = fresh("node", NodeId)
	const exprName = fresh("expr", ExprId)
	const varName = fresh("var", VarId)
	const occurrence = fresh("occurrence", OccurrenceId)
	const scope = fresh("scope", ScopeId)
	/** A region's variable and every reference to it are one object, so each is renamed once, to one object. */
	const decls = new Map<VarDecl, VarDecl>()
	const decl = (d: VarDecl): VarDecl => {
		const known = decls.get(d)
		if (known !== undefined) {
			return known
		}
		const renamed: VarDecl = Object.freeze({ ...d, id: varName(d.id) })
		decls.set(d, renamed)
		return renamed
	}
	const exprs = new Fold<ScalarExpr, ScalarExpr>(function* (e) {
		const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
		const renamed: ExprSpec =
			spec.kind === "column"
				? { ...spec, column: { node: nodeName(spec.column.node), name: spec.column.name } }
				: spec
		return builtExpr(renamed, exprName(e.id))
	})
	const nodes = new Fold<RelNode, RelNode>(function* (node) {
		const spec = yield* mapNode<LiveRefs, SpecRefs>(node, {
			expr: (e) => exprs.of(e),
			var: decl,
			decl,
			occurrence,
			scope,
			name: nodeName,
			meta: metaSpecOf
		})
		return relNode(nodeName(node.id), spec)
	})
	return {
		roots: extension.roots.map((root) => nodes.of(root)),
		node: (n) => nodes.of(n),
		expr: (e) => exprs.of(e)
	}
}

interface MergedDag {
	/** The merged DAG, its tops the last fresh label of each kind the merge gave the extension, or the base's. */
	readonly dag: LabelledDag
	/** The merged counterpart of a node of the extension. */
	readonly node: (node: RelNode) => RelNode
	/** The merged counterpart of an expression of the extension. */
	readonly expr: (expr: ScalarExpr) => ScalarExpr
}

/**
 * The base DAG with the extension's nodes and expressions added under fresh labels past the base's tops (renamedPast),
 * so the two share none, its roots after the base's. The base's nodes are kept as they are. The merge of two valid
 * DAGs is valid. `node` and `expr` read the counterpart of any node or expression of the extension.
 */
export const mergeDags = (base: LabelledDag, extension: ValidDag): MergedDag => {
	const tops = { ...base.tops }
	const renamed = renamedPast(tops, extension)
	return {
		dag: labelledDag([...base.roots, ...renamed.roots], { ...tops }),
		node: renamed.node,
		expr: renamed.expr
	}
}

/**
 * The label space of a theory's laws: the highest numeric suffix of each allocated kind among the labels its builder's
 * DAG holds, read once when it starts, and advanced past each rule's violation query merged into it under the rule's
 * Forbid node (forbid), so no merge reads a DAG for its labels. dag() is the DAG of the laws' violations, with its tops.
 */
export class LabelSupply {
	readonly #tops: Record<AllocatedKind, number>

	constructor(built: ValidDag) {
		this.#tops = highest(built)
	}

	/**
	 * A law's violation query under its Forbid node: `query`'s nodes renamed past every label so far (renamedPast), and
	 * the Forbid over `violation`, the query's counterpart there, labelled past them.
	 */
	forbid(query: ValidDag, violation: RelNode, law: LawId): RelNode {
		const root = renamedPast(this.#tops, query).node(violation)
		this.#tops.node += 1
		return relNode(NodeId(`${allocatedKinds.node}${this.#tops.node}`), {
			kind: "Forbid",
			lawId: law,
			violation: root,
			heading: root.heading,
			loc: undefined,
			meta: conservativeMeta
		})
	}

	/** The DAG of `roots`, the builder's DAG's nodes and the Forbid nodes forbid gave, with the labels' tops. */
	dag<R extends Roots>(roots: R): LabelledDag<R> {
		return labelledDag(roots, { ...this.#tops })
	}
}

/** Fresh positional names of one namespace, "<ns>#<i>", by first occurrence of the label they rename. */
class Numbering<A extends string> {
	readonly #ns: string
	readonly #make: (s: string) => A
	readonly #names = new Map<string, A>()

	constructor(ns: string, make: (s: string) => A) {
		this.#ns = ns
		this.#make = make
	}

	has(id: string): boolean {
		return this.#names.has(id)
	}

	/** The name of `id`, minted now when it has none. */
	name(id: string): A {
		const known = this.#names.get(id)
		if (known !== undefined) {
			return known
		}
		const name = this.#make(`${this.#ns}#${this.#names.size}`)
		this.#names.set(id, name)
		return name
	}

	/** The name of `id`, which the numbering already holds; a label it never met is MalformedDescription. */
	named(id: string, path: S.Path): A {
		const known = this.#names.get(id)
		if (known === undefined) {
			throw new Refusal(malformed(path, `a reachable reference, not ${id}`))
		}
		return known
	}
}

/**
 * The allocation-independent form of the DAG `roots` reach within `context`: nodes and expressions renamed "n#i" and
 * "e#i", variables, occurrences and scopes "v#i", "o#i" and "s#i", each numbered by first occurrence breadth-first
 * from the roots in structural order (rel.ts mapNode, then an expression's arguments in operand order and its column's
 * node); parameter ids are declared names and are kept. A name a node holds (a column reference's node, a SelfRef's
 * Recursive, a premise's node) that the walk has not met yet is read through `context`'s labels (nodesByLabel, built
 * when first needed), so a sub-query's digest numbers the enclosing nodes it reads; a name `context` does not hold is
 * MalformedDescription. Each expression's dependencies are renamed with it.
 */
export const normalizeWithin = (
	context: RelDag,
	roots: Roots
): Result.Result<DagTable, CompileError> =>
	catchRefusal(() => {
		const n = new Numbering("n", NodeId)
		const e = new Numbering("e", ExprId)
		const v = new Numbering("v", VarId)
		const o = new Numbering("o", OccurrenceId)
		const s = new Numbering("s", ScopeId)
		type Item =
			| { readonly kind: "node"; readonly node: RelNode }
			| { readonly kind: "expr"; readonly expr: ScalarExpr }
		const queue: Array<Item> = []
		/** The context's labels, read only when a name the walk has not met needs its node. */
		let index: ReadonlyMap<NodeId, RelNode> | undefined
		const labelled = (id: NodeId): RelNode | undefined => {
			const known = index ?? nodesByLabel(context)
			index = known
			return known.get(id)
		}
		const nodeRef = (node: RelNode): NodeId => {
			if (!n.has(node.id)) {
				queue.push({ kind: "node", node })
			}
			return n.name(node.id)
		}
		const nodeName = (id: NodeId): NodeId => {
			if (!n.has(id)) {
				const node = labelled(id)
				if (node === undefined) {
					throw new Refusal(malformed(["nodes"], `a node named ${id} in the table`))
				}
				queue.push({ kind: "node", node })
			}
			return n.name(id)
		}
		const exprRef = (expr: ScalarExpr): ExprId => {
			if (!e.has(expr.id)) {
				queue.push({ kind: "expr", expr })
			}
			return e.name(expr.id)
		}
		const numbered: RefMap<LiveRefs, TableRefs> = {
			expr: exprRef,
			var: (ref) => v.name(ref.id),
			decl: (d) => ({ ...d, id: v.name(d.id) }),
			occurrence: (id) => o.name(id),
			scope: (id) => s.name(id),
			name: nodeName,
			meta: (meta) => meta
		}
		const tableRoots = roots.map(nodeRef)
		const nodes: Record<NodeId, TableNode> = {}
		const pending: Array<{
			readonly expr: ScalarExpr
			readonly id: ExprId
			readonly spec: ExprSpecOver<TableArgs>
		}> = []
		for (const item of queue) {
			if (item.kind === "node") {
				const id = n.name(item.node.id)
				const entry = drive(mapNode<LiveRefs, TableRefs>(item.node, numbered), nodeRef)
				nodes[id] = { ...entry, id }
				continue
			}
			const expr = item.expr
			const args = withArgs<LiveArgs, TableArgs>(outsideSpec(expr), exprRef)
			const id = e.name(expr.id)
			const spec: ExprSpecOver<TableArgs> =
				args.kind === "column"
					? { ...args, column: { node: nodeName(args.column.node), name: args.column.name } }
					: args
			pending.push({ expr, id, spec })
		}
		const exprs: Record<ExprId, TableExpr> = {}
		for (const { expr, id, spec } of pending) {
			const deps = {
				params: expr.deps.params,
				nodes: sortedUnique(expr.deps.nodes.map((label) => n.named(label, ["exprs", id, "deps"])))
			}
			exprs[id] = { ...spec, volatility: expr.volatility, id, deps }
		}
		return deepFreeze({ roots: tableRoots, nodes, exprs })
	})

/**
 * The semantic fingerprint of a DAG: SHA-256 over its normalized canonical text, source locations excluded. Two DAGs
 * of one domain that differ only in allocation order and the proofs of their claimed keys have one digest.
 */
type DagDigest = string & { readonly [dagDigestBrand]: true }
declare const dagDigestBrand: unique symbol
const DagDigest = nominal<string, DagDigest>()

/**
 * What a normal DAG's digest reads: each node with its claimed keys as the columns they claim. A key's proof is a value
 * about the DAG its analysis ran over, naming that DAG's labels, which no rename carries (rel.ts MetaSpec), so two
 * sub-queries one template builds alike, each proved over its own nodes, claim the same keys under different proofs.
 */
const claimedForm = (normal: DagTable): unknown => ({
	roots: normal.roots,
	nodes: Object.fromEntries(
		Object.entries(normal.nodes).map(([id, node]) => [
			id,
			{
				...digestedFields(node),
				meta: { ...node.meta, logicalKeys: node.meta.logicalKeys.map((k) => k.key) }
			}
		])
	),
	exprs: normal.exprs
})

/**
 * A node's own fields as its digest reads them: a Delta's without its keys, and a view Base's without the keys the
 * checker stamped on it, each its relation's, named already; an Attach's without the delivered type its template's
 * analysis judged, which no SQL reads (rel.ts Attach judged).
 */
const digestedFields = (node: TableNode): object => {
	if (node.kind === "Delta") {
		const { keys: _relations, ...digested } = node
		return digested
	}
	if (node.kind === "Attach") {
		const { judged: _judged, ...digested } = node
		return digested
	}
	if (node.kind === "Base" && node.relationKind !== "relation") {
		const { view: _views, ...digested } = node
		return digested
	}
	return node
}

/** The digest of the DAG `roots` reach within `context` (normalizeWithin): a sub-query's share key. */
export const dagDigestWithin = (
	context: RelDag,
	roots: Roots,
	domain: string
): Result.Result<DagDigest, CompileError> =>
	Result.flatMap(normalizeWithin(context, roots), (normal) =>
		Result.map(digest(domain, claimedForm(normal), { omit: omitSourceLocs }), DagDigest)
	)

/** The digest of a whole DAG. */
export const dagDigest = (dag: RelDag, domain: string): Result.Result<DagDigest, CompileError> =>
	dagDigestWithin(dag, dag.roots, domain)
