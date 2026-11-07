/** A TupleMap as its readers take it. */
export interface ReadonlyTupleMap<E, V> extends Iterable<readonly [ReadonlyArray<E>, V]> {
	readonly size: number
	get(key: ReadonlyArray<E>): V | undefined
	has(key: ReadonlyArray<E>): boolean
	keys(): IterableIterator<ReadonlyArray<E>>
	values(): IterableIterator<V>
}

/** An entry: its key as it was first set, and its value. */
interface Slot<E, V> {
	readonly key: ReadonlyArray<E>
	value: V
}

/** One position of the trie: the next element's nodes, and the entry of the key that ends here, none where none does. */
interface Trie<E, V> {
	readonly children: Map<E, Trie<E, V>>
	slot: Slot<E, V> | undefined
}

const trie = <E, V>(): Trie<E, V> => ({ children: new Map(), slot: undefined })

/**
 * A map keyed by tuples, structurally: two keys are one exactly when they hold equal elements in order, each pair equal
 * as a native Map compares its keys (SameValueZero), whatever array holds them. A key walks a trie, one Map step per
 * element, so no key is ever joined into one text: a key costs its arity in steps, never its elements' lengths in
 * characters, and no hash stands in for an element, so no two keys are ever merged. Iteration is in insertion order and
 * an entry set again keeps its place, as a Map's does.
 */
export class TupleMap<E, V> implements ReadonlyTupleMap<E, V> {
	readonly #root: Trie<E, V> = trie()
	readonly #slots = new Set<Slot<E, V>>()

	/** The trie node `key` ends at, none where no key passes it. */
	#found(key: ReadonlyArray<E>): Trie<E, V> | undefined {
		let node: Trie<E, V> | undefined = this.#root
		for (const element of key) {
			node = node.children.get(element)
			if (node === undefined) {
				return undefined
			}
		}
		return node
	}

	/** The trie node `key` ends at, each node on its way made where none is. */
	#reached(key: ReadonlyArray<E>): Trie<E, V> {
		let node = this.#root
		for (const element of key) {
			const child = node.children.get(element)
			const next = child ?? trie<E, V>()
			if (child === undefined) {
				node.children.set(element, next)
			}
			node = next
		}
		return node
	}

	get size(): number {
		return this.#slots.size
	}

	get(key: ReadonlyArray<E>): V | undefined {
		return this.#found(key)?.slot?.value
	}

	has(key: ReadonlyArray<E>): boolean {
		return this.#found(key)?.slot !== undefined
	}

	set(key: ReadonlyArray<E>, value: V): this {
		const node = this.#reached(key)
		if (node.slot === undefined) {
			const slot: Slot<E, V> = { key, value }
			node.slot = slot
			this.#slots.add(slot)
		} else {
			node.slot.value = value
		}
		return this
	}

	/** Removes the entry of `key`: whether there was one. */
	delete(key: ReadonlyArray<E>): boolean {
		const node = this.#found(key)
		const slot = node?.slot
		if (node === undefined || slot === undefined) {
			return false
		}
		node.slot = undefined
		this.#slots.delete(slot)
		return true
	}

	*keys(): IterableIterator<ReadonlyArray<E>> {
		for (const slot of this.#slots) {
			yield slot.key
		}
	}

	*values(): IterableIterator<V> {
		for (const slot of this.#slots) {
			yield slot.value
		}
	}

	*[Symbol.iterator](): IterableIterator<readonly [ReadonlyArray<E>, V]> {
		for (const slot of this.#slots) {
			yield [slot.key, slot.value]
		}
	}
}
