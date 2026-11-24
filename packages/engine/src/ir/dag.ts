import { appendAll, sameOrder } from "@bjornpagen/grizzle-text/base/array"
import { postorder } from "@bjornpagen/grizzle-text/base/graph"
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { mapNonEmpty, type NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { WellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { nominal } from "#compiler/core/brand.ts"
import {
	catchRefusal,
	maxStringLength,
	ownedText,
	withoutSourceLocs
} from "#compiler/core/canonical.ts"
import type { CompileError } from "#compiler/core/errors.ts"
import { digestCarrying } from "#compiler/core/fingerprint.ts"
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
import { deepFreeze } from "#compiler/core/record.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"
import { wellFormed } from "#compiler/core/text.ts"
import {
	DagDigests,
	type DagTemplates,
	digestedFields,
	numberReach,
	type TableOuterNames,
	ReachNumbering,
	tableExprOf
} from "#compiler/ir/dag-digest.ts"
import {
	builtExpr,
	type ExprSpec,
	type ExprSpecOver,
	exprClosure,
	type LiveArgs,
	mapArgs,
	outsideSpec,
	type ScalarExpr,
	sortedUnion,
	sortedUnique,
	type TableArgs,
	type TableExpr,
	type TypedLiteral,
	withArgs
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import {
	type Cell,
	closedCell,
	type DagTable,
	type EditNode,
	type EditRefs,
	edgesOf,
	exprsOf,
	fieldParams,
	type Heading,
	inputsOf,
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
	replacedEdges,
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
import { typeLabel } from "#compiler/ir/scalar.ts"
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
 * The one constructor of a node: `spec` labelled `id`, with its structural fields computed, frozen. Its parameters are
 * its own fields' (rel.ts fieldParams), its expressions' (each expression's dependencies are already its whole tree's)
 * and its inputs'; its stored reads are a Base's relation and its inputs'. Both are lexical: a SelfRef's feedback is a
 * name and is not followed, and a Recursive, whose base, step and SelfRef are its inputs, covers its region. Every
 * input is a node this constructor built, so its fields are final, and so are the new node's.
 */
export const relNode = (id: NodeId, spec: NodeSpec): RelNode => {
	const own = fieldParams(spec)
	let paramDeps: ReadonlyArray<ParamId> = own.length === 0 ? noIds : sortedUnique(own)
	for (const e of exprsOf(spec)) {
		paramDeps = sortedUnion(paramDeps, e.deps.params)
	}
	let reads: ReadonlyArray<string> = spec.kind === "Base" ? sortedUnique([spec.relation]) : noIds
	for (const input of edgesOf(spec)) {
		paramDeps = sortedUnion(paramDeps, input.meta.paramDeps)
		reads = sortedUnion(reads, input.meta.reads)
	}
	const meta: NodeMeta = {
		logicalKeys: spec.meta.logicalKeys,
		card: spec.meta.card,
		context: spec.meta.context,
		paramDeps,
		reads
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
 * `values.left` by role. Every other field is the node's own part itself, shared (rel.ts replacedEdges): a reading, and
 * a rebuild of the node from it, allocates only the containers its edges stand in.
 */
export function* edgeValues<A>(node: RelNode): Generator<RelNode, NodeOver<ValueRefs<A>>, A> {
	return yield* replacedEdges<LiveRefs, A>(node)
}

/** Whether a rebuilt reading of `node` (edgeValues over a rebuild) holds the node's own inputs, edge for edge. */
export const unchangedEdges = (
	node: RelNode,
	rebuilt: NodeOver<ValueRefs<RelNode>> | NodeSpec
): boolean => {
	return sameOrder(edgesOf(node), edgesOf(rebuilt))
}

/**
 * The nodes the roots reach through data edges, in topological order: every node after its inputs, depth-first from
 * each root in order and through each node's distinct inputs in structural order (postorder over rel.ts edgesOf, whose
 * repeats the walk meets seen, so it walks each node's distinct inputs as inputsOf lists them, building no list of
 * them), each node once. A SelfRef's feedback is a name, not followed.
 */
export const topoOrder = (dag: RelDag): ReadonlyArray<RelNode> =>
	postorder(dag.roots, (node) => edgesOf(node))

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
 * The headings of the heading groups of the rows `node` delivers, in group order: a union of several groups', where its
 * delivery spine ends at one (deliverySpine), each group a statement of its own; else its own heading.
 */
export const groupHeadings = (node: RelNode): NonEmptyReadonlyArray<Heading> => {
	const union = deliverySpine(node).arms?.union
	return union !== undefined && union.groups.length > 1
		? mapNonEmpty(union.groups, (g) => g.heading)
		: [node.heading]
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
}

const noRefs: OuterRefs = new Map()

const noNodes: ReadonlyArray<NodeId> = Object.freeze([])

/**
 * The scope of a node that reads no column from outside it: a source, or a node that binds every reference below it.
 */
const closed: NodeScope = Object.freeze({ outer: noRefs })

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
		case "Call":
			return { exprs: scopeExprs(node), over: [], perRow: [] }
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
		case "Step":
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

/**
 * A scope's free variables, sorted: the variables its outer references name, a region's columns by their names, read
 * through the DAG's labels (nodesByLabel), where a label no region holds names none.
 */
export const freeVars = (
	index: ReadonlyMap<NodeId, RelNode>,
	scope: NodeScope
): ReadonlyArray<VarId> => {
	const vars: Array<VarId> = []
	for (const [id, columns] of scope.outer) {
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
		return own.size === 0 ? closed : { outer: own }
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
				const held = outer.getOrInsertComputed(id, () => new Set<string>())
				for (const column of columns) {
					held.add(column)
				}
			}
		}
	}
	add(own, noNodes)
	for (const c of carried) {
		add(c.scope.outer, c.rows)
	}
	return outer.size === 0 ? closed : { outer }
}

/**
 * The scope of every node, each computed from its inputs' (a fold): `nodeScopes().of(node)`. A node's scope is a
 * function of the node and the nodes it reaches alone, so one fold serves every root of any DAG, and reads no label of
 * the DAG: a lowering of one root of a DAG of many walks only the nodes that root reaches. A root's is closed in a valid
 * DAG: its statement is lowered with nothing in scope. Logical analysis reads a lateral source's outer references from
 * it; a node whose scope has free variables (freeVars) reads an enclosing region per row.
 *
 * The scope of a node: the columns of other nodes its evaluation reads.
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
 * which only a reader of free variables builds (freeVars).
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
export const nodeScopes = (): Fold<RelNode, NodeScope> => scopesOver(() => undefined)

/**
 * The scope of every node as nodeScopes folds it, but for the nodes whose scope a caller already holds (`recorded`): the
 * fold reads such a node's scope as it is, and none of its inputs. A scope is a function of the node and the nodes it
 * reaches alone, so a scope recorded of one fold is the scope of the node in every other.
 */
export const scopesOver = (
	recorded: (node: RelNode) => NodeScope | undefined
): Fold<RelNode, NodeScope> =>
	new Fold<RelNode, NodeScope>(function* (node) {
		const known = recorded(node)
		if (known !== undefined) {
			return known
		}
		const inputs: Array<{ readonly input: RelNode; readonly scope: NodeScope }> = []
		for (const input of inputsOf(node)) {
			const scope: NodeScope = yield input
			inputs.push({ input, scope })
		}
		return scopeOf(node, inputs)
	})

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
		const edges = yield* replacedEdges<LiveRefs, Cell>(node)
		const current: EditNode = { ...edges, meta: metaSpecOf(edges.meta) }
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

/** What a finish folded a cell into: the edit form the cell held, and the node the one constructor built of it. */
export interface FoldedCell {
	readonly current: EditNode
	readonly node: RelNode
}

/** What an editor's cells hold now: the DAG, and the node each cell stands as in it. */
export interface FinishedCells<R extends Roots> {
	readonly dag: ValidDag<R>
	/** Each cell this finish folded, what it folded it into: the next finish's `previous` (finishCells). */
	readonly folded: ReadonlyMap<Cell, FoldedCell>
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
 *
 * The one constructor's node is a function of its label, its form and its inputs' nodes, so a cell that holds the edit
 * form it held at the editor's previous finish (`previous`, that finish's `folded`), over inputs folded into the very
 * nodes they were then, is that finish's node again, the same value: a rewrite's edit rebuilds the cells it redefined
 * and the cells above them alone, and a reader keyed by node (an analysis's fold) reads every other node of the new DAG
 * as it read it in the old.
 */
export const finishCells = <R extends Roots>(
	roots: R,
	cellOf: (root: RelNode) => Cell,
	previous: ReadonlyMap<Cell, FoldedCell>
): Result.Result<FinishedCells<R>, CompileError> => {
	const cycle = cellCycle(roots.map((root) => cellOf(root)))
	if (cycle !== undefined) {
		return Result.err(
			malformed(["nodes", cycle.id], "an acyclic DAG: the node reaches itself through its inputs")
		)
	}
	const folded = new Map<Cell, FoldedCell>()
	const built = new Fold<Cell, RelNode>(function* (cell) {
		const current = cell.current
		const spec: NodeSpec = yield* replacedEdges<EditRefs, RelNode>(current)
		const before = previous.get(cell)
		const node =
			before?.current === current && unchangedEdges(before.node, spec)
				? before.node
				: relNode(cell.id, spec)
		folded.set(cell, { current, node })
		return node
	})
	const dag = assembledDag(mapRoots(roots, (root) => built.of(cellOf(root))))
	return Result.ok({ dag, folded, node: (cell) => built.of(cell) })
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
 * A node `kept` gives a stand-in for is that stand-in, a node of the base kept as it is, and every name of it the
 * stand-in's: a closed sub-query the base already holds (write/frontend/dag.ts QueryMerger), whose own nodes nothing
 * outside it names.
 */
const renamedPast = (
	tops: Record<AllocatedKind, number>,
	extension: ValidDag,
	kept: (node: RelNode) => RelNode | undefined
): Renamed => {
	const standIns = new Map<string, NodeId>()
	for (const node of topoOrder(extension)) {
		const standIn = kept(node)
		if (standIn !== undefined) {
			standIns.set(node.id, standIn.id)
		}
	}
	const fresh = <A extends string>(
		kind: AllocatedKind,
		make: (s: string) => A,
		seeds: ReadonlyMap<string, A>
	) => {
		const seen = new Map<string, A>(seeds)
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
	const nodeName = fresh("node", NodeId, standIns)
	const exprName = fresh("expr", ExprId, new Map<string, ExprId>())
	const varName = fresh("var", VarId, new Map<string, VarId>())
	const occurrence = fresh("occurrence", OccurrenceId, new Map<string, OccurrenceId>())
	const scope = fresh("scope", ScopeId, new Map<string, ScopeId>())
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
		const standIn = kept(node)
		if (standIn !== undefined) {
			return standIn
		}
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
 * so the two share none, its roots after the base's, but each extension node `kept` stands a node of the base in for,
 * which is that node. The base's nodes are kept as they are. The merge of two valid DAGs is valid, so long as each
 * stand-in reads the rows of the node it stands in for and names nothing of the extension. `node` and `expr` read the
 * counterpart of any node or expression of the extension.
 */
export const mergeDags = (
	base: LabelledDag,
	extension: ValidDag,
	kept: (node: RelNode) => RelNode | undefined
): MergedDag => {
	const tops = { ...base.tops }
	const renamed = renamedPast(tops, extension, kept)
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
		const root = renamedPast(this.#tops, query, () => undefined).node(violation)
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
): Result.Result<DagTable, CompileError> => normalizeReach(context, roots, "followed")

/**
 * normalizeWithin, every name of a node outside the roots' reach read as `outer` says (ir/dag-digest.ts
 * TableOuterNames): numbered by the one numbering of a normal form (ReachNumbering, numberReach), each node and
 * expression restated with the names it holds as it is read.
 */
export const normalizeReach = (
	context: RelDag,
	roots: Roots,
	outer: TableOuterNames
): Result.Result<DagTable, CompileError> =>
	catchRefusal(() => {
		/** The context's labels, read only when a name the walk has not met needs its node. */
		let index: ReadonlyMap<NodeId, RelNode> | undefined
		const labels = (): ReadonlyMap<NodeId, RelNode> => {
			const known = index ?? nodesByLabel(context)
			index = known
			return known
		}
		const numbering = new ReachNumbering(labels, roots, outer)
		const named: RefMap<LiveRefs, TableRefs> = {
			expr: (expr) => numbering.exprs.nameOf(numbering.expr(expr)),
			var: (ref) => numbering.vars.name(ref.id),
			decl: (d) => ({ ...d, id: numbering.vars.name(d.id) }),
			occurrence: (id) => numbering.occurrences.name(id),
			scope: (id) => numbering.scopes.name(id),
			name: (id) => numbering.labelName(id),
			meta: (meta) => meta
		}
		const nodes: Record<NodeId, TableNode> = {}
		const pending: Array<{
			readonly expr: ScalarExpr
			readonly id: ExprId
			readonly spec: ExprSpecOver<TableArgs>
		}> = []
		const tableRoots = numberReach(numbering, roots, (met) => {
			if (met.kind === "node") {
				const id = numbering.nodes.name(met.node.id)
				const entry = drive(mapNode<LiveRefs, TableRefs>(met.node, named), (node) =>
					numbering.nodes.nameOf(numbering.edge(node))
				)
				nodes[id] = { ...entry, id }
				return
			}
			const expr = met.expr
			const args = withArgs<LiveArgs, TableArgs>(outsideSpec(expr), named.expr)
			const id = numbering.exprs.name(expr.id)
			const spec: ExprSpecOver<TableArgs> =
				args.kind === "column"
					? {
							...args,
							column: { node: numbering.labelName(args.column.node), name: args.column.name }
						}
					: args
			pending.push({ expr, id, spec })
		}).map((root) => numbering.nodes.nameOf(root))
		const exprs: Record<ExprId, TableExpr> = {}
		for (const { expr, id, spec } of pending) {
			exprs[id] = tableExprOf(expr, spec, id, numbering.deps(expr))
		}
		return deepFreeze({ roots: tableRoots, nodes, exprs })
	})

/**
 * The semantic fingerprint of a DAG: SHA-256 over its normalized canonical text, source locations excluded. Two DAGs
 * of one domain that differ only in allocation order and the proofs of their claimed keys have one digest, but for
 * their calls of a volatile function, each its own evaluation, which the text names by its label (ir/dag-digest.ts
 * callsVolatile).
 */
type DagDigest = string & { readonly [dagDigestBrand]: true }
declare const dagDigestBrand: unique symbol
const DagDigest = nominal<string, DagDigest>()

/**
 * Each node's shape, a fold over the DAG: SHA-256 of its kind, its heading's columns and their types, and, per input
 * edge in order, that input's shape. A shape is a function of exactly what a node's share or evaluation key encodes
 * (ir/dag-digest.ts DagDigests): two nodes whose normalized reaches are one are of one kind and heading, their
 * edges in one order to inputs whose reaches are one, so equal keys have equal shapes, and a node whose shape no other
 * node has has a key no other node has, which no comparison need digest (lower/shapes/share/statements.ts ShareIndex,
 * lower/conservative/call/index.ts EvaluationKeys). The converse fails, a shape reading no expression, label or
 * claim, and two nodes of one shape are told apart by their keys alone. Each node's shape is computed once, from its
 * inputs': linear in the DAG, where a key normalizes and encodes the whole reach of its node.
 */
export const nodeShapes = (): Fold<RelNode, string> =>
	new Fold<RelNode, string>(function* (node) {
		let text = `${node.kind}\u0000${node.heading.map((c) => `${c.name}:${typeLabel(c.type)}`).join(",")}`
		for (const input of edgesOf(node)) {
			const shape: string = yield input
			text += `\u0000${shape}`
		}
		return sha256Hex(wellFormed(text))
	})

/** The digest of a whole DAG (normalizeWithin), every template read from `templates`. */
export const dagDigest = (
	dag: RelDag,
	domain: string,
	templates: DagTemplates
): Result.Result<DagDigest, CompileError> =>
	Result.map(
		new DagDigests(() => nodesByLabel(dag), maxStringLength, templates).digest(
			dag.roots,
			domain,
			"followed"
		),
		DagDigest
	)

/**
 * A closed relation's facts as a meaning digest reads them (closedReadFacts): its theory handle, whose primary fields
 * are its key in key order; its heading, the key fields in key order, then its payload; and its rows in that heading's
 * order, as a Closed node holds the facts it scans. An installation's checked schema holds each closed relation so
 * (check/schema.ts ClosedRelation), by its declared name.
 */
export interface ClosedFacts {
	readonly relation: { readonly primaryFields: NonEmptyReadonlyArray<{ readonly name: string }> }
	readonly heading: Heading
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}

/**
 * The facts of the closed relation `relation` in `closedFacts` a closed read reads: its rows projected on its key fields
 * and the payload fields `payload`, in heading order, since C.has and C.row read its key set alone and C.at, at each
 * key, the one payload field it names.
 */
const closedReadFacts = (
	closedFacts: ReadonlyMap<string, ClosedFacts>,
	relation: string,
	payload: ReadonlyArray<string>
): { readonly heading: Heading; readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>> } => {
	const facts = closedFacts.get(relation)
	if (facts === undefined) {
		throw defect(`the installation holds the closed relation ${relation} a closed read names`)
	}
	const key = new Set(facts.relation.primaryFields.map((f) => f.name))
	const read = facts.heading.flatMap((column, position) =>
		key.has(column.name) || payload.includes(column.name) ? [{ column, position }] : []
	)
	return {
		heading: read.map((r) => r.column),
		rows: facts.rows.map((row) => read.map((r) => closedCell(row, r.position)))
	}
}

/**
 * The closed facts the meaning digests of one caller's DAGs read (statedForm): each closed read's facts
 * (closedReadFacts) projected once for the caller, by its relation and payload, and frozen, with its canonical text
 * written once (core/canonical.ts ownedText, under the digests' options, withoutSourceLocs), which every digest of the
 * caller writes where the facts stand (core/fingerprint.ts digestCarrying) rather than reading them again. One per
 * caller's loop over its DAGs, over the installation's closed facts: its law checks (deploy/snapshot/violation.ts
 * lawChecks, baselineRuleChecks) and its derived definitions' meanings (physical/derived/meaning.ts
 * definitionMeanings), so a closed relation every law reads is projected and spelled once for all of them, where each
 * closed read of each law projected its rows again and each digest read them again.
 */
export class StatedFacts {
	readonly #closed: ReadonlyMap<string, ClosedFacts>
	/** Each closed read's facts, by its relation and payload, the pair's JSON text. */
	readonly #reads = new Map<string, object>()
	/** Each closed read's facts' canonical text, by the facts. */
	readonly #texts = new Map<object, WellFormedText>()

	constructor(facts: ReadonlyMap<string, ClosedFacts>) {
		this.#closed = facts
	}

	/** The facts a closed read of `relation` naming the payload fields `payload` reads (closedReadFacts), once. */
	read(relation: string, payload: ReadonlyArray<string>): object {
		const key = JSON.stringify([relation, payload])
		const known = this.#reads.get(key)
		if (known !== undefined) {
			return known
		}
		const facts = frozenFacts(closedReadFacts(this.#closed, relation, payload))
		this.#reads.set(key, facts)
		this.#texts.set(facts, ownedText(facts, withoutSourceLocs))
		return facts
	}

	/** Each closed read's facts' canonical text, by the facts: what a digest writes where they stand. */
	get texts(): ReadonlyMap<object, WellFormedText> {
		return this.#texts
	}

	/** How many closed reads' facts this caller projected: its work, one for each relation and payload it read. */
	get projected(): number {
		return this.#reads.size
	}
}

/** A closed read's facts (closedReadFacts) with their own containers frozen: their record, heading and rows. */
const frozenFacts = (facts: {
	readonly heading: Heading
	readonly rows: ReadonlyArray<ReadonlyArray<TypedLiteral>>
}): object =>
	Object.freeze({
		heading: Object.freeze([...facts.heading]),
		rows: Object.freeze(facts.rows.map((row) => Object.freeze([...row])))
	})

/**
 * An expression of a normal DAG as a meaning digest reads it (statedForm): a closed read (C.at, C.has, C.row) with the
 * facts it reads (StatedFacts read), since it names its closed relation and none of its facts, which the installation's
 * constants hold apart from the DAG, as a Closed node holds the facts it scans; every other kind as the DAG holds it, so
 * a DAG of no closed read is stated as it is.
 */
const statedExpr = (e: TableExpr, stated: StatedFacts): object => {
	switch (e.kind) {
		case "closedAt":
			return { ...e, facts: stated.read(e.relation, [e.field]) }
		case "closedHas":
		case "closedRow":
			return { ...e, facts: stated.read(e.relation, []) }
		case "column":
		case "value":
		case "param":
		case "literal":
		case "op":
		case "cast":
		case "domainCast":
		case "cond":
		case "call":
			return e
	}
}

/**
 * What a normal DAG states, as a meaning digest reads it: each node's own fields (digestedFields) with the metadata an
 * analysis derives, its keys, cardinality and evidence context, the conservative metadata that claims none
 * (rel.ts conservativeMeta), since an improvement of the analysis changes them and not what the DAG asks; its
 * structural fields, which its own fields and its inputs' make (dag.ts relNode), kept; and each expression with the
 * closed facts it reads (statedExpr), so a closed relation's changed rows are a new meaning of every DAG that reads them.
 */
const statedForm = (
	normal: DagTable,
	fields: (node: TableNode) => object,
	stated: StatedFacts
): unknown => ({
	roots: normal.roots,
	nodes: Object.fromEntries(
		Object.entries(normal.nodes).map(([id, node]) => [
			id,
			fields({ ...node, meta: { ...node.meta, ...conservativeMeta } })
		])
	),
	exprs: Object.fromEntries(
		Object.entries(normal.exprs).map(([id, e]) => [id, statedExpr(e, stated)])
	)
})

/**
 * A node as the rows it yields read it (rowsDigestWithin): a stored relation's scan without the keys its relation's laws
 * declare beside its primary key and its generated fields' reads, and a view's scan without the keys it is read by, which
 * its definition's keys restate.
 * A key is a law its relation's rows obey, never a row they hold, so a key a relation gains or loses yields no other row.
 */
const rowsFields = (node: TableNode): object => {
	if (node.kind !== "Base") {
		return digestedFields(node)
	}
	if (node.relationKind === "relation") {
		const { keys: _keys, generated: _generated, ...rows } = node
		return rows
	}
	const { keys: _keys, view: _views, primaryKey: _primaryKey, ...rows } = node
	return rows
}

/**
 * The digest of what the DAG `roots` reach within `context` asks of the rows it reads (statedForm), the closed facts its
 * closed reads read among them, each read once for the caller (`stated`), allocation, source locations and derived
 * metadata excluded: one query's whatever lowers, rewrites or analyzes it, the identity of a law's check
 * (deploy/snapshot/violation.ts checkOf).
 */
export const meaningDigestWithin = (
	context: RelDag,
	roots: Roots,
	domain: string,
	stated: StatedFacts
): Result.Result<DagDigest, CompileError> =>
	Result.flatMap(normalizeWithin(context, roots), (normal) =>
		Result.map(
			digestCarrying(
				domain,
				statedForm(normal, digestedFields, stated),
				withoutSourceLocs,
				stated.texts
			),
			DagDigest
		)
	)

/**
 * The digest of the rows the DAG `roots` reach within `context` yields (meaningDigestWithin, every scan's keys erased,
 * rowsFields): one stored table's whatever lowers it and whatever keys the relations it reads declare, the
 * identity of a derived relation's view (physical/derived/meaning.ts definitionMeanings), whose keys are indexes of
 * their own.
 */
export const rowsDigestWithin = (
	context: RelDag,
	roots: Roots,
	domain: string,
	stated: StatedFacts
): Result.Result<DagDigest, CompileError> =>
	Result.flatMap(normalizeWithin(context, roots), (normal) =>
		Result.map(
			digestCarrying(
				domain,
				statedForm(normal, rowsFields, stated),
				withoutSourceLocs,
				stated.texts
			),
			DagDigest
		)
	)
