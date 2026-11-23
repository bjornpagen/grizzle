/** What the properties of least.test.ts read: their space and the brute-force model of the least exponents. */

import { array, boolean, type Gen, int, subset } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { Bound, ExponentSystem } from "#compiler/physical/statistics/least.ts"

export type LeastFeature =
	| "a system with a least solution"
	| "a crossing"
	| "an anchor above 1"
	| "a column above 1"
	| "two anchors"

/** A small system: one or two anchors, one to four columns, one to six bounds over them, each bound of its kind, its
 * anchor and a subset of the columns. */
export const systemGen: Gen<ExponentSystem> = (source) => {
	const anchors = source.draw(int(1, 2))
	const columns = source.draw(int(1, 4))
	const indexes = Array.from({ length: columns }, (_, c) => c)
	const bound: Gen<Bound> = (s) => ({
		kind: s.draw(boolean) ? "key" : "apart",
		anchor: s.draw(int(0, anchors - 1)),
		columns: s.draw(subset(indexes, { min: 0, max: columns }))
	})
	return { anchors, columns, bounds: source.draw(array(bound, { min: 1, max: 6 })) }
}

/** Whether exponents meet every bound of `system`. */
export const meets = (
	system: ExponentSystem,
	anchors: ReadonlyArray<number>,
	columns: ReadonlyArray<number>
): boolean =>
	Arr.every(anchors, (y) => y >= 0) &&
	Arr.every(columns, (x) => x >= 1) &&
	Arr.every(system.bounds, (b) => {
		const sum = Arr.reduce(b.columns, 0, (s, c) => s + (columns[c] ?? 0))
		const y = anchors[b.anchor] ?? 0
		return b.kind === "key" ? sum >= y : sum <= y - 1
	})

/** Every vector of `length` whole numbers from `lo` to `hi`, in lexicographic order. */
const vectors = (length: number, lo: number, hi: number): ReadonlyArray<ReadonlyArray<number>> =>
	length === 0
		? [[]]
		: Arr.flatMap(vectors(length - 1, lo, hi), (rest) =>
				Array.from({ length: hi - lo + 1 }, (_, i) => [lo + i, ...rest])
			)

/** Lexicographic order of two vectors of one length. */
const lexLess = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => {
	for (const [i, x] of a.entries()) {
		const y = b[i] ?? 0
		if (x !== y) {
			return x < y
		}
	}
	return false
}

/**
 * The least solution with every exponent at most `top`, by brute force over the box: the least largest anchor exponent,
 * then the columns' least lexicographically, then each anchor's least under them; none where the box holds no
 * solution.
 */
export const leastInBox = (
	system: ExponentSystem,
	top: number
):
	| { readonly anchors: ReadonlyArray<number>; readonly columns: ReadonlyArray<number> }
	| undefined => {
	let best:
		| {
				readonly Y: number
				readonly anchors: ReadonlyArray<number>
				readonly columns: ReadonlyArray<number>
		  }
		| undefined
	for (const columns of vectors(system.columns, 1, Math.max(1, top))) {
		for (const anchors of vectors(system.anchors, 0, top)) {
			if (!meets(system, anchors, columns)) {
				continue
			}
			const Y = Arr.reduce(anchors, 0, (m, y) => Math.max(m, y))
			if (
				best === undefined ||
				Y < best.Y ||
				(Y === best.Y && lexLess(columns, best.columns)) ||
				(Y === best.Y && !lexLess(best.columns, columns) && lexLess(anchors, best.anchors))
			) {
				best = { Y, anchors, columns }
			}
		}
	}
	return best === undefined ? undefined : { anchors: best.anchors, columns: best.columns }
}
