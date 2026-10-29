import { Array as Arr, Option, String as Str } from "effect"

/** The interval [lo, hi) of the strings that start with a prefix, in code point order. */
export interface PrefixBounds {
	readonly lo: string
	readonly hi: string
}

/** The Unicode scalar after `cp`, skipping the surrogate block. `cp` is a scalar below U+10FFFF. */
const nextScalar = (cp: number): number => (cp === 0xd7ff ? 0xe000 : cp + 1)

/**
 * A prefix search as a half-open interval in code point order, which is text's order under the C.UTF-8 contract: the
 * strings that start with p are exactly [p, succ(p)). succ(p) drops every trailing U+10FFFF, which has no next scalar,
 * and replaces the last remaining scalar with the next Unicode scalar, U+D7FF followed by U+E000. The empty prefix and
 * a prefix of only U+10FFFF have no finite upper bound, and their interval is undefined. A query compares a field with
 * the bounds as `field >= lo AND field < hi`.
 */
export const prefixBounds = (prefix: string): PrefixBounds | undefined => {
	const scalars = Array.from(prefix)
	let end = scalars.length
	while (end > 0 && scalars[end - 1] === "\u{10FFFF}") {
		end -= 1
	}
	const last = Option.flatMap(Arr.get(scalars, end - 1), Str.codePointAt(0))
	if (Option.isNone(last)) {
		return undefined
	}
	return {
		lo: prefix,
		hi: `${Arr.join(scalars.slice(0, end - 1), "")}${String.fromCodePoint(nextScalar(last.value))}`
	}
}
