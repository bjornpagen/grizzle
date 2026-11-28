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
import { KeptOrder } from "#compiler/lower/optimize/demand/order.ts"

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

	/** How many identifiers of the kind were drawn so far, taken or passed over: it moves with every take. */
	get drawn(): number {
		return this.#counter
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

	/** Every cell whose node reads `cell` through a data edge, those no root reaches included. */
	byEdge(cell: Cell): Iterable<Cell> {
		return this.#byEdge.get(cell) ?? []
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

/**
 * The copy of `e` with each column reference `remap` replaces, its argument copies first: `e` itself when none changes.
 *
 * @yields each argument of `e`, in operand order, its copy sent back in its place
 */
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

/**
 * What a reader of the cells reads of them, heard while a rewrite pass's driver judges a cell (DagEditor observe): through
 * a state of the cells (CellState) or the editor's roots. A rule decides at a cell by the nodes of the cell's subtree, by
 * what it reads here, and by the analyses a decision reads; the driver's quiet index (quiet.ts) keeps what it heard, so
 * it knows which edits could change the verdict.
 *
 * - `subtree`: the nodes of a cell and of every cell it reaches through data edges (CellState stamp; the readers a state
 *   handed out, whose nodes the reader may read next);
 * - `reach`: how a cell is read: its references, whether a scope expression names it, its readers, whether a root stands
 *   at it (CellState references, lateral, readers, moved; DagEditor isRoot);
 * - `whole`: the order of every reached cell, which every edit may move.
 */
export interface Reads {
	readonly subtree: (cell: Cell) => void
	readonly reach: (cell: Cell) => void
	readonly whole: () => void
}

/** Nobody hears the reads: an editor no driver judges with. */
const unobserved: Reads = {
	subtree: () => undefined,
	reach: () => undefined,
	whole: () => undefined
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

/** What an editor keeps of a cell (DagEditor #entries): the node it held when last read and what that node reads. */
interface CellEntry {
	node: EditNode
	shape: NodeShape
}

/**
 * What moved in the reach (Reach) while a state of the cells was the newest one taken: each count a change moved, at its
 * value before the first such change, and the epoch of the next state taken after a change. A state reads a count from
 * the first epoch from its own on that holds it, else as the count is now: as it was when the state was taken.
 */
interface Epoch {
	readonly references: Map<Cell, number>
	readonly named: Map<NodeId, number>
	readonly readers: Map<Cell, ReadonlyMap<Cell, number>>
	next: Epoch | undefined
}

/**
 * How the cells the roots reach are read, kept as the editor changes them (CellState references, lateral and readers,
 * which analysis/demand structureOf works out of a finished DAG): each reached cell's readers among the reached cells, by
 * how many input positions each reads it at, its references, one per input position of a reached cell that names it plus
 * each root standing at it, and how many times the scope expressions of reached cells name each label. A cell is reached
 * while it has a reference: its first brings its own edges and names into the counts, its last takes them out, so a
 * change costs the edges it moves and those of the cells it brings into reach or takes out of it, never the cells. A
 * state reads them as they were when it was taken (Epoch).
 */
class Reach {
	readonly #references = new Map<Cell, number>()
	readonly #named = new Map<NodeId, number>()
	readonly #readers = new Map<Cell, Map<Cell, number>>()
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
			this.reached(root, 1, undefined)
		}
		this.drainMoved()
	}

	/** Whether a root reaches `cell` now. */
	has(cell: Cell): boolean {
		return this.#references.has(cell)
	}

	/** What the change under way moved (#movedReferences, #movedNamed), the next change's starting from none. */
	drainMoved(): { readonly references: ReadonlySet<Cell>; readonly named: ReadonlySet<NodeId> } {
		const moved = { references: this.#movedReferences, named: this.#movedNamed }
		this.#movedReferences = new Set()
		this.#movedNamed = new Set()
		return moved
	}

	/**
	 * The cells' references, lateral reads and readers as they are now, read so by a state taken now whatever changes
	 * after: each reached reader of a cell, by how many input positions it reads it at.
	 */
	taken(): Pick<CellState, "references" | "lateral"> & {
		readonly readers: (cell: Cell) => ReadonlyMap<Cell, number>
	} {
		const epoch = this.#open()
		return {
			references: (cell) =>
				Reach.#at(epoch, (e) => e.references, cell) ?? this.#references.get(cell) ?? 0,
			lateral: (cell) =>
				(Reach.#at(epoch, (e) => e.named, cell.id) ?? this.#named.get(cell.id) ?? 0) > 0,
			readers: (cell) =>
				Reach.#at(epoch, (e) => e.readers, cell) ?? this.#readers.get(cell) ?? noReaders
		}
	}

	/** The newest epoch where nothing moved in it yet, which a state taken now shares, else a new one after it. */
	#open(): Epoch {
		const open = this.#epoch
		if (open?.references.size === 0 && open.named.size === 0 && open.readers.size === 0) {
			return open
		}
		const epoch: Epoch = {
			references: new Map(),
			named: new Map(),
			readers: new Map(),
			next: undefined
		}
		if (open !== undefined) {
			open.next = epoch
		}
		this.#epoch = epoch
		return epoch
	}

	/** A value as the state of `from` reads it: the first epoch's from it on that recorded it, none if none did. */
	static #at<K, V>(from: Epoch, log: (e: Epoch) => Map<K, V>, key: K): V | undefined {
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

	/** One input position of the reached cell `reader` that reads `cell`, added (`by` 1) or taken away (-1). */
	#read(cell: Cell, reader: Cell, by: 1 | -1): void {
		const readers = this.#readers.get(cell)
		const epoch = this.#epoch
		if (epoch !== undefined && !epoch.readers.has(cell)) {
			epoch.readers.set(cell, new Map(readers ?? []))
		}
		const now = (readers?.get(reader) ?? 0) + by
		if (now !== 0) {
			this.#readers.getOrInsertComputed(cell, () => new Map()).set(reader, now)
			return
		}
		readers?.delete(reader)
		if (readers?.size === 0) {
			this.#readers.delete(cell)
		}
	}

	/**
	 * A reference to `cell` added (`by` 1) or taken away (-1): a root moved (no reader), or an input position of the
	 * reached cell `reader`. A cell it brings into reach, or takes out of it, brings or takes its own edges and names with
	 * it, each a step.
	 */
	reached(cell: Cell, by: 1 | -1, reader: Cell | undefined): void {
		const steps: Array<{ readonly cell: Cell; readonly reader: Cell | undefined }> = [
			{ cell, reader }
		]
		for (let at = steps.pop(); at !== undefined; at = steps.pop()) {
			if (at.reader !== undefined) {
				this.#read(at.cell, at.reader, by)
			}
			if (!this.#reachStep(at.cell, by)) {
				continue
			}
			const shape = this.#shape(at.cell)
			for (const label of shape.lateral) {
				this.#move(this.#named, (e) => e.named, this.#movedNamed, label, by)
			}
			for (const input of shape.edges) {
				steps.push({ cell: input, reader: at.cell })
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
			this.reached(input, 1, cell)
		}
		for (const label of before.lateral) {
			this.#move(this.#named, (e) => e.named, this.#movedNamed, label, -1)
		}
		for (const input of before.edges) {
			this.reached(input, -1, cell)
		}
	}
}

/** No readers: a cell no reached cell reads. */
const noReaders: ReadonlyMap<Cell, number> = new Map()

/** No cells: the feedback of a DAG no recursion's feedback scan is reached in. */
const noCells: ReadonlySet<Cell> = new Set()

export class DagEditor<R extends Roots = Roots> {
	/**
	 * The cells that read each cell, kept as each cell's node changes: what a redirection rewrites (Readers). It holds
	 * every cell in creation order: the base's, each after its inputs, then each one a rewrite added.
	 */
	readonly #readers = new Readers()
	/**
	 * What the editor keeps of each cell it has read (CellEntry): what its node reads, while the cell holds that node. A
	 * node is replaced, never changed, when a cell is redefined, so what it reads is its own, and a state of the cells
	 * reads each kept shape where every state built them again for every cell.
	 */
	readonly #entries = new Map<Cell, CellEntry>()
	/** How the cells the roots reach are read, kept as every change moves it (Reach). */
	readonly #reach: Reach
	/**
	 * The cells the roots reach in order, kept as the edits change it (KeptOrder), walked when a state of the cells is
	 * first taken.
	 */
	#kept: KeptOrder | undefined
	/** The cells whose node a change set since the kept order was last patched, which the next patch walks again. */
	#touched = new Set<Cell>()
	/** The cells whose node is a recursion's feedback scan, which alone start a recursive step (readsFeedback). */
	readonly #selfRefs = new Set<Cell>()
	/**
	 * Each cell's stamp (CellState stamp) as of the last time they were brought up to date (#stamped), and the cells set
	 * since, whose stamps and those of the cells above them that wait for it.
	 */
	readonly #stamps = new Map<Cell, number>()
	#unstamped: Array<Cell> = []
	/**
	 * What moved since a driver last drained it (drainMoves): the cells whose stamp moved, and the labels of the cells
	 * whose reach counts moved (Reach).
	 */
	#restamped = new Set<Cell>()
	#reachMoved = new Set<NodeId>()
	/** Who hears what a reader reads of the cells while a driver judges one (Reads); none hears outside a driver. */
	#reads: Reads = unobserved
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
	/**
	 * What the last finish folded each cell into, which the next one keeps where the cell is as it was (finishCells):
	 * before any finish, each cell of the base folded into the base's own node, so a finish keeps every node of the base
	 * whose cell and inputs are as they were, the same object, as it keeps a node an earlier finish built. A part of the
	 * DAG no rewrite changed is the base's own nodes, which every reader keyed by a node (logical/annotate.ts
	 * SharedAnalyses) reads as the nodes it met, where the first finish built each of them again.
	 */
	#folded: ReadonlyMap<Cell, FoldedCell>

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
			this.#note(cell, cell.current)
		})
		this.#folded = new Map(
			Array.from(this.#cellOf, ([node, cell]) => [cell, { current: cell.current, node }] as const)
		)
		for (const e of exprClosure(cells.flatMap((c) => exprsOf(c.current)))) {
			this.#fresh.expr.note(e.id)
		}
		this.#reach = new Reach((cell) => this.#entryOf(cell).shape, this.roots)
	}

	/** Records the labels a node of `cell` holds as taken, and whether the cell is a recursion's feedback scan. */
	#note(cell: Cell, node: EditNode): void {
		if (node.kind === "SelfRef") {
			this.#selfRefs.add(cell)
		} else {
			this.#selfRefs.delete(cell)
		}
		this.#fresh.node.note(cell.id)
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

	/** Whether a root stands at `cell`: a read of the cell's reach (Reads). */
	isRoot(cell: Cell): boolean {
		this.#reads.reach(cell)
		return this.base.roots.some((root) => this.#rootCell(root) === cell)
	}

	/**
	 * Every reader of the cells a driver judges reports what it reads to `reads` from now on (Reads): the driver's quiet
	 * index (quiet.ts).
	 */
	observe(reads: Reads): void {
		this.#reads = reads
	}

	/** How many fresh identifiers the editor has drawn, of every kind: a rule that drew one changed what the next draws. */
	get draws(): number {
		const f = this.#fresh
		return f.node.drawn + f.expr.drawn + f.var.drawn + f.occ.drawn + f.scope.drawn
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
		this.#note(cell, node)
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
		this.#note(cell, node)
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
	 * topoOrder walks a DAG's, read off the kept shapes, #entries; a SelfRef's feedback is a name, not followed): the kept
	 * order, patched to the edits since it was last read (KeptOrder). The walk ends over any edges: a cycle a rewrite made
	 * is finish's refusal.
	 */
	topoOrder(): ReadonlyArray<Cell> {
		const kept = this.#order()
		return kept.cells(kept.generation)
	}

	/**
	 * The kept order (KeptOrder), walked when first read and patched to the edits since it was last read: the cells it
	 * placed anew or labelled again.
	 */
	#patched(): { readonly kept: KeptOrder; readonly moved: ReadonlyArray<Cell> } {
		const known = this.#kept
		const touched = this.#touched
		this.#touched = new Set()
		if (known === undefined) {
			const kept = new KeptOrder(
				this.roots,
				(cell) => this.#entryOf(cell).shape.edges,
				(cell) => this.#reach.has(cell)
			)
			this.#kept = kept
			return { kept, moved: kept.cells(kept.generation) }
		}
		return { kept: known, moved: known.patch(this.roots, touched) }
	}

	/** The kept order, patched to the edits since it was last read (#patched). */
	#order(): KeptOrder {
		return this.#patched().kept
	}

	/**
	 * What the editor keeps of `cell` (CellEntry, #entries): what its node reads worked out again only where the cell
	 * holds another node than when it was last read.
	 */
	#entryOf(cell: Cell): CellEntry {
		const known = this.#entries.get(cell)
		if (known === undefined) {
			const made: CellEntry = { node: cell.current, shape: nodeShape(cell.current) }
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
	 * the reach and the order the editor keeps (CellState, Reach, KeptOrder), the order read out once for the state.
	 */
	cellState(): CellState {
		const kept = this.#order()
		const read = this.#read(kept)
		return this.#state(kept, () => read.order, read.feedback)
	}

	/**
	 * The kept order read out now, with its cells on a recursive step found as each is read where a recursion's feedback
	 * scan is reached, none where none is.
	 */
	#read(kept: KeptOrder): {
		readonly order: ReadonlyArray<Cell>
		readonly feedback: ReadonlySet<Cell>
	} {
		return [...this.#selfRefs].some((cell) => kept.has(cell))
			? kept.read(kept.generation, (cell, edges, found) =>
					readsFeedback(cell.current, edges, found)
				)
			: { order: kept.cells(kept.generation), feedback: noCells }
	}

	/**
	 * The state a rewrite pass's driver reads its cells at (rewritePass): cellState's, its order read out of the kept
	 * order only when a reader asks for it, before the next state is taken; and the cells the kept order placed anew or
	 * labelled again since the last state, which a reader keyed by the order takes again.
	 */
	drivenState(): { readonly cells: CellState; readonly moved: ReadonlyArray<Cell> } {
		const { kept, moved } = this.#patched()
		const generation = kept.generation
		if ([...this.#selfRefs].some((cell) => kept.has(cell))) {
			const read = this.#read(kept)
			return { cells: this.#state(kept, () => read.order, read.feedback), moved }
		}
		let order: ReadonlyArray<Cell> | undefined
		return {
			cells: this.#state(
				kept,
				() => {
					order ??= kept.cells(generation)
					return order
				},
				noCells
			),
			moved
		}
	}

	/**
	 * The label that orders `cell` in the kept order as it was last patched (KeptOrder label), none for a cell no root
	 * reached then.
	 */
	labelAt(cell: Cell): number | undefined {
		const kept = this.#kept
		return kept?.has(cell) === true ? kept.label(cell) : undefined
	}

	/**
	 * A state of the cells over the kept order `kept` as it stands now, its cells in order `order` (read out of it now, or
	 * when first asked) and those of them on a recursive step `feedback`; its counts as Reach keeps them; its readers, each
	 * list in the order's order, read off Reach where first asked before an edit, else off the order and the edges then, as
	 * a reader who asked after its own edit read them; its stamps, read before the next edit. Every read but the
	 * feedback's is reported to the editor's listener (Reads).
	 */
	#state(
		kept: KeptOrder,
		order: () => ReadonlyArray<Cell>,
		feedback: ReadonlySet<Cell>
	): CellState {
		const version = this.#version
		const generation = kept.generation
		const read = this.#reach.taken()
		let readers: ((cell: Cell) => ReadonlyArray<Cell>) | undefined
		const listen = (): Reads => this.#reads
		return {
			get order(): ReadonlyArray<Cell> {
				listen().whole()
				return order()
			},
			feedback,
			references: (cell) => {
				listen().reach(cell)
				return read.references(cell)
			},
			lateral: (cell) => {
				listen().reach(cell)
				return read.lateral(cell)
			},
			readers: (cell) => {
				readers ??=
					this.#version === version
						? this.#keptReaders(read.readers, kept, generation, order)
						: this.readersIn(order())
				const out = readers(cell)
				const reads = listen()
				reads.reach(cell)
				for (const reader of out) {
					reads.subtree(reader)
				}
				return out
			},
			stamp: (cell) => {
				invariant(this.#version === version, "a state's stamps read before the next edit")
				listen().subtree(cell)
				this.#stamped()
				return kept.has(cell) ? (this.#stamps.get(cell) ?? 0) : 0
			},
			set: (cell) => {
				listen().subtree(cell)
				return this.#changedAt.get(cell) ?? 0
			},
			moved: (cell) => {
				listen().reach(cell)
				return Math.max(this.#movedAt.get(cell) ?? 0, this.#namedAt.get(cell.id) ?? 0)
			}
		}
	}

	/**
	 * The readers of each cell (CellState readers), one per input position, off the reached readers Reach keeps for the
	 * state (`readers`), in the order of the state's cells: by their labels in the kept order while it stands at
	 * `generation`, else by their places in the state's order `order`; each cell's list worked out once.
	 */
	#keptReaders(
		readers: (cell: Cell) => ReadonlyMap<Cell, number>,
		kept: KeptOrder,
		generation: number,
		order: () => ReadonlyArray<Cell>
	): (cell: Cell) => ReadonlyArray<Cell> {
		let places: ReadonlyMap<Cell, number> | undefined
		const rank = (cell: Cell): number => {
			if (kept.generation === generation) {
				return kept.label(cell)
			}
			places ??= new Map(order().map((c, i) => [c, i]))
			return defined(places.get(cell), "a reader the state reaches")
		}
		const lists = new Map<Cell, ReadonlyArray<Cell>>()
		return (cell) =>
			lists.getOrInsertComputed(cell, () =>
				[...readers(cell)]
					.map(([reader, count]) => ({ reader, count, at: rank(reader) }))
					.toSorted((a, b) => a.at - b.at)
					.flatMap(({ reader, count }) => Array.from({ length: count }, () => reader))
			)
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
			this.#reach.reached(to, 1, undefined)
			this.#reach.reached(from, -1, undefined)
		}
		this.#changed(rewritten)
	}

	/**
	 * A change: the version moves on, each cell whose node it set was set at it, and waits for the order's next patch and
	 * for its stamp and the stamps above it (#stamped).
	 */
	#changed(set: ReadonlyArray<Cell>): void {
		this.#version++
		for (const cell of set) {
			this.#changedAt.set(cell, this.#version)
			this.#touched.add(cell)
			this.#unstamped.push(cell)
		}
		const moved = this.#reach.drainMoved()
		for (const cell of moved.references) {
			this.#movedAt.set(cell, this.#version)
			this.#reachMoved.add(cell.id)
		}
		for (const label of moved.named) {
			this.#namedAt.set(label, this.#version)
			this.#reachMoved.add(label)
		}
	}

	/**
	 * Every cell's stamp brought up to date: each cell set since, from the latest change down, stamps itself and every
	 * cell above it through data edges (Readers, those no root reaches included) whose stamp is older, so a stamp is the
	 * latest version a node of the cell's subtree was set at. A cell whose stamp moved is one a driver drains
	 * (drainMoves).
	 */
	#stamped(): void {
		const pending = this.#unstamped
		if (pending.length === 0) {
			return
		}
		this.#unstamped = []
		const set = (cell: Cell): number => this.#changedAt.get(cell) ?? 0
		const byLatest = pending.toSorted((a, b) => set(b) - set(a))
		for (const from of byLatest) {
			const at = set(from)
			const up = [from]
			for (let cell = up.pop(); cell !== undefined; cell = up.pop()) {
				if ((this.#stamps.get(cell) ?? 0) >= at) {
					continue
				}
				this.#stamps.set(cell, at)
				this.#restamped.add(cell)
				for (const reader of this.#readers.byEdge(cell)) {
					up.push(reader)
				}
			}
		}
	}

	/**
	 * What moved since the last drain, which a driver reads to know whose verdicts an edit could have changed: the cells
	 * whose stamp moved (#stamped), and the labels of the cells whose reach counts moved (Reach).
	 */
	drainMoves(): { readonly stamped: ReadonlySet<Cell>; readonly reach: ReadonlySet<NodeId> } {
		this.#stamped()
		const moves = { stamped: this.#restamped, reach: this.#reachMoved }
		this.#restamped = new Set()
		this.#reachMoved = new Set()
		return moves
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
