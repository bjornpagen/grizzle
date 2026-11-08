import { defect } from "#compiler/core/invariant.ts"
import { has, type Interval } from "#compiler/scalar/regex/charset.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

/** The element of `xs` at `i`, which the caller's bounds make present (scalar/regex/table.ts entry). */
const at = (xs: ArrayLike<number>, i: number): number => entry(xs, i)

/**
 * The partition a list of sets cuts a universe of code points into. Its segments are the maximal intervals of the
 * universe that no set's boundary cuts, in code point order; its atoms are the classes of segments every set holds
 * alike, numbered in the order their first segments come, so an atom's least code point grows with its number. Each
 * set holds whole atoms, which `setAtoms` lists in the order of its segments.
 */
export interface CharPartition {
	readonly segments: ReadonlyArray<Interval>
	/** Each segment's atom. */
	readonly atomOf: Int32Array
	readonly atomCount: number
	readonly setAtoms: ReadonlyArray<ReadonlyArray<number>>
}

/**
 * The partition `sets` cut `universe` into, by refinement, one split for each set, so its work is the sorting of the
 * cuts and, for each set, the segments it holds: the alphabet of a subset construction (dfa.ts), whose universe is the
 * admitted domain, and the colors of PostgreSQL's regex compiler (space.ts), whose universe holds every code point.
 */
export const partitionOf = (
	sets: ReadonlyArray<ReadonlyArray<Interval>>,
	universe: ReadonlyArray<Interval>
): CharPartition => {
	const cuts = new Set<number>()
	for (const [lo, hi] of universe) {
		cuts.add(lo)
		cuts.add(hi + 1)
	}
	for (const set of sets) {
		for (const [lo, hi] of set) {
			cuts.add(lo)
			cuts.add(hi + 1)
		}
	}
	const sorted = [...cuts].toSorted((a, b) => a - b)
	/** Each cut's index in `sorted`, and the segment that starts at it, or -1 outside the universe or at the end. */
	const cutIndex = new Map(sorted.map((cut, i) => [cut, i]))
	const indexOf = (cut: number): number => {
		const index = cutIndex.get(cut)
		if (index === undefined) {
			throw defect(`a set's bound ${cut}, which the partition's cuts hold`)
		}
		return index
	}
	const segmentAt = new Int32Array(sorted.length).fill(-1)
	const segments: Array<Interval> = []
	for (const [i, lo] of sorted.entries()) {
		const following = sorted[i + 1]
		if (following !== undefined && has(universe, lo)) {
			segmentAt[i] = segments.length
			segments.push([lo, following - 1])
		}
	}
	/** The segments of a set, in order: those starting at its intervals' cuts. */
	const segmentsOf = function* (set: ReadonlyArray<Interval>): Generator<number> {
		for (const [lo, hi] of set) {
			const end = indexOf(hi + 1)
			for (let i = indexOf(lo); i < end; i++) {
				const segment = at(segmentAt, i)
				if (segment >= 0) {
					yield segment
				}
			}
		}
	}
	/**
	 * The refinement: a block per class of segments the sets seen so far hold alike, the segments of each set moved,
	 * block by block, into a block the set's round opened for the block they leave. A block every segment left stays
	 * empty, and the numbering below skips it.
	 */
	const blockOf = new Int32Array(segments.length)
	const openedIn: Array<number> = [-1]
	const openedAs: Array<number> = [-1]
	for (const [round, set] of sets.entries()) {
		for (const segment of segmentsOf(set)) {
			const block = at(blockOf, segment)
			if (openedIn[block] !== round) {
				openedIn[block] = round
				openedAs[block] = openedIn.length
				openedIn.push(-1)
				openedAs.push(-1)
			}
			blockOf[segment] = at(openedAs, block)
		}
	}
	const atomOfBlock = new Int32Array(openedIn.length).fill(-1)
	const atomOf = new Int32Array(segments.length)
	let atomCount = 0
	for (const [segment, block] of blockOf.entries()) {
		if (atomOfBlock[block] === -1) {
			atomOfBlock[block] = atomCount
			atomCount += 1
		}
		atomOf[segment] = at(atomOfBlock, block)
	}
	const listed = new Int32Array(atomCount).fill(-1)
	const setAtoms = sets.map((set, s) => {
		const atoms: Array<number> = []
		for (const segment of segmentsOf(set)) {
			const atom = at(atomOf, segment)
			if (listed[atom] !== s) {
				listed[atom] = s
				atoms.push(atom)
			}
		}
		return atoms
	})
	return { segments, atomOf, atomCount, setAtoms }
}
