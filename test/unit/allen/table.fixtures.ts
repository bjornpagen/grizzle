/** What the properties of table.test.ts read: its spaces, models and helpers. */

import { element, type Gen, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { allenAtomCount, allenAtoms, atomIndexable } from "#compiler/allen/atoms.ts"
import { fullAllenMask } from "#compiler/allen/mask.ts"
import { generateAllenTable } from "#scripts/gen/allen/generate.ts"
import { defined, nonEmpty } from "#test/support/assert.ts"
import {
	type PairFacts,
	type RangeType,
	rangeTypes,
	universe,
	universePairs
} from "#test/support/oracle/allen.ts"

const pairsOf: ReadonlyMap<RangeType, ReturnType<typeof universePairs>> = new Map(
	Arr.map(rangeTypes, (type) => [type, universePairs(universe(type))] as const)
)

/** The element at an index the test knows is in range, failing the test where it is not. */
export const at = <A>(values: ArrayLike<A>, index: number): A =>
	defined(values[index], `an element at ${index}`)

export const pairs = (type: RangeType): ReadonlyArray<PairFacts> =>
	defined(pairsOf.get(type), `the pairs of ${type}`)

/** What the table's cases reach. */
export type EntryFeature =
	| "the empty mask"
	| "one disjunct"
	| "several disjuncts"
	| "a negated literal"
	| "the full mask"

export type CostFeature = "cost at most three" | "cost four" | "cost above four"

/** Literal codes compared lexicographically, a shorter prefix first. */
export const codeOrder: Order.Order<ReadonlyArray<number>> = Order.Array(Order.Number)

/** The exact minimal atom count of every mask (see the property above), by mask. */
const exactCosts = (): Int32Array => {
	const unreachable = 1 << 20
	const term = new Int32Array(fullAllenMask + 1).fill(unreachable)
	const assignments = 3 ** allenAtomCount
	for (let assignment = 0; assignment < assignments; assignment++) {
		let holds: number = fullAllenMask
		let size = 0
		let indexable = false
		let rest = assignment
		for (let atom = 0; atom < allenAtomCount; atom++) {
			const state = rest % 3
			rest = (rest - state) / 3
			if (state === 0) {
				continue
			}
			const info = at(allenAtoms, atom)
			size++
			if (state === 1) {
				holds &= info.holds
				if (atomIndexable(info)) {
					indexable = true
				}
			} else {
				holds &= fullAllenMask ^ info.holds
			}
		}
		if (indexable && holds !== 0 && size < at(term, holds)) {
			term[holds] = size
		}
	}
	const f = new Int32Array(fullAllenMask + 1).fill(unreachable)
	for (let m = 1; m <= fullAllenMask; m++) {
		let best = at(term, m)
		for (let m1 = (m - 1) & m; m1 > 0; m1 = (m1 - 1) & m) {
			const c1 = at(f, m1)
			if (c1 >= best) {
				continue
			}
			const rest = m ^ m1
			for (let t = m1; ; t = (t - 1) & m1) {
				const m2 = rest | t
				if (m2 !== m) {
					const c = c1 + at(f, m2)
					if (c < best) {
						best = c
					}
				}
				if (t === 0) {
					break
				}
			}
		}
		f[m] = best
	}
	return f
}

/** Every ordered pair of both universes, with its type. */
export const typedPairs: Gen<{ readonly type: RangeType; readonly pair: PairFacts }> = oneOf(
	Arr.map(rangeTypes, (type) =>
		map(element(nonEmpty(pairs(type), `the ${type} pairs`)), (pair) => ({ type, pair }))
	)
)

/** What an atom's truth on a pair reaches: each atom true and false. */
export type AtomFeature = `${string} held` | `${string} failed`

export const generated = generateAllenTable()

export const exact = exactCosts()
