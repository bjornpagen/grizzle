/**
 * Native comparators, `(a, b) => number` as Array.prototype.sort takes them: negative when `a` comes first, zero when
 * the two tie, positive when `b` comes first. Strings compare by UTF-16 code unit, never by locale.
 */
export type Comparator<A> = (a: A, b: A) => number

/** The directions an order reads a key in: ascending, then descending. */
export const directions = ["asc", "desc"] as const
export type Direction = (typeof directions)[number]

/** The other direction: a key read backwards. */
export const opposite = (direction: Direction): Direction => (direction === "asc" ? "desc" : "asc")

/** Strings by UTF-16 code unit. */
export const compareStrings: Comparator<string> = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

/** Numbers ascending. */
export const compareNumbers: Comparator<number> = (a, b) => (a === b ? 0 : a < b ? -1 : 1)

/** Booleans, false before true. */
export const compareBooleans: Comparator<boolean> = (a, b) => (a === b ? 0 : a ? 1 : -1)

/** `compare` applied to what `f` reads of each value. */
export const mapInput =
	<A, B>(compare: Comparator<B>, f: (a: A) => B): Comparator<A> =>
	(a, b) =>
		compare(f(a), f(b))

/** `first`, and `second` where `first` ties. */
export const thenBy =
	<A>(first: Comparator<A>, second: Comparator<A>): Comparator<A> =>
	(a, b) => {
		const order = first(a, b)
		return order === 0 ? second(a, b) : order
	}

/** Each comparator in turn, the next one deciding where every one before it ties. */
export const combineAll =
	<A>(comparators: ReadonlyArray<Comparator<A>>): Comparator<A> =>
	(a, b) => {
		for (const compare of comparators) {
			const order = compare(a, b)
			if (order !== 0) {
				return order
			}
		}
		return 0
	}

export const flip =
	<A>(compare: Comparator<A>): Comparator<A> =>
	(a, b) =>
		compare(b, a)

/** Whether `items` already stand in `compare`'s order: no item after one it comes before. */
const inOrder = <A>(items: ReadonlyArray<A>, compare: Comparator<A>): boolean => {
	for (let i = 1; i < items.length; i += 1) {
		const previous = items[i - 1]
		const item = items[i]
		if (previous !== undefined && item !== undefined && compare(previous, item) > 0) {
			return false
		}
	}
	return true
}

/**
 * `items` in `compare`'s order, as a stable sort leaves them: sorted in place, unless they already stand in it, which
 * one pass of n - 1 comparisons finds, so a list that arrives in order, as normal facts do when they are normalized
 * again, costs no sort. A list already in order is the order a stable sort would leave it in, ties included.
 */
export const sortInPlace = <A>(items: Array<A>, compare: Comparator<A>): Array<A> => {
	if (!inOrder(items, compare)) {
		items.sort(compare)
	}
	return items
}
