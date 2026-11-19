import { defect } from "#text/base/invariant.ts"
import { type CharSet, charSet, digit, type Interval } from "#text/regex/charset.ts"
import { empty, never, RegexBuilder, type RegexNode, seq, set } from "#text/regex/ir.ts"
import { codePoints } from "#text/text.ts"

/**
 * Languages written out over the regex IR (ir.ts) rather than read from a pattern's source: a text code point by code
 * point, the set of a text's code points or of its runs, and the decimal spellings of an interval of naturals, which
 * the JSON wire's integer, decimal and date languages and an XML Schema integer type's bounds are built from. Each is
 * a node of the IR, which the one printer spells in every dialect (print.ts), so no language is written as a pattern
 * text by hand.
 */

/** The code point a digit character is: its digit's place in `0` to `9`. */
const zero = 0x30

/** The set of the code points `text` holds, each once. */
export const charsOf = (text: string): CharSet => charSet(codePoints(text).map((c) => [c, c]))

/**
 * The set of the runs `spec` writes, as a class body writes them with no escape: a code point, a hyphen and a code point
 * a run from the first to the second, and any other code point itself, a hyphen at either end among them (`a-zA-Z0-9`,
 * `+-`).
 */
export const runsOf = (spec: string): CharSet => {
	const points = codePoints(spec)
	const hyphen = 0x2d
	const runs: Array<Interval> = []
	for (let i = 0; i < points.length; i++) {
		const lo = points[i]
		const next = points[i + 1]
		const hi = points[i + 2]
		if (lo === undefined) {
			throw defect("a code point of a run's spelling")
		}
		if (next === hyphen && hi !== undefined) {
			runs.push([lo, hi])
			i += 2
		} else {
			runs.push([lo, lo])
		}
	}
	return charSet(runs)
}

/** A text: one set of one code point for each of its code points, in order; the empty string for the empty text. */
export const literal = (text: string): RegexNode =>
	seq(codePoints(text).map((c) => set(charSet([[c, c]]))))

/** One digit from `lo` to `hi`, both of 0 to 9. */
const digitsFrom = (lo: number, hi: number): RegexNode => set(charSet([[zero + lo, zero + hi]]))

/** The digit of a digit string at `at`. */
const digitAt = (text: string, at: number): number => text.charCodeAt(at) - zero

/** Whether every digit of a digit string is `d`. */
const allOf = (text: string, d: number): boolean => {
	for (let at = 0; at < text.length; at++) {
		if (digitAt(text, at) !== d) {
			return false
		}
	}
	return true
}

/** Exactly `n` digits, any. */
const anyDigits = (b: RegexBuilder, n: number): RegexNode => b.repeat(set(digit), n, n)

/**
 * The digit strings of `s`'s length that are at least `s` as numbers, leading zeros digits like any other: read from
 * its last digit to its first, each digit's language its own digit followed by the language of the rest, or any greater
 * digit followed by any digits, and a digit after which only zeros stand its digit or any greater one followed by any
 * digits.
 */
const atLeast = (b: RegexBuilder, s: string): RegexNode => {
	let node: RegexNode = empty
	let zeros = true
	for (let at = s.length - 1; at >= 0; at--) {
		const d = digitAt(s, at)
		const rest = s.length - 1 - at
		node = zeros
			? seq([digitsFrom(d, 9), anyDigits(b, rest)])
			: b.alt([
					seq([digitsFrom(d, d), node]),
					...(d < 9 ? [seq([digitsFrom(d + 1, 9), anyDigits(b, rest)])] : [])
				])
		zeros = zeros && d === 0
	}
	return node
}

/** The digit strings of `s`'s length that are at most `s` as numbers: atLeast's mirror, toward 0 and past nines. */
const atMost = (b: RegexBuilder, s: string): RegexNode => {
	let node: RegexNode = empty
	let nines = true
	for (let at = s.length - 1; at >= 0; at--) {
		const d = digitAt(s, at)
		const rest = s.length - 1 - at
		node = nines
			? seq([digitsFrom(0, d), anyDigits(b, rest)])
			: b.alt([
					seq([digitsFrom(d, d), node]),
					...(d > 0 ? [seq([digitsFrom(0, d - 1), anyDigits(b, rest)])] : [])
				])
		nines = nines && d === 9
	}
	return node
}

/**
 * Every digit string of one length from `from` to `to`, both that long and `from` at most `to` as numbers: their common
 * prefix, then at the first digit they differ at, `from`'s digit followed by the rests at least its own, the digits
 * strictly between followed by any digits, and `to`'s digit followed by the rests at most its own, a bound whose rest is
 * the least or the greatest one joining the digits between.
 */
const sameLength = (b: RegexBuilder, from: string, to: string): RegexNode => {
	let at = 0
	while (at < from.length && from[at] === to[at]) {
		at++
	}
	if (at === from.length) {
		return literal(from)
	}
	const a = digitAt(from, at)
	const z = digitAt(to, at)
	const low = from.slice(at + 1)
	const high = to.slice(at + 1)
	const lowWhole = allOf(low, 0)
	const highWhole = allOf(high, 9)
	const between = { from: lowWhole ? a : a + 1, to: highWhole ? z : z - 1 }
	return seq([
		literal(from.slice(0, at)),
		b.alt([
			...(lowWhole ? [] : [seq([digitsFrom(a, a), atLeast(b, low)])]),
			...(between.from <= between.to
				? [seq([digitsFrom(between.from, between.to), anyDigits(b, low.length)])]
				: []),
			...(highWhole ? [] : [seq([digitsFrom(z, z), atMost(b, high)])])
		])
	])
}

/**
 * Every digit string of one length from `from` to `to` as numbers, leading zeros digits like any other ("007" to "042"
 * is the strings 007 to 042): both digit strings of that length, `from` at most `to`. Two strings of other lengths, or
 * `from` above `to`, are no range, a defect.
 */
export const digitRange = (from: string, to: string): RegexNode => {
	if (from.length !== to.length || from > to) {
		throw defect("two digit strings of one length, the first at most the second")
	}
	return sameLength(new RegexBuilder(), from, to)
}

/**
 * The decimal spellings of the naturals from `lo` to `hi`, or every natural from `lo` on: no leading zero but in 0
 * itself, as JSON and XML Schema write a natural's canonical digits. The lengths strictly between the bounds' own are
 * every digit string of their length that starts with a nonzero digit, one run; each bound's own length is a range of
 * digit strings (sameLength). An empty interval is the empty language; a negative `lo` is no natural's bound, a defect.
 * Its size grows with the digits of its bounds alone.
 */
export const naturals = (lo: bigint, hi: bigint | "unbounded"): RegexNode => {
	if (lo < 0n) {
		throw defect("a natural as the least of an interval of naturals")
	}
	if (hi !== "unbounded" && hi < lo) {
		return never
	}
	const b = new RegexBuilder()
	const zeroArm = lo === 0n ? [literal("0")] : []
	if (hi === 0n) {
		return literal("0")
	}
	const least = lo === 0n ? "1" : lo.toString()
	const longer = (min: number, max: number | "unbounded"): RegexNode =>
		seq([digitsFrom(1, 9), b.repeat(set(digit), min, max)])
	if (hi === "unbounded") {
		return b.alt([...zeroArm, atLeast(b, least), longer(least.length, "unbounded")])
	}
	const most = hi.toString()
	if (least.length === most.length) {
		return b.alt([...zeroArm, sameLength(b, least, most)])
	}
	return b.alt([
		...zeroArm,
		atLeast(b, least),
		...(most.length - least.length >= 2 ? [longer(least.length, most.length - 2)] : []),
		sameLength(b, `1${"0".repeat(most.length - 1)}`, most)
	])
}
