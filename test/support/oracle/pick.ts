import { Array as Arr } from "effect"

/** The indices 0 .. n - 1 of a list of `n` elements, none when `n` is zero. */
export const indices = (n: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let i = 0; i < n; i++) {
		out.push(i)
	}
	return out
}

/** The elements of `xs` at the indices `keep` holds of, in order. */
export const whereIndex = <A>(xs: ReadonlyArray<A>, keep: (i: number) => boolean): Array<A> =>
	Arr.flatMap(xs, (x, i) => (keep(i) ? [x] : []))

/** The list itself, which the generator built with at least one element. */
export const nonEmptyList = <A>(
	items: ReadonlyArray<A>,
	what: string
): Arr.NonEmptyReadonlyArray<A> => {
	if (!Arr.isReadonlyArrayNonEmpty(items)) {
		throw new Error(`${what} has no element`)
	}
	return items
}

/**
 * Reading generated lists and maps at positions and keys the generators computed.
 *
 * A sketch picks from a list by an index it reduces modulo the list's length, and a generator reads back what it built
 * under a key it chose, so a miss is a defect of the generator, never a property of the case: each read here throws
 * rather than hand on an undefined.
 *
 * The element at `index`, which the caller has bounded.
 */
export const elementAt = <A>(items: ReadonlyArray<A>, index: number, what: string): A => {
	const item = items[index]
	if (item === undefined) {
		throw new Error(`${what} has no element ${index} of ${items.length}`)
	}
	return item
}

/** The element at `index` reduced modulo the list's length: how a sketch picks from a nonempty list. */
export const cyclicAt = <A>(items: ReadonlyArray<A>, index: number, what: string): A =>
	elementAt(items, index % items.length, what)

/** cyclicAt of the generators' pick from a sketch's list. */
export const at = <A>(items: ReadonlyArray<A>, index: number): A =>
	cyclicAt(items, index, "a generated list")

/** What `record` holds under `key`, which the generator put there. */
export const recordEntryOf = <V>(
	record: Readonly<Record<string, V>>,
	key: string,
	what: string
): V => {
	const value = record[key]
	if (value === undefined) {
		throw new Error(`${what} holds nothing under ${key}`)
	}
	return value
}

/** What `map` holds under `key`, which the generator put there. */
export const entryOf = <K, V>(map: ReadonlyMap<K, V>, key: K, what: string): V => {
	const value = map.get(key)
	if (value === undefined) {
		throw new Error(`${what} holds nothing under ${String(key)}`)
	}
	return value
}
