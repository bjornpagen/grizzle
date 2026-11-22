import { defined, invariant } from "@bjornpagen/grizzle-text/base/invariant"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Cell } from "#compiler/ir/rel.ts"
import type { CellState, DagEditor, Reads } from "#compiler/lower/optimize/demand/editor.ts"

/**
 * What one verdict at a cell read (Reads), heard while every rule of the pass decided at it: the cells whose subtree's
 * nodes and whose reach it read, whether it read the whole order, and the editor's draws of fresh identifiers and its
 * version when it began.
 */
interface Hearing {
	readonly cell: Cell
	readonly subtree: Set<Cell>
	readonly reach: Set<Cell>
	whole: boolean
	readonly draws: number
	readonly version: number
}

/** A cell to judge, queued by its label in the kept order when queued. */
interface Queued {
	readonly label: number
	readonly cell: Cell
}

/**
 * The verdicts one rewrite pass has taken at its cells, and the cells still to judge, in order (frame.ts rewritePass).
 *
 * A rule decides at a cell by the nodes of the cell's subtree, by what it reads of the cells through the state or the
 * editor's roots (Reads), and by the analyses of the whole DAG only through a decision (frame.ts Decision); whatever
 * identifiers it draws are drawn in the order the driver judges in. So where every rule settled false at a cell, asking
 * no decision and drawing nothing, every rule settles false there again, drawing nothing, until an edit moves something
 * it read: a node of its subtree (the cell's stamp moves), a node of a subtree it read (a reader handed out, a stamp
 * read), a reach it read, or the state's feedback. Such a cell is quiet, and the driver judges it again only once one of
 * those moved, which the editor reports (DagEditor drainMoves): the cells whose stamp moved and the labels whose reach
 * moved, each waking the quiet cells that heard it.
 *
 * Every other reached cell is queued by its label, and the driver judges them in order, from the first: the first rule
 * that fires at the first queued cell where one fires is the one a scan of every cell from the first finds, and every
 * identifier is drawn as that scan draws it, since a cell that drew one is judged again at every state. A cell the kept
 * order labels again or places anew is queued again under its new label, the old entry passed over.
 */
export class QuietCells {
	readonly #editor: DagEditor
	/**
	 * The quiet cells (QuietCells), each by the epoch of the verdict that made it quiet: every rule settled false there,
	 * asking no decision, drawing no identifier and reading no more than it heard.
	 */
	readonly #quiet = new Map<Cell, number>()
	/** The quiet cells that heard each cell's subtree and each label's reach, by the epoch of the verdict that heard it. */
	readonly #bySubtree = new Map<Cell, Map<Cell, number>>()
	readonly #byReach = new Map<NodeId, Map<Cell, number>>()
	#epoch = 0
	/** The queue: a binary heap of queued cells by label, and the label each cell's live entry carries. */
	readonly #heap: Array<Queued> = []
	readonly #queued = new Map<Cell, number>()
	/** The cells that asked, drew or read the whole order at the state being judged, queued again once its scan ends. */
	#again: Array<Cell> = []
	/** The feedback of the last state taken, whose every quiet verdict read it. */
	#feedback: ReadonlySet<Cell> | undefined
	/** The verdict under way, whose reads the editor's readers report (Reads). */
	#hearing: Hearing | undefined

	constructor(editor: DagEditor) {
		this.#editor = editor
		const reads: Reads = {
			subtree: (cell) => this.#hearing?.subtree.add(cell),
			reach: (cell) => this.#hearing?.reach.add(cell),
			whole: () => {
				const hearing = this.#hearing
				if (hearing !== undefined) {
					hearing.whole = true
				}
			}
		}
		editor.observe(reads)
	}

	/**
	 * The state `cells` taken: `moved` the cells the kept order placed anew or labelled again, and `moves` what moved since
	 * the last state (DagEditor drainMoves), each waking the quiet cells that heard it; where the feedback moved, every
	 * cell wakes.
	 */
	taken(
		cells: CellState,
		moved: ReadonlyArray<Cell>,
		moves: { readonly stamped: ReadonlySet<Cell>; readonly reach: ReadonlySet<NodeId> }
	): void {
		const before = this.#feedback
		this.#feedback = cells.feedback
		if (before !== undefined && !sameCells(before, cells.feedback)) {
			this.#quiet.clear()
			this.#bySubtree.clear()
			this.#byReach.clear()
			for (const cell of cells.order) {
				this.#queue(cell)
			}
			return
		}
		for (const cell of moved) {
			if (!this.#quiet.has(cell)) {
				this.#queue(cell)
			}
		}
		for (const cell of moves.stamped) {
			this.#wake(cell)
			this.#wakeAll(this.#bySubtree, cell)
		}
		for (const label of moves.reach) {
			this.#wakeAll(this.#byReach, label)
		}
	}

	/** Every quiet cell that heard `key` in `index` by the verdict it still holds woken (#wake); the key heard no more. */
	#wakeAll<K>(index: Map<K, Map<Cell, number>>, key: K): void {
		const heard = index.get(key)
		if (heard === undefined) {
			return
		}
		index.delete(key)
		for (const [cell, epoch] of heard) {
			if (this.#quiet.get(cell) === epoch) {
				this.#wake(cell)
			}
		}
	}

	/** A quiet cell to judge again. */
	#wake(cell: Cell): void {
		if (this.#quiet.delete(cell)) {
			this.#queue(cell)
		}
	}

	/** `cell` queued under its label now, where a root reaches it and its live entry carries another. */
	#queue(cell: Cell): void {
		const label = this.#editor.labelAt(cell)
		if (label === undefined || this.#queued.get(cell) === label) {
			return
		}
		this.#queued.set(cell, label)
		const heap = this.#heap
		heap.push({ label, cell })
		for (let at = heap.length - 1; at > 0;) {
			const up = (at - 1) >> 1
			const parent = defined(heap[up], "a heap entry's parent")
			const entry = defined(heap[at], "a heap entry")
			if (parent.label <= entry.label) {
				break
			}
			heap[up] = entry
			heap[at] = parent
			at = up
		}
	}

	/** The heap's least entry taken off. */
	#pop(): void {
		const heap = this.#heap
		const last = heap.pop()
		if (last === undefined || heap.length === 0) {
			return
		}
		heap[0] = last
		for (let at = 0; ;) {
			const left = 2 * at + 1
			const right = left + 1
			let least = at
			if (
				(heap[left]?.label ?? Number.POSITIVE_INFINITY) < defined(heap[least], "an entry").label
			) {
				least = left
			}
			if (
				(heap[right]?.label ?? Number.POSITIVE_INFINITY) < defined(heap[least], "an entry").label
			) {
				least = right
			}
			if (least === at) {
				return
			}
			const a = defined(heap[at], "an entry")
			heap[at] = defined(heap[least], "an entry")
			heap[least] = a
			at = least
		}
	}

	/**
	 * The first cell to judge at the state (`feedback` its cells on a recursive step, which no rule is applied at), its
	 * entry left on the queue until it is judged; none where no cell is left to judge.
	 */
	next(feedback: ReadonlySet<Cell>): Cell | undefined {
		for (let top = this.#heap[0]; top !== undefined; top = this.#heap[0]) {
			const live = this.#queued.get(top.cell) === top.label
			if (live && this.#editor.labelAt(top.cell) === top.label && !feedback.has(top.cell)) {
				return top.cell
			}
			this.#pop()
			if (live) {
				this.#queued.delete(top.cell)
			}
		}
		return undefined
	}

	/** The verdict at `cell`, the first cell to judge (next), begun: its reads heard from now on. */
	hear(cell: Cell): Hearing {
		const hearing: Hearing = {
			cell,
			subtree: new Set(),
			reach: new Set(),
			whole: false,
			draws: this.#editor.draws,
			version: this.#editor.version
		}
		this.#hearing = hearing
		return hearing
	}

	/**
	 * The verdict `hearing` settled false at every rule, `asked` whether one asked a decision: the cell is quiet, keeping
	 * what it heard, unless it asked, drew an identifier or read the whole order, when it is judged again at the next
	 * state (QuietCells).
	 */
	settledFalse(hearing: Hearing, asked: boolean): void {
		this.#hearing = undefined
		const cell = hearing.cell
		invariant(
			this.#editor.version === hearing.version,
			`a rule that settles false at node ${cell.id} changes nothing`
		)
		this.#pop()
		this.#queued.delete(cell)
		if (asked || hearing.whole || this.#editor.draws !== hearing.draws) {
			this.#again.push(cell)
			return
		}
		this.#epoch++
		const epoch = this.#epoch
		this.#quiet.set(cell, epoch)
		for (const read of hearing.subtree) {
			this.#bySubtree.getOrInsertComputed(read, () => new Map()).set(cell, epoch)
		}
		for (const read of hearing.reach) {
			this.#byReach.getOrInsertComputed(read.id, () => new Map()).set(cell, epoch)
		}
	}

	/**
	 * The state's scan ended, at a rule that fired at the cell it judged last, which stays queued, or with no cell left.
	 * The cells that asked are queued again for the next state.
	 */
	ended(): void {
		this.#hearing = undefined
		const again = this.#again
		this.#again = []
		for (const cell of again) {
			this.#queue(cell)
		}
	}
}

/** Whether two sets of cells hold the same cells. */
const sameCells = (a: ReadonlySet<Cell>, b: ReadonlySet<Cell>): boolean =>
	a.size === b.size && [...a].every((cell) => b.has(cell))
