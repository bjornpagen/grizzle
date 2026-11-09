import { entry } from "#compiler/scalar/regex/table.ts"

export type Interval = readonly [lo: number, hi: number]

/**
 * Sets of admitted code points.
 *
 * The admitted text domain is every Unicode scalar value except U+0000: PostgreSQL text cannot hold NUL, and a lone
 * surrogate is no scalar. A CharSet is a sorted list of disjoint, non-adjacent closed intervals
 * inside that domain, so its canonical form is its identity: two sets are equal exactly when their interval lists are.
 * The surrogate block U+D800..U+DFFF is a gap in the domain, so a set that covers both U+D7FF and U+E000 holds two
 * intervals; printers may join them, because no admitted text contains a surrogate.
 *
 * Every class of the admitted grammar compiles to an explicit CharSet: `\d`, `\w`, dot and negated
 * classes never borrow a native shorthand, locale class or collation element.
 */
export type CharSet = ReadonlyArray<Interval>

/**
 * The admitted domain's first code point: U+0001, NUL excluded, which no admitted text holds.
 *
 * @formatConstant the first code point of admitted text
 */
const minScalar = 0x1
/**
 * Unicode's last code point, U+10FFFF, where its codespace ends (The Unicode Standard, §2.4 Code Points and
 * Characters).
 *
 * @formatConstant the last code point of Unicode's codespace
 */
const maxScalar = 0x10ffff
export const surrogateLo = 0xd800
export const surrogateHi = 0xdfff

/** The admitted domain itself. */
export const domain: CharSet = Object.freeze([
	Object.freeze([minScalar, surrogateLo - 1] as const),
	Object.freeze([surrogateHi + 1, maxScalar] as const)
])

/** Whether a code point is an admitted scalar: not NUL, not a surrogate, at most U+10FFFF. */
export const isAdmittedCodePoint = (cp: number): boolean =>
	Number.isInteger(cp) &&
	cp >= minScalar &&
	cp <= maxScalar &&
	(cp < surrogateLo || cp > surrogateHi)

const freezeSet = (intervals: ReadonlyArray<Interval>): CharSet =>
	Object.freeze(intervals.map((i) => Object.freeze(i)))

/** Normalizes any list of intervals: clipped to the domain, sorted, merged when overlapping or adjacent. */
export const charSet = (intervals: Iterable<Interval>): CharSet => {
	const clipped: Array<[number, number]> = []
	for (const [lo, hi] of intervals) {
		for (const [dlo, dhi] of domain) {
			const a = Math.max(lo, dlo)
			const b = Math.min(hi, dhi)
			if (a <= b) {
				clipped.push([a, b])
			}
		}
	}
	clipped.sort((x, y) => (x[0] !== y[0] ? x[0] - y[0] : x[1] - y[1]))
	const out: Array<[number, number]> = []
	for (const [lo, hi] of clipped) {
		const last = out[out.length - 1]
		if (last !== undefined && lo <= last[1] + 1) {
			last[1] = Math.max(last[1], hi)
		} else {
			out.push([lo, hi])
		}
	}
	return freezeSet(out)
}

export const single = (cp: number): CharSet => charSet([[cp, cp]])
export const union = (sets: ReadonlyArray<CharSet>): CharSet => charSet(sets.flat())

/** The admitted code points not in the set. */
export const complement = (set: CharSet): CharSet => {
	const out: Array<Interval> = []
	let next = minScalar
	for (const [lo, hi] of set) {
		if (lo > next) {
			out.push([next, lo - 1])
		}
		next = hi + 1
	}
	if (next <= maxScalar) {
		out.push([next, maxScalar])
	}
	return charSet(out)
}

/** The admitted code points both sets hold. */
export const intersection = (a: CharSet, b: CharSet): CharSet =>
	complement(union([complement(a), complement(b)]))

export const isEmpty = (set: CharSet): boolean => set.length === 0

export const has = (set: CharSet, cp: number): boolean => {
	let lo = 0
	let hi = set.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const interval = entry(set, mid)
		if (cp < interval[0]) {
			hi = mid - 1
		} else if (cp > interval[1]) {
			lo = mid + 1
		} else {
			return true
		}
	}
	return false
}

/** The number of code points in the set. */
export const size = (set: CharSet): number => set.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0)

/** The UTF-8 width of one code point: at most four bytes. */
export const utf8Width = (cp: number): 1 | 2 | 3 | 4 =>
	cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4

/**
 * The admitted code points of each UTF-8 width, one byte to four, in width order: each class of utf8Width, U+0001 to
 * U+007F, U+0080 to U+07FF, U+0800 to U+FFFF without the surrogates, and U+10000 to U+10FFFF (RFC 3629 §3).
 */
export const utf8Classes: ReadonlyArray<{ readonly width: 1 | 2 | 3 | 4; readonly set: CharSet }> =
	Object.freeze([
		Object.freeze({ width: 1, set: charSet([[0x0, 0x7f]]) }),
		Object.freeze({ width: 2, set: charSet([[0x80, 0x7ff]]) }),
		Object.freeze({ width: 3, set: charSet([[0x800, 0xffff]]) }),
		Object.freeze({ width: 4, set: charSet([[0x10000, maxScalar]]) })
	])

/** The widest UTF-8 encoding of any member, 0 for the empty set. */
export const maxUtf8Width = (set: CharSet): number => {
	const last = set[set.length - 1]
	return last === undefined ? 0 : utf8Width(last[1])
}

/**
 * Named sets of the admitted grammar. ECMAScript's \d and \w are ASCII-only, with no `i` flag:
 * \d is [0-9], \w is [A-Za-z0-9_] (ECMA-262 CharacterClassEscape, WordCharacters without case folding).
 */
export const digit: CharSet = charSet([[0x30, 0x39]])
export const word: CharSet = charSet([
	[0x30, 0x39],
	[0x41, 0x5a],
	[0x5f, 0x5f],
	[0x61, 0x7a]
])

/** ECMAScript's LineTerminator: LF, CR, U+2028 and U+2029. Dot without the `s` flag excludes exactly these. */
const lineTerminators: CharSet = charSet([
	[0x0a, 0x0a],
	[0x0d, 0x0d],
	[0x2028, 0x2029]
])
export const dotU: CharSet = complement(lineTerminators)
