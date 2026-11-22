import { defined, invariant } from "@bjornpagen/grizzle-text/base/invariant"
import type { Cell } from "#compiler/ir/rel.ts"

/**
 * A reached cell's place in the kept order (KeptOrder): its label, which orders it among the reached cells, its
 * neighbours there, and the walk's tree it lies in: the cell whose edge first reached it (none for a cell first reached
 * as a root), that edge's index (the root's, for a root), the first cell of its segment (the cells first reached through
 * it, then it: a contiguous run of the order ending at it), and the edges the walk followed out of it.
 */
interface Place {
	readonly cell: Cell
	label: number
	prev: Place | undefined
	next: Place | undefined
	parent: Cell | undefined
	via: number
	first: Cell
	edges: ReadonlyArray<Cell>
}

/**
 * One frame of a patching run (KeptOrder #run): the roots, or a cell, with the edges it follows and the next one, and the
 * parent and edge that reached it.
 *
 * - `walked`: a frame the run opened itself, a changed cell or one no block covers, whose segment's first cell is the
 *   first item laid down since it opened (`start`, an index of the run's items), or itself where none was.
 * - `kept`: a frame of an unchanged cell whose walk reached the run, opened again as the run returns to it, continuing
 *   from the edge after the one that reached the run. Its segment begins where it began before the run (`before`), or,
 *   where it began with the run, with the run's first item.
 */
type Frame =
	| {
			readonly kind: "walked"
			readonly cell: Cell | undefined
			readonly edges: ReadonlyArray<Cell>
			next: number
			readonly start: number
			readonly parent: Cell | undefined
			readonly via: number
	  }
	| {
			readonly kind: "kept"
			readonly cell: Cell | undefined
			readonly edges: ReadonlyArray<Cell>
			next: number
			readonly first: { readonly kind: "before"; readonly cell: Cell } | { readonly kind: "run" }
			readonly parent: Cell | undefined
			readonly via: number
	  }

/**
 * What a patching run lays down, in order: a cell it walked, with its parent, edge and segment's first cell, or a block,
 * a segment of the kept order taken whole, whose walk the run would repeat step for step, its top cell reached from
 * `parent` at `via`.
 */
type Item =
	| {
			readonly kind: "cell"
			readonly cell: Cell
			readonly parent: Cell | undefined
			readonly via: number
			readonly first: Cell
	  }
	| {
			readonly kind: "block"
			readonly place: Place
			readonly parent: Cell | undefined
			readonly via: number
	  }

/** A run of places the patch links in: a walked cell's own place, or a block's first and top places. */
interface Laid {
	readonly head: Place
	readonly tail: Place
	readonly kind: "block" | "cell"
}

/** Whether two lists of edges name the same cells in the same order. */
const sameEdges = (a: ReadonlyArray<Cell>, b: ReadonlyArray<Cell>): boolean =>
	a.length === b.length && a.every((c, i) => c === b[i])

/**
 * The cells a set of roots reach, in topological order, inputs first, kept as the cells' edges change: the order every
 * state of a rewrite pass reads its cells in (DagEditor cellState), patched where an edit changed it.
 *
 * The order is a walk's postorder (ir/dag.ts topoOrder's): from each root in order, depth first over each cell's edges in
 * order, a cell ending after the cells first reached through it, a cell reached again followed no further, a cell met
 * again while its walk is open (a cycle a rewrite made, which finish refuses) followed no further either. It is a
 * function of the roots and the edges, and each cell's segment is fixed by the edge that first reaches it and what was
 * reached before that edge.
 *
 * So a change of some cells' edges is patched by one run of the walk from the first place it could go another way: the
 * first cell of the segment of the changed cell whose segment starts first, the outermost of those starting there.
 * Before it the walk is the same. The run walks each changed cell over its new edges, and takes each kept segment it
 * reaches whole, as a block, wherever the walk would repeat it step for step: no changed cell lies in it, the run reached
 * none of its cells yet, and every kept cell before it is accounted for (reached by the run, or reached by no root now),
 * so every cell its walk meets outside it is reached already, as it was then. The run ends where the walk is back in
 * step with the kept order: in the frame of a cell it did not change, the cell it just ended reached by the same edge as
 * before and lying at the next kept place, with no kept cell reached ahead of its place and no changed cell left to walk.
 * From there the kept order is the walk's. A run's cost is the cells it walks and the blocks it takes, not the order's.
 *
 * Each place carries a label, the order's sort key: a block keeps its labels, and a cell the run walks takes a label in
 * the gap between the blocks and kept cells around it; the whole order is labelled again only when a gap holds no free
 * label.
 */
export class KeptOrder {
	readonly #places = new Map<Cell, Place>()
	#head: Place | undefined
	/** The roots the order was walked from. */
	#roots: ReadonlyArray<Cell>
	/** What each cell's node reads through its edges now. */
	readonly #edgesOf: (cell: Cell) => ReadonlyArray<Cell>
	/** Whether a root reaches the cell now (the editor's reach), so a kept cell no longer reached leaves the order. */
	readonly #reached: (cell: Cell) => boolean
	/** Bumped by every patch that changes the order: an order read at one generation is read only at that one. */
	#generation = 0
	/**
	 * The edges the last whole walk met to a cell whose walk was open: a cycle a rewrite made, over which a run's
	 * reasoning (each segment's walk repeated where nothing it meets moved) does not hold, so every patch walks whole
	 * while the last whole walk met one.
	 */
	#backEdges = 0

	constructor(
		roots: ReadonlyArray<Cell>,
		edgesOf: (cell: Cell) => ReadonlyArray<Cell>,
		reached: (cell: Cell) => boolean
	) {
		this.#roots = roots
		this.#edgesOf = edgesOf
		this.#reached = reached
		this.#walk()
	}

	/** The order's generation (#generation). */
	get generation(): number {
		return this.#generation
	}

	/** The reached cells in order, as they stand at `generation`, which must be the order's own. */
	cells(generation: number): ReadonlyArray<Cell> {
		return this.read(generation, () => false).order
	}

	/**
	 * The reached cells in order, as they stand at `generation`, which must be the order's own, and those of them `feeds`
	 * finds on a recursive step as each is read, its inputs before it: given a cell, the edges the walk followed out of it
	 * and the cells found so far (editor.ts readsFeedback).
	 */
	read(
		generation: number,
		feeds: (cell: Cell, edges: ReadonlyArray<Cell>, found: ReadonlySet<Cell>) => boolean
	): { readonly order: ReadonlyArray<Cell>; readonly feedback: ReadonlySet<Cell> } {
		invariant(
			generation === this.#generation,
			"a state's order is read before the next state patches the kept order"
		)
		const order: Array<Cell> = []
		const feedback = new Set<Cell>()
		for (let at = this.#head; at !== undefined; at = at.next) {
			order.push(at.cell)
			if (feeds(at.cell, at.edges, feedback)) {
				feedback.add(at.cell)
			}
		}
		return { order, feedback }
	}

	/** Whether a root reaches `cell`: the order holds it. */
	has(cell: Cell): boolean {
		return this.#places.has(cell)
	}

	/** The label that orders `cell` among the reached cells: an earlier cell's is lower. */
	label(cell: Cell): number {
		return this.#placeOf(cell).label
	}

	#placeOf(cell: Cell): Place {
		return defined(this.#places.get(cell), "a cell the kept order holds")
	}

	/**
	 * The order patched to the roots `roots` and each cell's edges now, `touched` holding every cell whose node changed
	 * since the last patch: the cells it placed anew or labelled again, which a reader keyed by the labels takes again.
	 */
	patch(roots: ReadonlyArray<Cell>, touched: Iterable<Cell>): ReadonlyArray<Cell> {
		const changed = new Set<Cell>()
		for (const cell of touched) {
			const place = this.#places.get(cell)
			if (
				place !== undefined &&
				this.#reached(cell) &&
				!sameEdges(place.edges, this.#edgesOf(cell))
			) {
				changed.add(cell)
			}
		}
		const rootsMoved = !sameEdges(this.#roots, roots)
		this.#roots = roots
		if (changed.size === 0 && !rootsMoved) {
			return []
		}
		this.#generation++
		const head = this.#head
		const run =
			head === undefined || this.#backEdges > 0
				? undefined
				: rootsMoved
					? this.#run(undefined, head, changed)
					: this.#runFrom(this.#outermost(changed), changed)
		if (run === undefined) {
			this.#places.clear()
			this.#walk()
			return [...this.#places.keys()]
		}
		return run
	}

	/** The changed cell whose segment starts first in the order, the outermost of those starting at one place. */
	#outermost(changed: ReadonlySet<Cell>): Place {
		let best: { readonly place: Place; readonly first: number } | undefined
		for (const cell of changed) {
			const place = this.#placeOf(cell)
			const first = this.#placeOf(place.first).label
			if (
				best === undefined ||
				first < best.first ||
				(first === best.first && place.label > best.place.label)
			) {
				best = { place, first }
			}
		}
		return defined(best, "a changed cell").place
	}

	/** The run from the changed cell `start`'s segment (#run). */
	#runFrom(start: Place, changed: ReadonlySet<Cell>): ReadonlyArray<Cell> | undefined {
		return this.#run(start, this.#placeOf(start.first), changed)
	}

	/**
	 * The walk of every reached cell from the roots, placing each anew, labelled in order (#relabel).
	 */
	#walk(): void {
		const order: Array<Place> = []
		const open = new Set<Cell>()
		const stack: Array<{ readonly place: Place; readonly start: number; next: number }> = []
		this.#backEdges = 0
		for (const [index, root] of this.#roots.entries()) {
			if (this.#places.has(root)) {
				continue
			}
			stack.push({ place: this.#fresh(root, undefined, index), start: order.length, next: 0 })
			open.add(root)
			for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
				const input = frame.place.edges[frame.next]
				if (input === undefined) {
					stack.pop()
					open.delete(frame.place.cell)
					frame.place.first = order[frame.start]?.cell ?? frame.place.cell
					order.push(frame.place)
					continue
				}
				frame.next++
				if (open.has(input)) {
					this.#backEdges++
				}
				if (!this.#places.has(input)) {
					stack.push({
						place: this.#fresh(input, frame.place.cell, frame.next - 1),
						start: order.length,
						next: 0
					})
					open.add(input)
				}
			}
		}
		this.#head = order[0]
		for (const [i, place] of order.entries()) {
			place.prev = order[i - 1]
			place.next = order[i + 1]
		}
		this.#relabel()
	}

	/** A new place for `cell`, reached from `parent` at `via`, over its edges now, before the order links it. */
	#fresh(cell: Cell, parent: Cell | undefined, via: number): Place {
		const place: Place = {
			cell,
			label: 0,
			prev: undefined,
			next: undefined,
			parent,
			via,
			first: cell,
			edges: this.#edgesOf(cell)
		}
		this.#places.set(cell, place)
		return place
	}

	/**
	 * Every place labelled again, in order, the labels spread evenly over the safe integers, so each gap holds as many
	 * free labels as the order's size leaves.
	 */
	#relabel(): void {
		const step = Math.floor(Number.MAX_SAFE_INTEGER / (this.#places.size + 2))
		let label = 0
		for (let at = this.#head; at !== undefined; at = at.next) {
			label += step
			at.label = label
		}
	}

	/**
	 * The run that patches the order for the changed cells `changed` (KeptOrder) from `lo`: the first place of the segment
	 * of `start`, or, where the roots moved (`start` none), the order's first place. The cells it placed anew or labelled
	 * again; undefined where the walk meets a cell whose walk is open, a cycle a rewrite made, or ends with a kept cell
	 * the editor's reach still counts as reached though no walk from the roots reaches it (a cycle no root reaches keeps
	 * its own references), each of which the whole walk orders as topoOrder does.
	 */
	#run(
		start: Place | undefined,
		lo: Place,
		changed: ReadonlySet<Cell>
	): ReadonlyArray<Cell> | undefined {
		const before = lo.prev
		const loLabel = lo.label
		/** Whether a kept cell's walk is open around the run: an ancestor of `start`, its segment holding the run's first place. */
		const encloses = (place: Place): boolean =>
			start !== undefined &&
			place.label > start.label &&
			this.#placeOf(place.first).label <= loLabel
		const remaining = new Set(changed)
		/** The kept cells the run ended ahead of the cursor, with the least and greatest of their labels. */
		const pending = new Set<Place>()
		let pendingLow = Number.POSITIVE_INFINITY
		let pendingHigh = Number.NEGATIVE_INFINITY
		/** The cells whose walk the run has open, and those it ended. */
		const open = new Set<Cell>()
		const ended = new Set<Cell>()
		const dropped: Array<Place> = []
		const items: Array<Item> = []
		const stack: Array<Frame> = []
		/** The first kept place not accounted for yet: reached by the run, or reached by no root now. */
		let cursor: Place | undefined = lo
		/** The kept frame the run returns to once its stack is empty, the cell that reached the last one it left. */
		let above: { readonly parent: Cell | undefined; readonly via: number } | undefined

		if (start === undefined) {
			stack.push({
				kind: "walked",
				cell: undefined,
				edges: this.#roots,
				next: 0,
				start: 0,
				parent: undefined,
				via: 0
			})
		} else {
			remaining.delete(start.cell)
			open.add(start.cell)
			stack.push({
				kind: "walked",
				cell: start.cell,
				edges: this.#edgesOf(start.cell),
				next: 0,
				start: 0,
				parent: start.parent,
				via: start.via
			})
			above = { parent: start.parent, via: start.via }
		}

		/** The cursor moved past every kept cell the run ended ahead of it or no root reaches now. */
		const settle = (): void => {
			for (; cursor !== undefined; cursor = cursor.next) {
				if (pending.delete(cursor)) {
					continue
				}
				if (this.#reached(cursor.cell)) {
					return
				}
				dropped.push(cursor)
			}
		}
		/** Whether the place of some cell of `cells` lies between the labels `low` and `high`. */
		const within = (cells: Iterable<Cell>, low: number, high: number): boolean => {
			for (const cell of cells) {
				const place = this.#places.get(cell)
				if (place !== undefined && place.label >= low && place.label <= high) {
					return true
				}
			}
			return false
		}
		/**
		 * Whether the walk reached `cell` already, before the run or in it: a kept cell before the cursor is accounted for,
		 * and a root reaches it, so the run or the walk before it reached it. A cycle where its walk is open: the run's own,
		 * or a kept cell whose segment holds the run's first place, whose walk is open around the run.
		 */
		const seen = (cell: Cell): boolean | "cycle" => {
			if (open.has(cell)) {
				return "cycle"
			}
			if (ended.has(cell)) {
				return true
			}
			const place = this.#places.get(cell)
			if (place === undefined) {
				return false
			}
			if (cursor === undefined || place.label < cursor.label) {
				return true
			}
			return encloses(place) ? "cycle" : false
		}
		/** Whether the walk would repeat `place`'s kept segment step for step (KeptOrder); a cycle where it holds an open cell. */
		const block = (place: Place): boolean | "cycle" => {
			settle()
			if (cursor === undefined || cursor.cell !== place.first || remaining.has(place.cell)) {
				return false
			}
			const low = cursor.label
			const high = place.label
			if (within(open, low, high)) {
				return "cycle"
			}
			if (within(remaining, low, high)) {
				return false
			}
			return !(
				pendingLow <= high &&
				pendingHigh >= low &&
				within(
					[...pending].map((p) => p.cell),
					low,
					high
				)
			)
		}
		/** The kept cell `place`, ended by the run: whether at the cursor (the cursor moves past it) or ahead of it. */
		const passed = (place: Place): boolean => {
			settle()
			if (cursor === place) {
				cursor = place.next
				return true
			}
			pending.add(place)
			pendingLow = Math.min(pendingLow, place.label)
			pendingHigh = Math.max(pendingHigh, place.label)
			return false
		}
		/**
		 * Whether the walk is back in step with the kept order (KeptOrder) once the kept cell `place`, reached from `parent`
		 * at `via`, has ended at the cursor, in the frame `frame` (undefined: the kept frame the run returns to next).
		 */
		const inStep = (
			place: Place,
			parent: Cell | undefined,
			via: number,
			frame: Frame | undefined
		): boolean =>
			remaining.size === 0 &&
			pending.size === 0 &&
			place.parent === parent &&
			place.via === via &&
			(frame === undefined ? above !== undefined : frame.kind === "kept")
		/** The run's items laid down in place of the kept cells from `lo` to the cursor (#splice). */
		const spliced = (): ReadonlyArray<Cell> => {
			const bottom = stack[0]
			const keptAbove = bottom === undefined ? above?.parent : bottom.cell
			return this.#splice(before, cursor, items, dropped, lo.cell, keptAbove)
		}

		for (;;) {
			const frame = stack.at(-1)
			if (frame === undefined) {
				if (above === undefined) {
					break
				}
				const parent = above.parent
				if (parent === undefined) {
					stack.push({
						kind: "kept",
						cell: undefined,
						edges: this.#roots,
						next: above.via + 1,
						first: { kind: "run" },
						parent: undefined,
						via: 0
					})
					above = undefined
				} else {
					const place = this.#placeOf(parent)
					const first = this.#placeOf(place.first)
					stack.push({
						kind: "kept",
						cell: parent,
						edges: place.edges,
						next: above.via + 1,
						first: first.label < loLabel ? { kind: "before", cell: first.cell } : { kind: "run" },
						parent: place.parent,
						via: place.via
					})
					above = { parent: place.parent, via: place.via }
				}
				continue
			}
			const input = frame.edges[frame.next]
			if (input === undefined) {
				stack.pop()
				const cell = frame.cell
				if (cell === undefined) {
					break
				}
				open.delete(cell)
				ended.add(cell)
				items.push({
					kind: "cell",
					cell,
					parent: frame.parent,
					via: frame.via,
					first: this.#firstOf(frame, items, cell)
				})
				const place = this.#places.get(cell)
				if (
					place !== undefined &&
					passed(place) &&
					inStep(place, frame.parent, frame.via, stack.at(-1))
				) {
					return spliced()
				}
				continue
			}
			frame.next++
			const met = seen(input)
			if (met === "cycle") {
				return undefined
			}
			if (met) {
				continue
			}
			const via = frame.next - 1
			const place = this.#places.get(input)
			if (place !== undefined) {
				const whole = block(place)
				if (whole === "cycle") {
					return undefined
				}
				if (whole) {
					items.push({ kind: "block", place, parent: frame.cell, via })
					cursor = place.next
					if (inStep(place, frame.cell, via, frame)) {
						return spliced()
					}
					continue
				}
			}
			remaining.delete(input)
			open.add(input)
			stack.push({
				kind: "walked",
				cell: input,
				edges: this.#edgesOf(input),
				next: 0,
				start: items.length,
				parent: frame.cell,
				via
			})
		}
		settle()
		return cursor === undefined
			? this.#splice(before, undefined, items, dropped, lo.cell, undefined)
			: undefined
	}

	/**
	 * The first cell of the segment of `cell`, whose frame `frame` just ended with the run's items `items` laid down: a
	 * kept frame's where it began before the run, else the first cell of the first item laid down since the frame opened
	 * (a cell walked first has no segment of its own before it), else the cell itself.
	 */
	#firstOf(frame: Frame, items: ReadonlyArray<Item>, cell: Cell): Cell {
		if (frame.kind === "kept" && frame.first.kind === "before") {
			return frame.first.cell
		}
		const item = items[frame.kind === "kept" ? 0 : frame.start]
		return item === undefined ? cell : item.kind === "cell" ? item.cell : item.place.first
	}

	/**
	 * The run's items laid down between `before` and `after` (none: the order's ends), in place of the kept cells between
	 * them; `dropped` the kept cells no root reaches now. `loCell` was the first cell of the replaced places, which a kept
	 * segment holding the run still names as its first: each such cell, from `keptAbove` (the lowest kept cell whose walk
	 * holds the run) up, takes the run's first cell as its first. The cells placed anew or labelled again.
	 */
	#splice(
		before: Place | undefined,
		after: Place | undefined,
		items: ReadonlyArray<Item>,
		dropped: ReadonlyArray<Place>,
		loCell: Cell,
		keptAbove: Cell | undefined
	): ReadonlyArray<Cell> {
		const moved: Array<Cell> = []
		const laid: Array<Laid> = []
		for (const item of items) {
			if (item.kind === "block") {
				item.place.parent = item.parent
				item.place.via = item.via
				laid.push({ head: this.#placeOf(item.place.first), tail: item.place, kind: "block" })
				continue
			}
			const place = this.#places.get(item.cell) ?? this.#fresh(item.cell, item.parent, item.via)
			place.parent = item.parent
			place.via = item.via
			place.first = item.first
			place.edges = this.#edgesOf(item.cell)
			moved.push(item.cell)
			laid.push({ head: place, tail: place, kind: "cell" })
		}
		const newFirst = laid[0]?.head.cell
		if (newFirst !== undefined && newFirst !== loCell) {
			for (let up = keptAbove; up !== undefined;) {
				const place = this.#placeOf(up)
				if (place.first !== loCell) {
					break
				}
				place.first = newFirst
				up = place.parent
			}
		}
		for (const place of dropped) {
			this.#places.delete(place.cell)
		}
		let prev = before
		for (const { head, tail } of laid) {
			head.prev = prev
			if (prev === undefined) {
				this.#head = head
			} else {
				prev.next = head
			}
			prev = tail
		}
		if (prev === undefined) {
			this.#head = after
		} else {
			prev.next = after
		}
		if (after !== undefined) {
			after.prev = prev
		}
		if (!this.#labelled(before, laid, after)) {
			this.#relabel()
			return [...this.#places.keys()]
		}
		return moved
	}

	/**
	 * Labels for the places `laid` between `before` and `after`: a block keeps its labels, and the walked cells between two
	 * blocks take labels spread evenly in the gap between them. False where a gap is too narrow for its cells.
	 */
	#labelled(
		before: Place | undefined,
		laid: ReadonlyArray<Laid>,
		after: Place | undefined
	): boolean {
		let low = before?.label ?? 0
		let gap: Array<Place> = []
		const spread = (high: number): boolean => {
			const step = (high - low) / (gap.length + 1)
			if (gap.length > 0 && step < 1) {
				return false
			}
			for (const [i, p] of gap.entries()) {
				p.label = Math.floor(low + step * (i + 1))
			}
			gap = []
			return true
		}
		for (const { head, tail, kind } of laid) {
			if (kind === "cell") {
				gap.push(head)
				continue
			}
			if (!spread(head.label)) {
				return false
			}
			low = tail.label
		}
		return spread(after?.label ?? Number.MAX_SAFE_INTEGER)
	}
}
