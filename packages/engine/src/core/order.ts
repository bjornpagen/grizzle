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
export const combine =
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
