/**
 * Native list lookups whose absence is `undefined`, never the -1 sentinel Array.prototype.findIndex answers.
 *
 * The index of the first element `test` holds of, or undefined when it holds of none.
 */
export const firstIndex = <A>(
	xs: ReadonlyArray<A>,
	test: (a: A, i: number) => boolean
): number | undefined => {
	const i = xs.findIndex(test)
	return i < 0 ? undefined : i
}

/** Whether two lists hold the same elements in the same order. */
export const sameOrder = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean =>
	a === b || (a.length === b.length && a.every((x, i) => x === b[i]))

/** Whether two lists of distinct elements hold the same elements, in any order. */
export const sameMembers = <A>(a: ReadonlyArray<A>, b: ReadonlyArray<A>): boolean =>
	a.length === b.length && a.every((x) => b.includes(x))

/** The indices 0 to n - 1, none for n of zero. */
export const indices = (n: number): ReadonlyArray<number> => {
	const out: Array<number> = []
	for (let i = 0; i < n; i++) {
		out.push(i)
	}
	return out
}
