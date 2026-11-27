import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import { digit } from "@bjornpagen/grizzle-text/regex/charset"
import {
	end,
	RegexBuilder,
	type RegexNode,
	seq,
	set,
	start
} from "@bjornpagen/grizzle-text/regex/ir"
import { toEcma } from "@bjornpagen/grizzle-text/regex/print"
import { anyText } from "@bjornpagen/grizzle-text/regex/source"
import { digitRange, literal, naturals, runsOf } from "@bjornpagen/grizzle-text/regex/words"

/**
 * The regular languages of the wire's spellings (live/wire.ts), as nodes of grizzle's one regex IR: each a function of
 * the bounds its carrier's type states, so a schema states exactly the spellings the wire's parse takes. A language is
 * built of digit ranges (regex/words.ts), never by enumerating values, so its size grows with the digits of its bounds
 * alone, and a schema's `pattern` is the one printer's ECMA-262 spelling of its whole texts (`patternOf`).
 */

/** The JSON Schema `pattern` of the texts `language` holds whole: `^…$`, printed under ECMA-262's `u` flag, as JSON
 * Schema 2020-12 reads a `pattern` (§6.4, "Regular expressions SHOULD be built with the "u" flag"; print.ts toEcma). */
export const patternOf = (language: RegexNode): string => {
	const whole = seq([start, language, end])
	if (whole.kind === "never") {
		defect("a wire spelling's language, which holds a spelling")
	}
	return toEcma(whole)
}

/** `body` or nothing. */
const optional = (b: RegexBuilder, body: RegexNode): RegexNode => b.repeat(body, 0, 1)

/** Between `min` and `max` decimal digits, any; none where `max` is below 1. */
const digitsUpTo = (b: RegexBuilder, max: number): RegexNode =>
	b.repeat(set(digit), 0, Math.max(0, max))

/** A minus sign or none. */
const signed = (b: RegexBuilder): RegexNode => optional(b, literal("-"))

/**
 * The spellings of the integers from `min` to `max` (min <= 0 <= max): a natural's, or a minus sign and a positive
 * magnitude's, and "-0", the minus sign's spelling of zero, which JSON's integer grammar holds too.
 */
export const integers = (min: bigint, max: bigint): RegexNode => {
	const b = new RegexBuilder()
	return b.alt([
		seq([signed(b), literal("0")]),
		naturals(1n, max),
		seq([literal("-"), naturals(1n, -min)])
	])
}

/** The spellings of the integers below 10^`count` in magnitude, as JSON writes an integer, "-0" among them. */
export const integersBelow = (count: number): RegexNode =>
	seq([signed(new RegexBuilder()), naturals(0n, 10n ** BigInt(count) - 1n)])

/** The point of a decimal's fraction. */
const point = literal(".")

/**
 * The fractions of a decimal of at most `scale` fraction digits whose first `zeros` digits are zero, as the wire's
 * grammar spells them: a point and at least one digit, trailing zeros free. A fraction of zeros alone is zero's.
 */
const fractions = (b: RegexBuilder, scale: number, zeros: number): RegexNode => {
	const zeroRun = b.repeat(literal("0"), 1, "unbounded")
	return seq([
		point,
		scale - zeros >= 1
			? b.alt([
					zeroRun,
					seq([
						literal("0".repeat(zeros)),
						digitsUpTo(b, scale - zeros - 1),
						set(runsOf("1-9")),
						b.repeat(literal("0"), 0, "unbounded")
					])
				])
			: zeroRun
	])
}

/**
 * The spellings in the wire's decimal grammar of the decimals below 10^`integerDigits` in magnitude whose every digit
 * past the `scale`th fraction digit is zero (numeric(p, s): integerDigits p - s, scale s; a computed numeric's bound):
 * the values the type holds exactly, each in every spelling the grammar has for it. A negative scale holds multiples of
 * 10^-scale; integerDigits at or below 0 holds magnitudes below one whose first -integerDigits fraction digits are zero.
 */
export const decimals = (integerDigits: number, scale: number): RegexNode => {
	const b = new RegexBuilder()
	const leading = (rest: number): RegexNode => seq([set(runsOf("1-9")), digitsUpTo(b, rest)])
	if (scale < 0) {
		const zeros = -scale
		return seq([
			signed(b),
			b.alt([literal("0"), seq([leading(integerDigits - zeros - 1), literal("0".repeat(zeros))])]),
			optional(b, seq([point, b.repeat(literal("0"), 1, "unbounded")]))
		])
	}
	const integer =
		integerDigits >= 1 ? b.alt([literal("0"), leading(integerDigits - 1)]) : literal("0")
	return seq([signed(b), integer, optional(b, fractions(b, scale, Math.max(0, -integerDigits)))])
}

/** `value` zero-padded to `width` digits. */
const padded = (value: bigint, width: number): string => value.toString().padStart(width, "0")

/**
 * The fractions of at most `scale` digits, as the wire's grammar spells them (a point, at least one digit, trailing
 * zeros free), whose value in units of 10^-scale is at most `most`, below 10^scale.
 */
const fractionsUpTo = (b: RegexBuilder, most: bigint, scale: number): RegexNode => {
	const arms: Array<RegexNode> = []
	for (let length = 1; length <= scale; length++) {
		const head = most / 10n ** BigInt(scale - length)
		arms.push(digitRange("0".repeat(length), padded(head, length)))
	}
	return seq([point, b.alt(arms), b.repeat(literal("0"), 0, "unbounded")])
}

/**
 * The spellings in the wire's decimal grammar of the magnitudes from 0 to `most` units of 10^-`scale` (money's minor
 * units at its fraction digits): an integer part below the most's own, with any fraction of at most `scale` digits,
 * or the most's integer part with a fraction up to its own.
 */
const magnitudesUpTo = (b: RegexBuilder, most: bigint, scale: number): RegexNode => {
	const unit = 10n ** BigInt(scale)
	const whole = most / unit
	const rest = most % unit
	return b.alt([
		...(whole >= 1n ? [seq([naturals(0n, whole - 1n), optional(b, fractions(b, scale, 0))])] : []),
		seq([literal(whole.toString()), optional(b, fractionsUpTo(b, rest, scale))])
	])
}

/**
 * The spellings in the wire's decimal grammar of the amounts from `min` to `max` units of 10^-`scale` (min <= 0 <= max),
 * each at most `scale` fraction digits once its trailing zeros go: money's, in minor units at its fraction digits.
 */
export const amounts = (min: bigint, max: bigint, scale: number): RegexNode => {
	const b = new RegexBuilder()
	return b.alt([magnitudesUpTo(b, max, scale), seq([literal("-"), magnitudesUpTo(b, -min, scale)])])
}

/**
 * Every calendar date from 0001-01-01 to 9999-12-31, as `YYYY-MM-DD` (ir/date.ts CalendarDate): each month's own days,
 * and February's 29th in a leap year alone, every fourth year, a century only when its century is a fourth (ir/date.ts
 * leapCycle).
 *
 * @formatConstant ISO 8601's extended calendar date YYYY-MM-DD, and the Gregorian leap year cycle over its years
 */
export const calendarDates = ((): RegexNode => {
	const b = new RegexBuilder()
	const pair = (first: string, second: string): RegexNode =>
		seq([set(runsOf(first)), set(runsOf(second))])
	/** The two digits after a multiple of four's tens: 0 then 4 or 8, an even digit then 0, 4 or 8, an odd one then 2 or 6. */
	const fourth = (evenFirst: string): RegexNode =>
		b.alt([pair(evenFirst, "048"), pair("13579", "26")])
	const year = digitRange("0001", "9999")
	const leapYear = b.alt([
		seq([b.repeat(set(digit), 2, 2), b.alt([pair("0", "48"), fourth("2468")])]),
		seq([fourth("02468"), literal("00")])
	])
	const dash = literal("-")
	const thirtyOne = seq([
		b.alt([pair("0", "13578"), pair("1", "02")]),
		dash,
		digitRange("01", "31")
	])
	const thirty = seq([b.alt([pair("0", "469"), literal("11")]), dash, digitRange("01", "30")])
	const february = seq([literal("02-"), digitRange("01", "28")])
	return b.alt([
		seq([year, dash, b.alt([thirtyOne, thirty, february])]),
		seq([leapYear, literal("-02-29")])
	])
})()

/**
 * A uuid's hyphenated 8-4-4-4-12 hexadecimal spelling in either case (ir/carriers.ts uuidGroups), which the wire's parse
 * takes, lowercased, as its one value.
 */
export const uuidSpelling = (groups: ReadonlyArray<number>): RegexNode => {
	const b = new RegexBuilder()
	const hex = set(runsOf("0-9a-fA-F"))
	return seq(
		groups.flatMap((width, i) => [...(i === 0 ? [] : [literal("-")]), b.repeat(hex, width, width)])
	)
}

/**
 * Every text PostgreSQL's text holds, as code points: no NUL, and no lone surrogate, which has no UTF-8 encoding
 * (core/text.ts validateText), the admitted domain (regex/charset.ts domain).
 */
export const admittedTexts = anyText()

/**
 * The canonical base64 texts of the byte strings of at most `most` bytes, RFC 4648 §4 padded: whole groups of three
 * bytes, each four digits, then one group of one or two bytes, whose last digit's bits past the bytes are zero (§3.5),
 * so each byte string has exactly one spelling.
 *
 * @formatConstant RFC 4648 §4's base64: its alphabet, three bytes to a group of four digits, and the digits whose low
 * four or two bits are zero
 */
export const base64Texts = (most: number): RegexNode => {
	const b = new RegexBuilder()
	const alphabet = set(runsOf("A-Za-z0-9+/"))
	const groupBytes = 3
	const groupDigits = 4
	const group = b.repeat(alphabet, groupDigits, groupDigits)
	const one = seq([alphabet, set(runsOf("AQgw")), literal("==")])
	const two = seq([b.repeat(alphabet, 2, 2), set(runsOf("AEIMQUYcgkosw048")), literal("=")])
	const full = Math.floor(most / groupBytes)
	const left = most % groupBytes
	const runs = (n: number): RegexNode => b.repeat(group, 0, Math.max(0, n))
	const tails = left === 0 ? [] : left === 1 ? [one] : [one, two]
	return b.alt([
		runs(full),
		...(full >= 1 ? [seq([runs(full - 1), b.alt([one, two])])] : []),
		...(tails.length === 0 ? [] : [seq([b.repeat(group, full, full), b.alt(tails)])])
	])
}
