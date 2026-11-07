/** A TupleMap as its readers take it. */
export interface ReadonlyTupleMap<K extends ReadonlyArray<unknown>, V> extends Iterable<
	readonly [K, V]
> {
	readonly size: number
	get(key: K): V | undefined
	has(key: K): boolean
	keys(): IterableIterator<K>
	values(): IterableIterator<V>
}

/** An entry: its key as it was first set, and its value. */
interface Slot<K, V> {
	readonly key: K
	value: V
}

/** One position of the trie: the next element's nodes, and the entry of the key that ends here, none where none does. */
interface Trie<K extends ReadonlyArray<unknown>, V> {
	readonly children: Map<K[number], Trie<K, V>>
	slot: Slot<K, V> | undefined
}

const trie = <K extends ReadonlyArray<unknown>, V>(): Trie<K, V> => ({
	children: new Map(),
	slot: undefined
})

/**
 * A map keyed by tuples, structurally: two keys are one exactly when they hold equal elements in order, each pair equal
 * as a native Map compares its keys (SameValueZero), whatever array holds them. A key walks a trie, one Map step per
 * element, so no key is ever joined into one text: a key costs its arity in steps, never its elements' lengths in
 * characters, and no hash stands in for an element, so no two keys are ever merged. Iteration is in insertion order,
 * each key as it was first set, and an entry set again keeps its place, as a Map's does.
 */
export class TupleMap<K extends ReadonlyArray<unknown>, V> implements ReadonlyTupleMap<K, V> {
	readonly #root: Trie<K, V> = trie()
	readonly #slots = new Set<Slot<K, V>>()

	/** The trie node `key` ends at, none where no key passes it. */
	#found(key: K): Trie<K, V> | undefined {
		let node: Trie<K, V> | undefined = this.#root
		for (const element of key) {
			node = node.children.get(element)
			if (node === undefined) {
				return undefined
			}
		}
		return node
	}

	/** The trie node `key` ends at, each node on its way made where none is. */
	#reached(key: K): Trie<K, V> {
		let node = this.#root
		for (const element of key) {
			const child = node.children.get(element)
			const next = child ?? trie<K, V>()
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

	get(key: K): V | undefined {
		return this.#found(key)?.slot?.value
	}

	has(key: K): boolean {
		return this.#found(key)?.slot !== undefined
	}

	set(key: K, value: V): this {
		const node = this.#reached(key)
		if (node.slot === undefined) {
			const slot: Slot<K, V> = { key, value }
			node.slot = slot
			this.#slots.add(slot)
		} else {
			node.slot.value = value
		}
		return this
	}

	/** Removes the entry of `key`: whether there was one. */
	delete(key: K): boolean {
		const node = this.#found(key)
		const slot = node?.slot
		if (node === undefined || slot === undefined) {
			return false
		}
		node.slot = undefined
		this.#slots.delete(slot)
		return true
	}

	*keys(): IterableIterator<K> {
		for (const slot of this.#slots) {
			yield slot.key
		}
	}

	*values(): IterableIterator<V> {
		for (const slot of this.#slots) {
			yield slot.value
		}
	}

	*[Symbol.iterator](): IterableIterator<readonly [K, V]> {
		for (const slot of this.#slots) {
			yield [slot.key, slot.value]
		}
	}
}

/** A TupleSet as its readers take it. */
export interface ReadonlyTupleSet<K extends ReadonlyArray<unknown>> extends Iterable<K> {
	readonly size: number
	has(key: K): boolean
}

/**
 * A set of tuples, structurally, as TupleMap keys its entries: two tuples are one exactly when they hold equal elements
 * in order. Iteration is in insertion order, each tuple as it was first added.
 */
export class TupleSet<K extends ReadonlyArray<unknown>> implements ReadonlyTupleSet<K> {
	readonly #entries = new TupleMap<K, true>()

	get size(): number {
		return this.#entries.size
	}

	has(key: K): boolean {
		return this.#entries.has(key)
	}

	add(key: K): this {
		this.#entries.set(key, true)
		return this
	}

	/** Removes `key`: whether it was a member. */
	delete(key: K): boolean {
		return this.#entries.delete(key)
	}

	[Symbol.iterator](): IterableIterator<K> {
		return this.#entries.keys()
	}
}
