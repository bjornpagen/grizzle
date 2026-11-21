/** What the properties of minimized.test.ts read: their box of inclusion proofs over a pool of admitted patterns. */

import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import type { PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"

/**
 * The pool a box draws its conjunctions from: admitted patterns under the u flag, nested in one another's languages
 * and apart, so a proof is included, refuted or both ways across the pool.
 */
const pool: NonEmptyReadonlyArray<PatternSource> = [
	{ source: "^[a-z]+$", flags: "u" },
	{ source: "^[a-z0-9]+$", flags: "u" },
	{ source: "^[0-9]{3}$", flags: "u" },
	{ source: "^a[a-z]*$", flags: "u" },
	{ source: "^(ab)+$", flags: "u" },
	{ source: "^[a-z]{2,4}$", flags: "u" }
]

/** One inclusion proof: whether the inner conjunction's language lies inside the outer one's. */
export interface Proof {
	readonly inner: NonEmptyReadonlyArray<PatternSource>
	readonly outer: NonEmptyReadonlyArray<PatternSource>
}

/** A conjunction of one or two patterns of the pool. */
const conjunctionGen: Gen<NonEmptyReadonlyArray<PatternSource>> = (source) => {
	const first = source.draw(element(pool))
	const more = source.draw(array(element(pool), { min: 0, max: 1 }))
	return [first, ...more]
}

/** A box: two to twelve proofs one compile makes, its patterns met again and again. */
export const boxGen: Gen<ReadonlyArray<Proof>> = array(
	(source) => ({ inner: source.draw(conjunctionGen), outer: source.draw(conjunctionGen) }),
	{ min: 2, max: 12 }
)

/** The distinct patterns a box's proofs compare, by their spelling. */
export const distinctPatterns = (proofs: ReadonlyArray<Proof>): number =>
	new Set(
		Arr.flatMap(proofs, (p) => Arr.map([...p.inner, ...p.outer], (q) => `${q.flags}/${q.source}`))
	).size

/** The member places a box's proofs compare, each a minimization where every proof minimized its own members. */
export const memberPlaces = (proofs: ReadonlyArray<Proof>): number =>
	Arr.reduce(proofs, 0, (n, p) => n + p.inner.length + p.outer.length)
