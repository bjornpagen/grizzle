import { maxUtf8Width } from "#compiler/text/charset.ts"
import type { RegexNode } from "#compiler/text/ir.ts"

interface Extent {
	readonly length: number
	readonly bytes: number
}

/** Indexed by (passes ^ ? 1 : 0) + (passes $ ? 2 : 0); undefined when no path of that kind exists. */
type Paths = readonly [
	Extent | undefined,
	Extent | undefined,
	Extent | undefined,
	Extent | undefined
]

const none: Paths = [undefined, undefined, undefined, undefined]
const unit: Paths = [{ length: 0, bytes: 0 }, undefined, undefined, undefined]

const maxExtent = (a: Extent | undefined, b: Extent | undefined): Extent | undefined =>
	a === undefined
		? b
		: b === undefined
			? a
			: { length: Math.max(a.length, b.length), bytes: Math.max(a.bytes, b.bytes) }

const unite = (a: Paths, b: Paths): Paths => [
	maxExtent(a[0], b[0]),
	maxExtent(a[1], b[1]),
	maxExtent(a[2], b[2]),
	maxExtent(a[3], b[3])
]

/** A path of extent `x` followed by one of extent `y`; none when either is none. */
const joined = (x: Extent | undefined, y: Extent | undefined): Extent | undefined =>
	x === undefined || y === undefined
		? undefined
		: { length: x.length + y.length, bytes: x.bytes + y.bytes }

const concat = (a: Paths, b: Paths): Paths => {
	const out: Array<Extent | undefined> = [undefined, undefined, undefined, undefined]
	for (const [i, x] of a.entries()) {
		for (const [j, y] of b.entries()) {
			out[i | j] = maxExtent(out[i | j], joined(x, y))
		}
	}
	return [out[0], out[1], out[2], out[3]]
}

/** The kinds `star` reaches with any number of further iterations of `body`. */
const starKinds = (star: Paths, body: Paths): Paths => {
	const grown = unite(star, concat(star, body))
	return sameKinds(grown, star) ? star : starKinds(grown, body)
}

const sameKinds = (a: Paths, b: Paths): boolean =>
	a.every((x, i) => (x === undefined) === (b[i] === undefined))

const pathsOf = (node: RegexNode): Paths => {
	switch (node.kind) {
		case "empty":
			return unit
		case "never":
			return none
		case "set":
			return [{ length: 1, bytes: maxUtf8Width(node.set) }, undefined, undefined, undefined]
		case "start":
			return [undefined, { length: 0, bytes: 0 }, undefined, undefined]
		case "end":
			return [undefined, undefined, { length: 0, bytes: 0 }, undefined]
		case "seq":
			return node.items.reduce((acc, item) => concat(acc, pathsOf(item)), unit)
		case "alt":
			return node.arms.reduce((acc, arm) => unite(acc, pathsOf(arm)), none)
		case "repeat": {
			const body = pathsOf(node.body)
			let current = unit
			for (let k = 0; k < node.min; k++) {
				current = concat(current, body)
			}
			if (node.max !== "unbounded") {
				let acc = current
				for (let k = node.min; k < node.max; k++) {
					current = concat(current, body)
					acc = unite(acc, current)
				}
				return acc
			}
			/**
			 * body*: the kinds reachable by any number of iterations; unbounded length once an iteration can consume.
			 */
			const star = starKinds(unit, body)
			const consumes = body.some((x) => x !== undefined && x.length > 0)
			const extent = consumes
				? { length: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY }
				: undefined
			const stretch = (x: Extent | undefined): Extent | undefined =>
				x === undefined ? undefined : (extent ?? x)
			const starred: Paths = [
				stretch(star[0]),
				stretch(star[1]),
				stretch(star[2]),
				stretch(star[3])
			]
			return concat(current, starred)
		}
	}
}

interface LengthBounds {
	/** The most code points a member can hold. */
	readonly length: number
	/** The most UTF-8 bytes a member can hold. */
	readonly bytes: number
}

/**
 * Proved length and byte bounds of a pattern's members.
 *
 * A member is a value in which a match exists, so it is a prefix, a match and a suffix. A match path that passes `^`
 * forces the prefix to be empty and one that passes `$` forces the suffix to be empty; any other path lets the value
 * grow without bound. So a value's length is bounded exactly when every match path passes both assertions and has a
 * bounded length, which is what an anchored pattern such as `^[a-z]{1,32}$` provides.
 *
 * The analysis is structural and runs on every admitted pattern: each node maps the four combinations of "passes ^"
 * and "passes $" to the longest path of that kind, in code points and in UTF-8 bytes (a code point takes at most four). It is an upper bound, sound even for paths no value can take, such as `a^b`; the exact bound of a
 * finite language comes from its members (refinement.ts). It feeds the key representability check.
 *
 * Upper bounds on every member's length and byte size, or undefined when members can be arbitrarily long.
 */
export const structuralBounds = (node: RegexNode): LengthBounds | undefined => {
	const paths = pathsOf(node)
	if (paths[0] !== undefined || paths[1] !== undefined || paths[2] !== undefined) {
		return undefined
	}
	const anchored = paths[3]
	if (anchored === undefined) {
		return { length: 0, bytes: 0 }
	}
	if (!Number.isFinite(anchored.length) || !Number.isFinite(anchored.bytes)) {
		return undefined
	}
	return anchored
}
