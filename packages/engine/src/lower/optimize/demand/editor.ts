import { Refusal } from "#compiler/core/canonical.ts"
import { ExprId, NodeId, OccurrenceId, type ParamId, ScopeId, VarId } from "#compiler/core/ids.ts"
import { cellFold, cellOrder, type FinishedCells, finishCells } from "#compiler/ir/dag.ts"
import {
	builtExpr,
	type ColumnRef,
	type ExprOf,
	type ExprSpec,
	exprClosure,
	type LiveArgs,
	mapArgs,
	type ScalarExpr,
	sameArgs
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
import { claimedColumns } from "#compiler/ir/keys.ts"
import {
	type Cell,
	type EditNode,
	type EditRefs,
	edgesOf,
	exprsOf,
	type Heading,
	type HeadingColumn,
	inputsOf,
	type KindOver,
	keptRefs,
	keptRowsOf,
	type MetaSpec,
	mapNode,
	type NodeOver,
	type RefKinds,
	type RelNode,
	type Roots,
	type ValidDag,
	type VarDecl
} from "#compiler/ir/rel.ts"

/** What one replaced column reference becomes: another expression of the same type. */
type ColumnRemap = (ref: ColumnRef, expr: ExprOf<"column">) => ScalarExpr | undefined

/**
 * The metadata of a node the rewrite cannot claim anything for beyond what it states: the evidence context of the node
 * it derives from, no key, cardinality many.
 */
export const derivedMeta = (from: MetaSpec): MetaSpec => ({
	logicalKeys: [],
	card: "many",
	context: from.context
})

/**
 * A node's metadata with its logical keys restricted to the columns of `heading`: a key of a set is a key of every
 * projection that retains it.
 */
export const restrictMeta = (meta: MetaSpec, heading: Heading): MetaSpec => {
	const names = new Set(heading.map((c) => c.name))
	return {
		logicalKeys: meta.logicalKeys.filter((k) => claimedColumns(k).every((c) => names.has(c))),
		card: meta.card,
		context: meta.context
	}
}

/**
 * A region heading widened by the variables it does not deliver yet, in the order given: a rewrite that must read a
 * region variable above the region (a semi-join's correlation, a membership predicate) reads it from the widened
 * region and restores the original heading with a projection, as fusion does with its hidden variables. A variable is
 * the heading column the region delivers for it.
 */
export const widenedHeading = (heading: Heading, vars: ReadonlyArray<VarDecl>): Heading => {
	const names = new Set(heading.map((c) => c.name))
	const extra: Array<HeadingColumn> = []
	for (const v of vars) {
		if (!names.has(v.name)) {
			names.add(v.name)
			extra.push({ name: v.name, type: v.type })
		}
	}
	return [...heading, ...extra]
}

/** The column references the expression trees `roots` make, in their closure's first-visit order (ir/expr.ts). */
export const columnRefs = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<ColumnRef> =>
	exprClosure(roots).flatMap((e) => (e.kind === "column" ? [e.column] : []))

/** The parameters the expression trees `roots` read. */
export const paramRefs = (roots: ReadonlyArray<ScalarExpr>): ReadonlyArray<ParamId> => [
	...new Set(exprClosure(roots).flatMap((e) => (e.kind === "param" ? [e.param] : [])))
]

/**
 * What a graph reader reads of a node whose data edges are `V`: an editor's cells, whose nodes are their current edit
 * forms, or a finished DAG's nodes themselves. Every other reference is a live one.
 */
export interface ReadRefs<V> extends RefKinds {
	readonly node: V
	readonly expr: ScalarExpr
	readonly var: VarDecl
	readonly meta: MetaSpec
}
export type ReadNode<V> = NodeOver<ReadRefs<V>>

/** A graph of direct references, read one way: each vertex's node and its label. */
export interface Graph<V> {
	readonly node: (vertex: V) => ReadNode<V>
	readonly label: (vertex: V) => NodeId
}

/** A finished DAG read node by node. */
export const nodeGraph: Graph<RelNode> = { node: (n) => n, label: (n) => n.id }

/** An editor's cells, each read as it stands now. */
export const cellGraph: Graph<Cell> = { node: (c) => c.current, label: (c) => c.id }

/** The vertices reachable from `root` through data inputs, `root` included, breadth first. */
export const subtreeOf = <V>(g: Graph<V>, root: V): ReadonlySet<V> => {
	const seen = new Set<V>([root])
	for (const v of seen) {
		for (const input of inputsOf(g.node(v))) {
			seen.add(input)
		}
	}
	return seen
}

/**
 * Whether some expression in the subtree `inside` reads a node outside it: the subtree is correlated with an enclosing
 * scope, and moving it would change what that reference names.
 */
export const readsOutside = <V>(g: Graph<V>, inside: ReadonlySet<V>): boolean => {
	const labels = new Set([...inside].map((v) => g.label(v)))
	for (const v of inside) {
		if (columnRefs(exprsOf(g.node(v))).some((r) => !labels.has(r.node))) {
			return true
		}
	}
	return false
}

/**
 * The vertices of a topological order `order` that lie on a recursive step: those that reach a SelfRef other than
 * through that SelfRef's own Recursive, which encloses the feedback. A Recursive is read through its base only.
 */
export const feedbackReadsOf = <V>(g: Graph<V>, order: ReadonlyArray<V>): ReadonlySet<V> => {
	const reads = new Set<V>()
	for (const v of order) {
		const node = g.node(v)
		const inputs = node.kind === "Recursive" ? [node.base] : inputsOf(node)
		if (node.kind === "SelfRef" || inputs.some((i) => reads.has(i))) {
			reads.add(v)
		}
	}
	return reads
}

/** Fresh identifiers of one kind: `prefix` and the next counter value no identifier taken so far spells. */
export class FreshIds {
	readonly #prefix: string
	readonly #taken: Set<string>
	#counter = 0

	constructor(prefix: string, taken: Iterable<string>) {
		this.#prefix = prefix
		this.#taken = new Set(taken)
	}

	/** Records an identifier as taken, so no fresh one spells it. */
	note(id: string): void {
		this.#taken.add(id)
	}

	take(): string {
		for (;;) {
			this.#counter += 1
			const id = `${this.#prefix}${this.#counter}`
			if (!this.#taken.has(id)) {
				this.#taken.add(id)
				return id
			}
		}
	}
}

/** The fresh identifiers an editor mints, one supply per kind of identifier. */
interface FreshSupplies {
	readonly node: FreshIds
	readonly expr: FreshIds
	readonly var: FreshIds
	readonly occ: FreshIds
	readonly scope: FreshIds
}

/** The copy of `e` with each column reference `remap` replaces, its argument copies first: `e` itself when none changes. */
function* copyStep(
	ed: DagEditor,
	remap: ColumnRemap,
	e: ScalarExpr
): Generator<ScalarExpr, ScalarExpr, ScalarExpr> {
	if (e.kind === "column") {
		return remap(e.column, e) ?? e
	}
	const spec = yield* mapArgs<LiveArgs, LiveArgs>(e)
	return sameArgs(e, spec) ? e : ed.expr(spec)
}

/**
 * The rewrite frame every relational rewrite edits the query DAG through.
 *
 * A rewrite never builds SQL: it replaces part of the owned DAG by an equivalent part, and the lowering that follows
 * sees only the result. The editor holds the DAG as cells (ir/rel.ts Cell), one per node, each with its label and its
 * current edit form, whose inputs are cells: a rewrite redefines a cell in place, and every reader holding the cell sees
 * the redefinition. It offers the few operations every rewrite needs:
 *
 * - fresh identifiers of every allocated kind that collide with nothing already present, and fresh column names
 *   within one heading;
 * - copy-on-write expression rewriting: an expression tree is copied with some column references replaced, and an
 *   expression no replacement touches is kept itself, so a tree shared by an untouched node is never changed; every
 *   expression is built over its arguments when it is made (ir/expr.ts builtExpr), so a copy's dependencies and effects
 *   are its new arguments';
 * - redirection, the one way a node is replaced by another of the same heading: every data input that reads the old
 *   cell, every column reference to it and every root move to the new one, except in the cells the caller excludes
 *   (the new cell itself, and the subtree of a region whose correlated sources read the old node's variables); a root
 *   moves in place, so the edited DAG has the roots of the DAG it edits, each where it moved, and a query's root stays
 *   first;
 * - correlation: whether a subtree's expressions read a node outside it, which is how a correlated source names an
 *   enclosing region or an earlier occurrence's source; demand analysis lists every node a scope expression reads
 *   (an occurrence's constant reading another occurrence's source included). A rewrite that would move a node out of
 *   the scope such a reference relies on refuses instead.
 *
 * `finish` folds the cells the roots still reach into nodes (ir/dag.ts finishCells), each built by the one constructor,
 * which computes its structural fields from what the edits left. A rewrite keeps every heading and scope promise the
 * DAG it edits holds, so the result is valid as that DAG was. A rewrite states only the rest of a node's metadata: no
 * record of what a node reads can outlive a rewrite that changes it. Node labels are kept as they are: certificates
 * name them, and dedup placement after the rewrites analyzes the same labels.
 *
 * It is not the catalog rewrites' editor (lower/shapes/catalog/edit.ts) because the two mint fresh identifiers apart:
 * this one mints `nw`, `ew`, `vw`, `ow` and `sw` labels, the catalog the allocated kinds' own prefixes, so for one DAG
 * they mint different labels.
 */
export class DagEditor<R extends Roots = Roots> {
	/** Every cell, in creation order: the base's, each after its inputs, then each one a rewrite added. */
	readonly #cells: Array<Cell> = []
	/** The cell of each node of the base, made when the editor starts. */
	readonly #cellOf: Fold<RelNode, Cell>
	/**
	 * Each root of the base a redirection moved, to the cell it stands at now; a root no redirection moved stands at its
	 * own cell.
	 */
	readonly #moved = new Map<RelNode, Cell>()
	readonly #fresh: FreshSupplies = {
		node: new FreshIds("nw", []),
		expr: new FreshIds("ew", []),
		var: new FreshIds("vw", []),
		occ: new FreshIds("ow", []),
		scope: new FreshIds("sw", [])
	}
	#version = 0
	/**
	 * The editor's analyses of its current cells, each made on its first read and dropped by the next change
	 * (#changed): the topological order, the cells reading a recursion's feedback, the discriminant spine, and each
	 * cell's subtree and whether it is correlated.
	 */
	#order: ReadonlyArray<Cell> | undefined
	#feedback: ReadonlySet<Cell> | undefined
	#spine: ReadonlySet<Cell> | undefined
	readonly #subtrees = new Map<Cell, ReadonlySet<Cell>>()
	readonly #correlated = new Map<Cell, boolean>()

	/** The DAG the editor started from. */
	readonly base: ValidDag<R>

	/** Bumped by every change, so analyses memoized over a snapshot know when they are stale. */
	get version(): number {
		return this.#version
	}

	constructor(dag: ValidDag<R>) {
		this.base = dag
		this.#cellOf = cellFold((cell) => {
			this.#cells.push(cell)
			this.#note(cell.id, cell.current)
		})
		for (const root of dag.roots) {
			this.#cellOf.of(root)
		}
		for (const e of exprClosure(this.#cells.flatMap((c) => exprsOf(c.current)))) {
			this.#fresh.expr.note(e.id)
		}
	}

	/** Records the labels a node holds as taken. */
	#note(id: NodeId, node: EditNode): void {
		this.#fresh.node.note(id)
		if (node.kind === "Base") {
			this.#fresh.occ.note(node.occurrence)
		}
		if (node.kind === "MatchRegion") {
			this.#fresh.scope.note(node.scope)
			for (const v of node.vars) {
				this.#fresh.var.note(v.id)
			}
			for (const o of node.occurrences) {
				this.#fresh.occ.note(o.id)
			}
		}
	}

	#rootCell(root: RelNode): Cell {
		return this.#moved.get(root) ?? this.#cellOf.of(root)
	}

	/**
	 * The cell a node of the base DAG became when the editor started, which rewrites may since have redefined in place:
	 * with `finished().node`, a node's counterpart in the edited DAG.
	 */
	cellOf(node: RelNode): Cell {
		return this.#cellOf.of(node)
	}

	/** The base's roots, each at the cell it stands at now. */
	get roots(): ReadonlyArray<Cell> {
		return this.base.roots.map((root) => this.#rootCell(root))
	}

	/** Whether a root stands at `cell`. */
	isRoot(cell: Cell): boolean {
		return this.base.roots.some((root) => this.#rootCell(root) === cell)
	}

	freshVar(): VarId {
		return VarId(this.#fresh.var.take())
	}

	freshOccurrence(): OccurrenceId {
		return OccurrenceId(this.#fresh.occ.take())
	}

	freshScope(): ScopeId {
		return ScopeId(this.#fresh.scope.take())
	}

	/** A column name of `base` not among `taken`, recorded as taken. */
	static freshName(taken: Set<string>, base: string): string {
		let name = base
		for (let i = 1; taken.has(name); i++) {
			name = `${base}_${i}`
		}
		taken.add(name)
		return name
	}

	/**
	 * The expression of `spec` under a fresh label, built over its arguments (ir/expr.ts builtExpr): its dependencies
	 * and effects, derived from its arguments', hold for as long as it lives. A new expression changes nothing until a
	 * node holds it, which bumps the version.
	 */
	expr(spec: ExprSpec): ScalarExpr {
		return builtExpr(spec, ExprId(this.#fresh.expr.take()))
	}

	/** A column reference to the column `col` of `cell`'s heading, typed as the heading says. */
	column(cell: Cell, col: HeadingColumn): ScalarExpr {
		return this.expr({
			kind: "column",
			column: { node: cell.id, name: col.name },
			args: [],
			type: col.type,
			nonNull: "storage"
		})
	}

	/** A new cell of `node` under a fresh label. */
	add(node: EditNode): Cell {
		const cell: Cell = { id: NodeId(this.#fresh.node.take()), current: node }
		this.#cells.push(cell)
		this.#note(cell.id, node)
		this.#changed()
		return cell
	}

	/** Redefines `cell` as `node` in place: every reader holding the cell reads the new node. */
	set(cell: Cell, node: EditNode): void {
		cell.current = node
		this.#note(cell.id, node)
		this.#changed()
	}

	/**
	 * The metadata a rewrite states for a restriction it adds over a node of metadata `meta`, a subset of its rows: every
	 * key of a set holds for each of its subsets, and a set of exactly one row may become empty.
	 */
	static subsetMeta(meta: MetaSpec): MetaSpec {
		return meta.card === "one" ? { ...meta, card: "atMostOne" } : meta
	}

	/** A stored relation scanned again under a fresh occurrence: its body and metadata kept, a new cell. */
	rescan(base: KindOver<"Base", EditRefs>): Cell {
		return this.add({ ...base, occurrence: this.freshOccurrence() })
	}

	/**
	 * The copier of expression trees under `remap`: `copier(remap).of(e)` is a copy of `e` with each column reference
	 * `remap` replaces, or `e` itself when nothing changes. One copier shares its memo across the trees of one node, so
	 * a subtree two of them share is copied once.
	 */
	copier(remap: ColumnRemap): Fold<ScalarExpr, ScalarExpr> {
		return new Fold<ScalarExpr, ScalarExpr>((e) => copyStep(this, remap, e))
	}

	/** A copy of the tree `e` with each column reference `remap` replaces, or `e` itself when nothing changes. */
	copyExpr(e: ScalarExpr, remap: ColumnRemap): ScalarExpr {
		return this.copier(remap).of(e)
	}

	/**
	 * A remap retargeting every column reference to `from` onto `to`'s column of the same name, keeping the reference's
	 * non-null proof.
	 */
	retarget(from: Cell, to: Cell): ColumnRemap {
		return (ref, expr) =>
			ref.node === from.id
				? this.expr({
						kind: "column",
						column: { node: to.id, name: ref.name },
						args: [],
						type: expr.type,
						nonNull: expr.nonNull
					})
				: undefined
	}

	/**
	 * Every cell the roots reach, in topological order, inputs first (ir/dag.ts cellOrder; a SelfRef's feedback is a
	 * name, not followed). The walk ends over any edges: a cycle a rewrite made is finish's refusal.
	 */
	topoOrder(): ReadonlyArray<Cell> {
		this.#order ??= cellOrder(this.roots)
		return this.#order
	}

	/**
	 * The readers of each cell through data inputs, one per input position, in topological order: the reachable cells
	 * that read it, a cell that reads it twice (a semi-join on both sides, a region matching it twice) listed twice, as
	 * the lowering emits it twice; none for a cell no reachable cell reads.
	 */
	readers(): (cell: Cell) => ReadonlyArray<Cell> {
		const out = new Map<Cell, Array<Cell>>()
		for (const cell of this.topoOrder()) {
			for (const input of edgesOf(cell.current)) {
				const known = out.get(input)
				if (known === undefined) {
					out.set(input, [cell])
				} else {
					known.push(cell)
				}
			}
		}
		return (cell) => out.get(cell) ?? []
	}

	/** How many references a cell has: its readers, one per input position (readers()), plus the roots at it. */
	refCount(cell: Cell, readers: (cell: Cell) => ReadonlyArray<Cell>): number {
		return readers(cell).length + this.roots.filter((r) => r === cell).length
	}

	/** The cells reachable from `cell` through data inputs, `cell` included. */
	subtree(cell: Cell): ReadonlySet<Cell> {
		const known = this.#subtrees.get(cell)
		if (known !== undefined) {
			return known
		}
		const made = subtreeOf(cellGraph, cell)
		this.#subtrees.set(cell, made)
		return made
	}

	/**
	 * Whether some expression in the subtree of `cell` reads a node outside that subtree: the subtree is correlated with
	 * an enclosing scope, and moving it would change what that reference names.
	 */
	correlated(cell: Cell): boolean {
		const known = this.#correlated.get(cell)
		if (known !== undefined) {
			return known
		}
		const made = readsOutside(cellGraph, this.subtree(cell))
		this.#correlated.set(cell, made)
		return made
	}

	/**
	 * Whether `cell` lies on a recursive step: it reaches a SelfRef other than through that SelfRef's own Recursive,
	 * which encloses the feedback. No rewrite touches the feedback region, whose single self-reference and complete state
	 * the recursive lowering owns. A Recursive itself is checked through its base only.
	 */
	readsFeedback(cell: Cell): boolean {
		this.#feedback ??= feedbackReadsOf(cellGraph, this.topoOrder())
		return this.#feedback.has(cell)
	}

	/**
	 * The cells a union's discriminant is read through: from each arm down the chain of nodes that keep their input's
	 * rows (rel.ts keptRowsOf) to the projection that binds the literal, the chain a valid DAG binds the literal through.
	 * Replacing one of them by a closed relation would hide the literal, so branch removal drops a vacuous arm from its
	 * union instead.
	 */
	discriminantSpine(): ReadonlySet<Cell> {
		this.#spine ??= this.#spineOf()
		return this.#spine
	}

	#spineOf(): ReadonlySet<Cell> {
		const spine = new Set<Cell>()
		/** An arm and every cell beneath it that keeps its input's rows. */
		const walk = (arm: Cell): void => {
			for (let at: Cell | undefined = arm; at !== undefined && !spine.has(at);) {
				spine.add(at)
				at = keptRowsOf(at.current)?.input
			}
		}
		for (const cell of this.topoOrder()) {
			const node = cell.current
			if (node.kind !== "Union" || node.discriminant.length === 0) {
				continue
			}
			for (const arm of node.groups.flatMap((g) => g.arms)) {
				walk(arm)
			}
		}
		return spine
	}

	/**
	 * Moves every reference to `from` onto `to`: data inputs, column references and roots, in every cell. The two must
	 * have the same heading.
	 */
	redirect(from: Cell, to: Cell): void {
		this.redirectExcept(from, to, new Set())
	}

	/** redirect, leaving the cells in `except` reading `from`. */
	redirectExcept(from: Cell, to: Cell, except: ReadonlySet<Cell>): void {
		const remap = this.retarget(from, to)
		for (const cell of this.#cells) {
			if (cell === to || except.has(cell)) {
				continue
			}
			const node = cell.current
			if (
				!edgesOf(node).includes(from) &&
				!columnRefs(exprsOf(node)).some((r) => r.node === from.id)
			) {
				continue
			}
			const copy = this.copier(remap)
			cell.current = drive(
				mapNode<EditRefs, EditRefs>(node, { ...keptRefs, expr: (e) => copy.of(e) }),
				(input) => (input === from ? to : input)
			)
		}
		for (const root of this.base.roots) {
			if (this.#rootCell(root) === from) {
				this.#moved.set(root, to)
			}
		}
		this.#changed()
	}

	/** A change: the version moves on, and every analysis of the cells before it is dropped. */
	#changed(): void {
		this.#version++
		this.#order = undefined
		this.#feedback = undefined
		this.#spine = undefined
		this.#subtrees.clear()
		this.#correlated.clear()
	}

	/**
	 * Places a new cell over `target`: `wrap` builds it over the target, and every reader of the target except the
	 * target's own subtree (whose correlated references stay with it) reads the new cell instead.
	 *
	 * Cells the wrapper chain added between target and top are in top's subtree; exclude them too.
	 */
	insertAbove(target: Cell, wrap: (target: Cell) => Cell): Cell {
		const top = wrap(target)
		const except = new Set(this.subtree(target))
		except.add(top)
		for (const c of this.subtree(top)) {
			except.add(c)
		}
		this.redirectExcept(target, top, except)
		return top
	}

	/**
	 * The DAG the cells the roots reach hold now, and each cell's node in it (ir/dag.ts finishCells): every structural
	 * field computed from what the edits left. A cycle a rewrite made through the cells is that rewrite's refusal.
	 */
	finished(): FinishedCells<R> {
		const done = finishCells(this.base.roots, (root) => this.#rootCell(root))
		if (!done.ok) {
			throw new Refusal(done.error)
		}
		return done.value
	}

	/** The DAG the cells the roots reach hold now (finished). */
	finish(): ValidDag<R> {
		return this.finished().dag
	}
}
