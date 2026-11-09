/**
 * `f` of each index 0 … n − 1: n elements, none for a count of 0.
 *
 * Effect's Array.makeBy normalizes its count to at least 1, so over a count that can be 0 it makes one element, a
 * generator that draws 0 never draws its empty case, and nothing says so. A count no positive literal states goes here
 * (the testing plugin's no-clamped-count rule).
 */
export const upTo = <A>(n: number, f: (i: number) => A): Array<A> => {
	const out: Array<A> = []
	for (let i = 0; i < n; i += 1) {
		out.push(f(i))
	}
	return out
}
