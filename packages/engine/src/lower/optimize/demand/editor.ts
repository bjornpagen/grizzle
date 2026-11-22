import { defined, invariant } from "@bjornpagen/grizzle-text/base/invariant"
import { unwrap } from "#compiler/core/canonical.ts"
import { ExprId, NodeId, OccurrenceId, type ParamId, ScopeId, VarId } from "#compiler/core/ids.ts"
import { cellTable, type FinishedCells, type FoldedCell, finishCells } from "#compiler/ir/dag.ts"
import {
	builtExpr,
	type ColumnRef,
	exprClosure,
	type ExprOf,
	type ExprSpec,
	type LiveArgs,
	mapArgs,
	sameArgs,
	type ScalarExpr,
	storedColumn
} from "#compiler/ir/expr.ts"
import { drive, Fold } from "#compiler/ir/fold.ts"
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
	scopeLabels,
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
		logicalKeys: meta.logicalKeys.filter((k) => k.key.every((c) => names.has(c))),
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
		if (exprsOf(g.node(v)).some((e) => e.deps.nodes.some((node) => !labels.has(node)))) {
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
		if (readsFeedback(node, edgesOf(node), reads)) {
			reads.add(v)
		}
	}
	return reads
}

/**
 * Whether a vertex whose node is `node`, its data edges `edges`, lies on a recursive step, its inputs' already known
 * (`reads`): a SelfRef, or a vertex an input of which lies on one, a Recursive's input its base alone.
 */
const readsFeedback = <V>(
	node: ReadNode<V>,
	edges: ReadonlyArray<V>,
	reads: ReadonlySet<V>
): boolean =>
	node.kind === "SelfRef" ||
	(node.kind === "Recursive" ? reads.has(node.base) : edges.some((i) => reads.has(i)))

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

/**
 * The cells that read each cell, kept as every cell's node changes (DagEditor #readers): through a data edge, by the
 * cell read, and through a column reference an expression of the node makes, by the label it names. Every cell the
 * editor holds is in it, those no root reaches any more included, under its creation index, which orders them.
 */
class Readers {
	readonly #byEdge = new Map<Cell, Set<Cell>>()
	readonly #byColumn = new Map<NodeId, Set<Cell>>()
	readonly #created = new Map<Cell, number>()

	/** `cell`, created now, reading what its node reads. */
	created(cell: Cell): void {
		this.#created.set(cell, this.#created.size)
		this.#reads(cell.current, (readers) => readers.add(cell))
	}

	/** `cell`, whose node was `before`, reading what its node reads now instead. */
	changed(cell: Cell, before: EditNode): void {
		this.#reads(before, (readers) => readers.delete(cell))
		this.#reads(cell.current, (readers) => readers.add(cell))
	}

	/** Every cell whose node reads `cell`, through a data edge or a column reference, in creation order. */
	of(cell: Cell): ReadonlyArray<Cell> {
		const readers = new Set([
			...(this.#byEdge.get(cell) ?? []),
			...(this.#byColumn.get(cell.id) ?? [])
		])
		return [...readers].toSorted((a, b) => this.#index(a) - this.#index(b))
	}

	#index(cell: Cell): number {
		return defined(this.#created.get(cell), "a cell the editor holds")
	}

	/** Each reader set a cell whose node is `node` belongs in, given to `visit`. */
	#reads(node: EditNode, visit: (readers: Set<Cell>) => void): void {
		for (const input of edgesOf(node)) {
			visit(this.#byEdge.getOrInsertComputed(input, () => new Set()))
		}
		for (const e of exprsOf(node)) {
			for (const read of e.deps.nodes) {
				visit(this.#byColumn.getOrInsertComputed(read, () => new Set()))
			}
		}
	}
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
/**
 * One state of an editor's cells as a graph: the cells the roots reach, in topological order, those of them that read a
 * recursion's feedback, and how each is read (analysis/demand Structure: its references and whether a scope expression
 * reads it), which is what a rewrite asks of a cell to know it may change its set. A reader of that state reads it from
 * the one value its driver computed for it.
 */
export interface CellState {
	readonly order: ReadonlyArray<Cell>
	readonly feedback: ReadonlySet<Cell>
	/** How many references a cell has: one per input position that names it, plus the roots at it. */
	readonly references: (cell: Cell) => number
	/**
	 * Whether a scope expression reads a column of the cell: a correlated source, or a constant of a region the cell is
	 * an occurrence's source of, names it, so moving or replacing it would change what that reference names.
	 */
	readonly lateral: (cell: Cell) => boolean
	/**
	 * The readers of each cell through data inputs, one per input position (DagEditor.readersIn), worked out once for the
	 * state the first time a rule asks, so a rule asking at every cell reads the one map.
	 */
	readonly readers: (cell: Cell) => ReadonlyArray<Cell>
	/**
	 * The editor's version at which a cell's subtree last changed: the latest change of the node of the cell or of a cell
	 * it reaches through data inputs (DagEditor #changedAt), worked out over the state's cells the first time a reader
	 * asks, so what a reader keeps of a cell at a version stands while the cell's stamp is no later.
	 */
	readonly stamp: (cell: Cell) => number
	/** The editor's version at which the cell's node was last set (DagEditor #changedAt), 0 for a cell of the base. */
	readonly set: (cell: Cell) => number
	/**
	 * The latest version at which a count of the cell's reach moved, its references or how many scope expressions name
	 * it (Reach), 0 if none moved since the base. Both read the editor as it stands, so a reader that asks after a later
	 * edit reads a later version, which only says more has changed.
	 */
	readonly moved: (cell: Cell) => number
}

/** What a node of a cell reads: its data edges, one per input position, and the labels its scope expressions name. */
interface NodeShape {
	readonly edges: ReadonlyArray<Cell>
	readonly lateral: ReadonlyArray<NodeId>
}

/** What `node` reads (NodeShape). */
const nodeShape = (node: EditNode): NodeShape => ({
	edges: edgesOf(node),
	lateral: scopeLabels(node)
})

/**
 * What an editor keeps of a cell (DagEditor #entries): the node it held when last read and what that node reads, and the
 * number of the last walk of the cells that reached it (DagEditor #walk), which marks it reached in that walk.
 */
interface CellEntry {
	node: EditNode
	shape: NodeShape
	walked: number
}

/**
 * What moved in the reach (Reach) while a state of the cells was the newest one taken: each count a change moved, at its
 * value before the first such change, and the epoch of the next state taken after a change. A state reads a count from
 * the first epoch from its own on that holds it, else as the count is now: as it was when the state was taken.
 */
interface Epoch {
	readonly references: Map<Cell, number>
	readonly named: Map<NodeId, number>
	next: Epoch | undefined
}

/**
 * How the cells the roots reach are read, kept as the editor changes them (CellState references and lateral, which
 * analysis/demand structureOf works out of a finished DAG): each reached cell's references, one per input position of a
 * reached cell that names it plus each root standing at it, and how many times the scope expressions of reached cells
 * name each label. A cell is reached while it has a reference: its first brings its own edges and names into the
 * counts, its last takes them out, so a change costs the edges it moves and those of the cells it brings into reach or
 * takes out of it, never the cells. A state reads the counts as they were when it was taken (Epoch).
 */
class Reach {
	readonly #references = new Map<Cell, number>()
	readonly #named = new Map<NodeId, number>()
	/** What a cell's node reads now. */
	readonly #shape: (cell: Cell) => NodeShape
	/** The newest state's epoch, which every change records what it moves in. */
	#epoch: Epoch | undefined
	/** The cells whose references, and the labels whose counts of scope names, the change under way moved. */
	#movedReferences = new Set<Cell>()
	#movedNamed = new Set<NodeId>()

	constructor(shape: (cell: Cell) => NodeShape, roots: ReadonlyArray<Cell>) {
		this.#shape = shape
		for (const root of roots) {
			this.reached(root, 1)
		}
		this.drainMoved()
	}

	/** What the change under way moved (#movedReferences, #movedNamed), the next change's starting from none. */
	drainMoved(): { readonly references: ReadonlySet<Cell>; readonly named: ReadonlySet<NodeId> } {
		const moved = { references: this.#movedReferences, named: this.#movedNamed }
		this.#movedReferences = new Set()
		this.#movedNamed = new Set()
		return moved
	}

	/** The cells' references and lateral reads as they are now, read so by a state taken now whatever changes after. */
	taken(): Pick<CellState, "references" | "lateral"> {
		const epoch = this.#open()
		return {
			references: (cell) =>
				Reach.#at(epoch, (e) => e.references, cell) ?? this.#references.get(cell) ?? 0,
			lateral: (cell) =>
				(Reach.#at(epoch, (e) => e.named, cell.id) ?? this.#named.get(cell.id) ?? 0) > 0
		}
	}

	/** The newest epoch where nothing moved in it yet, which a state taken now shares, else a new one after it. */
	#open(): Epoch {
		const open = this.#epoch
		if (open?.references.size === 0 && open.named.size === 0) {
			return open
		}
		const epoch: Epoch = { references: new Map(), named: new Map(), next: undefined }
		if (open !== undefined) {
			open.next = epoch
		}
		this.#epoch = epoch
		return epoch
	}

	/** A count as the state of `from` reads it: the first epoch's from it on that recorded it, none if none did. */
	static #at<K>(from: Epoch, log: (e: Epoch) => Map<K, number>, key: K): number | undefined {
		for (let e: Epoch | undefined = from; e !== undefined; e = e.next) {
			const was = log(e).get(key)
			if (was !== undefined) {
				return was
			}
		}
		return undefined
	}

	/**
	 * `counts`' count of `key` moved by `by`, its value before recorded in the newest epoch and the key among what the
	 * change under way moved (`moved`): its value now.
	 */
	#move<K>(
		counts: Map<K, number>,
		log: (e: Epoch) => Map<K, number>,
		moved: Set<K>,
		key: K,
		by: 1 | -1
	): number {
		moved.add(key)
		const was = counts.get(key) ?? 0
		const epoch = this.#epoch
		if (epoch !== undefined && !log(epoch).has(key)) {
			log(epoch).set(key, was)
		}
		const now = was + by
		if (now === 0) {
			counts.delete(key)
		} else {
			counts.set(key, now)
		}
		return now
	}

	/**
	 * A reference to `cell` added (`by` 1) or taken away (-1): a root moved, or an input position of a reached cell. A
	 * cell it brings into reach, or takes out of it, brings or takes its own edges and names with it, each a step.
	 */
	reached(cell: Cell, by: 1 | -1): void {
		const steps = [cell]
		for (let at = steps.pop(); at !== undefined; at = steps.pop()) {
			if (!this.#reachStep(at, by)) {
				continue
			}
			const shape = this.#shape(at)
			for (const label of shape.lateral) {
				this.#move(this.#named, (e) => e.named, this.#movedNamed, label, by)
			}
			for (const input of shape.edges) {
				steps.push(input)
			}
		}
	}

	/** One reference to `cell` moved by `by`: whether it came into reach or left it. */
	#reachStep(cell: Cell, by: 1 | -1): boolean {
		const now = this.#move(this.#references, (e) => e.references, this.#movedReferences, cell, by)
		return by === 1 ? now === 1 : now === 0
	}

	/** `cell`, whose node read `before`, reading `after` now: a reached cell's edges and names move to its new node's. */
	changed(cell: Cell, before: NodeShape, after: NodeShape): void {
		if (!this.#references.has(cell)) {
			return
		}
		for (const label of after.lateral) {
			this.#move(this.#named, (e) => e.named, this.#movedNamed, label, 1)
		}
		for (const input of after.edges) {
			this.reached(input, 1)
		}
		for (const label of before.lateral) {
			this.#move(this.#named, (e) => e.named, this.#movedNamed, label, -1)
		}
		for (const input of before.edges) {
			this.reached(input, -1)
		}
	}
}

export class DagEditor<R extends Roots = Roots> {
	/**
	 * The cells that read each cell, kept as each cell's node changes: what a redirection rewrites (Readers). It holds
	 * every cell in creation order: the base's, each after its inputs, then each one a rewrite added.
	 */
	readonly #readers = new Readers()
	/**
	 * What the editor keeps of each cell it has read (CellEntry): what its node reads, while the cell holds that node, and
	 * the last walk that reached it. A node is replaced, never changed, when a cell is redefined, so what it reads is its
	 * own, and a state of the cells reads each kept shape where every state built them again for every cell.
	 */
	readonly #entries = new Map<Cell, CellEntry>()
	/** The walks of the cells so far (#walk), each one's number what it marks the cells it reaches with. */
	#walks = 0
	/** How the cells the roots reach are read, kept as every change moves it (Reach). */
	readonly #reach: Reach
	/** The cell of each node of the base, made when the editor starts. */
	readonly #cellOf: ReadonlyMap<RelNode, Cell>
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
	/** The version each cell's node was set at, by the change that set it; a cell of the base was set at 0. */
	readonly #changedAt = new Map<Cell, number>()
	/** The version at which each cell's references, and each label's count of scope names, last moved (Reach). */
	readonly #movedAt = new Map<Cell, number>()
	readonly #namedAt = new Map<NodeId, number>()
	/** What the last finish folded each cell into, which the next one keeps where the cell is as it was (finishCells). */
	#folded: ReadonlyMap<Cell, FoldedCell> = new Map()

	/** The DAG the editor started from. */
	readonly base: ValidDag<R>

	/** Bumped by every change, so analyses memoized over a snapshot know when they are stale. */
	get version(): number {
		return this.#version
	}

	constructor(dag: ValidDag<R>) {
		this.base = dag
		const cells: Array<Cell> = []
		this.#cellOf = cellTable(dag.roots, (cell) => {
			cells.push(cell)
			this.#readers.created(cell)
			this.#note(cell.id, cell.current)
		})
		for (const e of exprClosure(cells.flatMap((c) => exprsOf(c.current)))) {
			this.#fresh.expr.note(e.id)
		}
		this.#reach = new Reach((cell) => this.#entryOf(cell).shape, this.roots)
	}

	/** Records the labels a node holds as taken. */
	#note(id: NodeId, node: EditNode): void {
		this.#fresh.node.note(id)
		if (node.kind === "Base") {
			this.#fresh.occ.note(node.occurrence)
		}
		if (node.kind === "Group") {
			for (const k of node.bound.keyed) {
				this.#fresh.occ.note(k.occurrence)
			}
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
		return this.#moved.get(root) ?? this.cellOf(root)
	}

	/**
	 * The cell a node of the base DAG became when the editor started, which rewrites may since have redefined in place:
	 * with `finished().node`, a node's counterpart in the edited DAG.
	 */
	cellOf(node: RelNode): Cell {
		return defined(this.#cellOf.get(node), "a node of the DAG the editor started from")
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
		return this.expr(storedColumn(cell.id, col.name, col.type))
	}

	/** A new cell of `node` under a fresh label. */
	add(node: EditNode): Cell {
		const cell: Cell = { id: NodeId(this.#fresh.node.take()), current: node }
		this.#readers.created(cell)
		this.#note(cell.id, node)
		this.#changed([cell])
		return cell
	}

	/** Redefines `cell` as `node` in place: every reader holding the cell reads the new node. */
	set(cell: Cell, node: EditNode): void {
		const before = cell.current
		const was = this.#entryOf(cell).shape
		cell.current = node
		this.#readers.changed(cell, before)
		this.#reach.changed(cell, was, this.#entryOf(cell).shape)
		this.#note(cell.id, node)
		this.#changed([cell])
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
	 * Every cell the roots reach, in topological order, inputs first (a postorder over each node's edges, as ir/dag.ts
	 * topoOrder walks a DAG's, read off the kept shapes, #entries; a SelfRef's feedback is a
	 * name, not followed). The walk ends over any edges: a cycle a rewrite made is finish's refusal. Computed at each
	 * call: a reader that reads the order of one state of the cells more than once holds it (cellState).
	 */
	topoOrder(): ReadonlyArray<Cell> {
		return this.#walk().order
	}

	/**
	 * One walk of the cells the roots reach (topoOrder's postorder over the kept shapes), which finds as it ends each cell
	 * whether it lies on a recursive step, its inputs ended before it (feedbackReadsOf's rule, readsFeedback): what a
	 * state's order and feedback read, one lookup of each cell's shape, where the two were two walks of every cell.
	 */
	#walk(): { readonly order: ReadonlyArray<Cell>; readonly feedback: ReadonlySet<Cell> } {
		const order: Array<Cell> = []
		const feedback = new Set<Cell>()
		this.#walks += 1
		const walk = this.#walks
		for (const root of this.roots) {
			const top = this.#entryOf(root)
			if (top.walked === walk) {
				continue
			}
			top.walked = walk
			const stack: Array<{
				readonly cell: Cell
				readonly edges: ReadonlyArray<Cell>
				next: number
			}> = [{ cell: root, edges: top.shape.edges, next: 0 }]
			for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
				const input = frame.edges[frame.next]
				if (input === undefined) {
					stack.pop()
					order.push(frame.cell)
					if (readsFeedback(frame.cell.current, frame.edges, feedback)) {
						feedback.add(frame.cell)
					}
					continue
				}
				frame.next++
				const entry = this.#entryOf(input)
				if (entry.walked !== walk) {
					entry.walked = walk
					stack.push({ cell: input, edges: entry.shape.edges, next: 0 })
				}
			}
		}
		return { order, feedback }
	}

	/**
	 * What the editor keeps of `cell` (CellEntry, #entries): what its node reads worked out again only where the cell
	 * holds another node than when it was last read.
	 */
	#entryOf(cell: Cell): CellEntry {
		const known = this.#entries.get(cell)
		if (known === undefined) {
			const made: CellEntry = { node: cell.current, shape: nodeShape(cell.current), walked: 0 }
			this.#entries.set(cell, made)
			return made
		}
		if (known.node !== cell.current) {
			known.node = cell.current
			known.shape = nodeShape(cell.current)
		}
		return known
	}

	/**
	 * The cells the roots reach now, in topological order, those of them on a recursive step, and how each is read, off
	 * the reach the editor keeps (CellState, Reach).
	 */
	cellState(): CellState {
		const { order, feedback } = this.#walk()
		const read = this.#reach.taken()
		let readers: ((cell: Cell) => ReadonlyArray<Cell>) | undefined
		let stamps: ReadonlyMap<Cell, number> | undefined
		const version = this.#version
		return {
			order,
			feedback,
			references: read.references,
			lateral: read.lateral,
			readers: (cell) => {
				readers ??= this.readersIn(order)
				return readers(cell)
			},
			stamp: (cell) => {
				stamps ??= this.#stampsIn(order, version)
				return stamps.get(cell) ?? 0
			},
			set: (cell) => this.#changedAt.get(cell) ?? 0,
			moved: (cell) => Math.max(this.#movedAt.get(cell) ?? 0, this.#namedAt.get(cell.id) ?? 0)
		}
	}

	/**
	 * The stamp of each cell of `order`, a state's cells taken at `version` (CellState stamp): the latest version its node
	 * or a node it reaches through data inputs was set at, each cell's after its inputs'. Worked out at the state's
	 * version alone: the nodes a later edit set are another state's.
	 */
	#stampsIn(order: ReadonlyArray<Cell>, version: number): ReadonlyMap<Cell, number> {
		invariant(this.#version === version, "a state's stamps read before the next edit")
		const stamps = new Map<Cell, number>()
		for (const cell of order) {
			let at = this.#changedAt.get(cell) ?? 0
			for (const input of this.#entryOf(cell).shape.edges) {
				at = Math.max(at, stamps.get(input) ?? 0)
			}
			stamps.set(cell, at)
		}
		return stamps
	}

	/**
	 * The readers of each cell through data inputs, one per input position, in `order`, the cells the roots reach: the
	 * reachable cells that read it, a cell that reads it twice (a semi-join on both sides, a region matching it twice)
	 * listed twice, as the lowering emits it twice; none for a cell no reachable cell reads.
	 */
	readersIn(order: ReadonlyArray<Cell>): (cell: Cell) => ReadonlyArray<Cell> {
		const out = new Map<Cell, Array<Cell>>()
		for (const cell of order) {
			for (const input of this.#entryOf(cell).shape.edges) {
				out.getOrInsertComputed(input, () => []).push(cell)
			}
		}
		return (cell) => out.get(cell) ?? []
	}

	/** How many references a cell has: its readers, one per input position (readersIn), plus the roots at it. */
	refCount(cell: Cell, readers: (cell: Cell) => ReadonlyArray<Cell>): number {
		return readers(cell).length + this.roots.filter((r) => r === cell).length
	}

	/** The cells reachable from `cell` through data inputs, `cell` included. */
	static subtree(cell: Cell): ReadonlySet<Cell> {
		return subtreeOf(cellGraph, cell)
	}

	/**
	 * Whether some expression in the subtree of `cell` reads a node outside that subtree: the subtree is correlated with
	 * an enclosing scope, and moving it would change what that reference names.
	 */
	static correlated(cell: Cell): boolean {
		return readsOutside(cellGraph, subtreeOf(cellGraph, cell))
	}

	/**
	 * The cells a union's discriminant is read through, among `order`, the cells the roots reach: from each arm down the
	 * chain of nodes that keep their input's rows (rel.ts keptRowsOf) to the projection that binds the literal, the chain
	 * a valid DAG binds the literal through. Replacing one of them by a closed relation would hide the literal, so branch
	 * removal drops a vacuous arm from its union instead.
	 */
	static discriminantSpine(order: ReadonlyArray<Cell>): ReadonlySet<Cell> {
		const spine = new Set<Cell>()
		/** An arm and every cell beneath it that keeps its input's rows. */
		const walk = (arm: Cell): void => {
			for (let at: Cell | undefined = arm; at !== undefined && !spine.has(at);) {
				spine.add(at)
				at = keptRowsOf(at.current)?.input
			}
		}
		for (const cell of order) {
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
		const rewritten: Array<Cell> = []
		for (const cell of this.#readers.of(from)) {
			if (cell === to || except.has(cell)) {
				continue
			}
			rewritten.push(cell)
			const node = cell.current
			const was = this.#entryOf(cell).shape
			const copy = this.copier(remap)
			cell.current = drive(
				mapNode<EditRefs, EditRefs>(node, { ...keptRefs, expr: (e) => copy.of(e) }),
				(input) => (input === from ? to : input)
			)
			this.#readers.changed(cell, node)
			this.#reach.changed(cell, was, this.#entryOf(cell).shape)
		}
		for (const root of this.base.roots) {
			if (this.#rootCell(root) !== from) {
				continue
			}
			this.#moved.set(root, to)
			this.#reach.reached(to, 1)
			this.#reach.reached(from, -1)
		}
		this.#changed(rewritten)
	}

	/** A change: the version moves on, and each cell whose node it set was set at it. */
	#changed(set: ReadonlyArray<Cell>): void {
		this.#version++
		for (const cell of set) {
			this.#changedAt.set(cell, this.#version)
		}
		const moved = this.#reach.drainMoved()
		for (const cell of moved.references) {
			this.#movedAt.set(cell, this.#version)
		}
		for (const label of moved.named) {
			this.#namedAt.set(label, this.#version)
		}
	}

	/**
	 * Places a new cell over `target`: `wrap` builds it over the target, and every reader of the target except the
	 * target's own subtree (whose correlated references stay with it) reads the new cell instead.
	 *
	 * Cells the wrapper chain added between target and top are in top's subtree; exclude them too.
	 */
	insertAbove(target: Cell, wrap: (target: Cell) => Cell): Cell {
		const top = wrap(target)
		const except = new Set(DagEditor.subtree(target))
		except.add(top)
		for (const c of DagEditor.subtree(top)) {
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
		const done = unwrap(finishCells(this.base.roots, (root) => this.#rootCell(root), this.#folded))
		this.#folded = done.folded
		return done
	}

	/** The DAG the cells the roots reach hold now (finished). */
	finish(): ValidDag<R> {
		return this.finished().dag
	}
}
