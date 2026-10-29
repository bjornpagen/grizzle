/**
 * The one fold engine over a graph of direct references: a node's value from its inputs' values, every node once.
 *
 * A step is a generator: it yields each input whose value it reads and receives that value back, and returns its own.
 * The engine keeps its frames on the heap, a linked chain of suspended steps, so a fold of any depth (a 50,000-node
 * chain) never deepens the call stack. A value it has computed is kept for the life of the fold, keyed by the node
 * itself: a node read twice is computed once. That memo is the traversal's state, as a walk's seen-set is, and lives
 * exactly as long as the Fold value its caller holds; it is no cache.
 *
 * The graph is acyclic: an immutable node holds only nodes built before it (rel.ts RelNode), an expression only its
 * arguments, and an editor checks its cells for a cycle before it folds them (dag.ts finishCells). A miss in the memo
 * means "not computed yet": the engine opens a frame for it, never a defect.
 */
export type FoldStep<V, A> = (vertex: V) => Generator<V, A, A>

/** A suspended step: the vertex it computes, its generator, and the step waiting on its value. */
interface Frame<V, A> {
	readonly vertex: V
	readonly step: Generator<V, A, A>
	readonly parent: Frame<V, A> | undefined
}

/** A value the fold computed, boxed so a value that is itself undefined is told from a miss. */
interface Computed<A> {
	readonly value: A
}

export class Fold<V, A> {
	readonly #open: FoldStep<V, A>
	readonly #values = new Map<V, Computed<A>>()

	constructor(open: FoldStep<V, A>) {
		this.#open = open
	}

	/** The value of `root`: computed now, its inputs first, or kept from earlier in this fold. */
	of(root: V): A {
		const known = this.#values.get(root)
		if (known !== undefined) {
			return known.value
		}
		let frame: Frame<V, A> = { vertex: root, step: this.#open(root), parent: undefined }
		let sent: Computed<A> | undefined
		for (;;) {
			const next = sent === undefined ? frame.step.next() : frame.step.next(sent.value)
			if (next.done === true) {
				const computed: Computed<A> = { value: next.value }
				this.#values.set(frame.vertex, computed)
				if (frame.parent === undefined) {
					return next.value
				}
				frame = frame.parent
				sent = computed
			} else {
				const input = next.value
				const memo = this.#values.get(input)
				if (memo === undefined) {
					frame = { vertex: input, step: this.#open(input), parent: frame }
					sent = undefined
				} else {
					sent = memo
				}
			}
		}
	}
}

/**
 * The value a generator returns when each value it yields is answered by `answer` at once: a structural map (rel.ts
 * mapNode, expr.ts mapArgs) run without a fold.
 */
export const drive = <Y, T, N>(gen: Generator<Y, T, N>, answer: (yielded: Y) => N): T => {
	let next = gen.next()
	while (next.done !== true) {
		next = gen.next(answer(next.value))
	}
	return next.value
}
