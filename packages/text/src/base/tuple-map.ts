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
class Slot<K, V> {
	readonly key: K
	value: V
	constructor(key: K, value: V) {
		this.key = key
		this.value = value
	}
}

/**
 * A position of the trie that two or more keys pass: the entry of each next element's keys, a slot where only one key
 * holds that element there and a branch where several do, and the entry of the key that ends here, none where none does.
 */
class Branch<K extends ReadonlyArray<unknown>, V> {
	readonly children = new Map<K[number], Branch<K, V> | Slot<K, V>>()
	end: Slot<K, V> | undefined = undefined
}

/** Whether two keys hold equal elements from `from` on, each pair as a Map compares its keys (SameValueZero). */
const sameFrom = (a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>, from: number): boolean => {
	if (a.length !== b.length) {
		return false
	}
	for (let i = from; i < a.length; i += 1) {
		const x = a[i]
		const y = b[i]
		if (
			x !== y &&
			!(typeof x === "number" && typeof y === "number" && Number.isNaN(x) && Number.isNaN(y))
		) {
			return false
		}
	}
	return true
}

/**
 * A map keyed by tuples, structurally: two keys are one exactly when they hold equal elements in order, each pair equal
 * as a native Map compares its keys (SameValueZero), whatever array holds them. A key walks a trie, one Map step per
 * element the keys before it share, so no key is ever joined into one text: a key costs at most its arity in steps,
 * never its elements' lengths in characters, and no hash stands in for an element, so no two keys are ever merged. The
 * trie branches only where two keys share a prefix: a key whose next element no other key shares there is held whole
 * in one slot, its remaining elements compared on a lookup, so a key no other shares a first element with costs one
 * Map entry. Iteration is in insertion order, each key as it was first set, and an entry set again keeps its place, as
 * a Map's does.
 */
export class TupleMap<K extends ReadonlyArray<unknown>, V> implements ReadonlyTupleMap<K, V> {
	readonly #root = new Branch<K, V>()
	readonly #slots = new Set<Slot<K, V>>()

	/** The entry of `key`, none where the map holds no such key. */
	#found(key: K): Slot<K, V> | undefined {
		let node = this.#root
		for (let depth = 0; depth < key.length; depth += 1) {
			const child = node.children.get(key[depth])
			if (child === undefined) {
				return undefined
			}
			if (child instanceof Slot) {
				return sameFrom(child.key, key, depth + 1) ? child : undefined
			}
			node = child
		}
		return node.end
	}

	get size(): number {
		return this.#slots.size
	}

	get(key: K): V | undefined {
		return this.#found(key)?.value
	}

	has(key: K): boolean {
		return this.#found(key) !== undefined
	}

	/** The value held at `key`, made by `compute` and set first where none is: Map.prototype.getOrInsertComputed's. */
	getOrInsertComputed(key: K, compute: (key: K) => V): V {
		const held = this.#found(key)
		if (held !== undefined) {
			return held.value
		}
		const value = compute(key)
		this.set(key, value)
		return value
	}

	/** A new entry, last in iteration order. */
	#added(key: K, value: V): Slot<K, V> {
		const slot = new Slot(key, value)
		this.#slots.add(slot)
		return slot
	}

	set(key: K, value: V): this {
		let node = this.#root
		let depth = 0
		while (depth < key.length) {
			const element = key[depth]
			const child = node.children.get(element)
			if (child === undefined) {
				node.children.set(element, this.#added(key, value))
				return this
			}
			if (child instanceof Branch) {
				node = child
				depth += 1
				continue
			}
			if (sameFrom(child.key, key, depth + 1)) {
				child.value = value
				return this
			}
			/** Two keys share this element: the one held here moves one element down, under a branch the walk goes on in. */
			const branch = new Branch<K, V>()
			depth += 1
			if (child.key.length === depth) {
				branch.end = child
			} else {
				branch.children.set(child.key[depth], child)
			}
			node.children.set(element, branch)
			node = branch
		}
		if (node.end === undefined) {
			node.end = this.#added(key, value)
		} else {
			node.end.value = value
		}
		return this
	}

	/** Removes the entry of `key`: whether there was one. */
	delete(key: K): boolean {
		let node = this.#root
		for (let depth = 0; depth < key.length; depth += 1) {
			const element = key[depth]
			const child = node.children.get(element)
			if (child === undefined) {
				return false
			}
			if (child instanceof Slot) {
				if (!sameFrom(child.key, key, depth + 1)) {
					return false
				}
				node.children.delete(element)
				this.#slots.delete(child)
				return true
			}
			node = child
		}
		const slot = node.end
		if (slot === undefined) {
			return false
		}
		node.end = undefined
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
