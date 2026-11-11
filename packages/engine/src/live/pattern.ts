/**
 * The regular languages of the wire's spellings (live/wire.ts), as ECMA-262 pattern texts a JSON Schema `pattern`
 * holds: each a function of the bounds its carrier's type states, so a schema states exactly the spellings the wire's
 * parse takes. A language is written as an alternation of digit runs, never by enumerating values, so its text grows
 * with the digits of its bounds alone.
 *
 * Every text is read under ECMA-262's `u` flag, as JSON Schema 2020-12 reads a `pattern` (§6.4, "Regular expressions
 * SHOULD be built with the "u" flag"), and is unanchored, as a `pattern` is: `anchored` anchors one.
 */

/** A regex of one of `arms`: the arm itself for one, a non-capturing group of their alternation for several. */
export const alternation = (arms: ReadonlyArray<string>): string => {
	const [only, ...rest] = arms
	return only !== undefined && rest.length === 0 ? only : `(?:${arms.join("|")})`
}

/** The pattern a whole value matches: `body` from the value's start to its end. */
export const anchored = (body: string): string => `^${body}$`

/** `body` or nothing. */
const optional = (body: string): string => `(?:${body})?`

/** Exactly `n` decimal digits. */
const digits = (n: number): string => (n === 0 ? "" : n === 1 ? "[0-9]" : `[0-9]{${n}}`)

/** At most `n` decimal digits. */
const atMostDigits = (n: number): string => (n <= 0 ? "" : `[0-9]{0,${n}}`)

/** The decimal digit a code unit of a digit string is. */
const digitAt = (text: string, at: number): number => text.charCodeAt(at) - "0".charCodeAt(0)

/** The digits from `a` to `b` as one class, a single digit as itself. */
const digitClass = (a: number, b: number): string => (a === b ? String(a) : `[${a}-${b}]`)

/**
 * Every digit string of one length from `lo` to `hi`, both that long and `lo` at most `hi` as numbers: leading zeros
 * are digits like any other, so "007" to "042" is the strings 007 to 042. It splits at the first digit: the first
 * digits strictly between the bounds' own, and a bound's own first digit where the rest of the bound is the least or
 * the greatest rest, are one class followed by any digits; a bound's own first digit otherwise is that digit followed
 * by the range of the rest.
 */
const digitRange = (lo: string, hi: string): string => {
	const n = lo.length
	if (n === 0) {
		return ""
	}
	const lowRest = lo.slice(1)
	const highRest = hi.slice(1)
	const a = digitAt(lo, 0)
	const b = digitAt(hi, 0)
	const zeros = "0".repeat(n - 1)
	const nines = "9".repeat(n - 1)
	if (a === b) {
		return `${a}${digitRange(lowRest, highRest)}`
	}
	const lowWhole = lowRest === zeros
	const highWhole = highRest === nines
	const classFrom = lowWhole ? a : a + 1
	const classTo = highWhole ? b : b - 1
	const whole =
		classFrom > classTo
			? []
			: [
					classFrom === 0 && classTo === 9
						? digits(n)
						: `${digitClass(classFrom, classTo)}${digits(n - 1)}`
				]
	return alternation([
		...(lowWhole ? [] : [`${a}${digitRange(lowRest, nines)}`]),
		...whole,
		...(highWhole ? [] : [`${b}${digitRange(zeros, highRest)}`])
	])
}

/** The digit run from `from` digits to `to` digits long, as runs of every length between spell them, none below one. */
const lengthsRun = (from: number, to: number): string =>
	from === to ? `[1-9]${digits(from - 1)}` : `[1-9][0-9]{${from - 1},${to - 1}}`

/**
 * The decimal spellings of the naturals from `lo` to `hi` (0 <= lo <= hi), as JSON writes an integer: no leading zero
 * but in 0 itself. The lengths between the two bounds' own are every natural of their length, one run; each bound's
 * own length is a digit range.
 */
export const naturals = (lo: bigint, hi: bigint): string => {
	if (lo === 0n) {
		return hi === 0n ? "0" : alternation(["0", naturals(1n, hi)])
	}
	const from = lo.toString()
	const to = hi.toString()
	if (from.length === to.length) {
		return digitRange(from, to)
	}
	const first = digitRange(from, "9".repeat(from.length))
	const middle = to.length - from.length >= 2 ? [lengthsRun(from.length + 1, to.length - 1)] : []
	const last = digitRange(`1${"0".repeat(to.length - 1)}`, to)
	return alternation([first, ...middle, last])
}

/**
 * The spellings of the integers from `min` to `max` (min <= 0 <= max): a natural's, or a minus sign and a positive
 * magnitude's, and "-0", the minus sign's spelling of zero, which JSON's integer grammar holds too.
 */
export const integers = (min: bigint, max: bigint): string =>
	alternation([
		`-?0`,
		...(max > 0n ? [naturals(1n, max)] : []),
		...(min < 0n ? [`-${naturals(1n, -min)}`] : [])
	])

/**
 * A decimal's spelling, as the wire's decimal grammar writes it: an optional minus sign, an integer part as JSON writes
 * one, and an optional fraction of at least one digit; never an exponent.
 */
export const decimalGrammar = String.raw`-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?`

/**
 * The fractions of a decimal of at most `scale` fraction digits whose first `zeros` digits are zero, as the wire's
 * grammar spells them: a point and at least one digit, trailing zeros free. A fraction of zeros alone is zero's.
 */
const fractions = (scale: number, zeros: number): string =>
	scale - zeros >= 1
		? String.raw`\.(?:0+|${"0".repeat(zeros)}${atMostDigits(scale - zeros - 1)}[1-9]0*)`
		: String.raw`\.0+`

/**
 * The spellings in the wire's decimal grammar of the decimals below 10^`integerDigits` in magnitude whose every digit
 * past the `scale`th fraction digit is zero (numeric(p, s): integerDigits p - s, scale s; a computed numeric's bound):
 * the values the type holds exactly, each in every spelling the grammar has for it. A negative scale holds multiples of
 * 10^-scale; integerDigits at or below 0 holds magnitudes below one whose first -integerDigits fraction digits are zero.
 */
export const decimals = (integerDigits: number, scale: number): string => {
	const sign = "-?"
	if (scale < 0) {
		const zeros = -scale
		return `${sign}${alternation(["0", `[1-9]${atMostDigits(integerDigits - zeros - 1)}${"0".repeat(zeros)}`])}${optional(String.raw`\.0+`)}`
	}
	const integer =
		integerDigits >= 1 ? alternation(["0", `[1-9]${atMostDigits(integerDigits - 1)}`]) : "0"
	return `${sign}${integer}${optional(fractions(scale, Math.max(0, -integerDigits)))}`
}

/** `value` zero-padded to `width` digits. */
const padded = (value: bigint, width: number): string => value.toString().padStart(width, "0")

/**
 * The fractions of at most `scale` digits, as the wire's grammar spells them (a point, at least one digit, trailing
 * zeros free), whose value in units of 10^-scale is at most `most`, below 10^scale.
 */
const fractionsUpTo = (most: bigint, scale: number): string => {
	const arms: Array<string> = []
	for (let length = 1; length <= scale; length++) {
		const head = most / 10n ** BigInt(scale - length)
		arms.push(digitRange("0".repeat(length), padded(head, length)))
	}
	return String.raw`\.${alternation(arms)}0*`
}

/**
 * The spellings in the wire's decimal grammar of the magnitudes from 0 to `most` units of 10^-`scale` (money's minor
 * units at its fraction digits): an integer part below the most's own, with any fraction of at most `scale` digits,
 * or the most's integer part with a fraction up to its own.
 */
const magnitudesUpTo = (most: bigint, scale: number): string => {
	const unit = 10n ** BigInt(scale)
	const whole = most / unit
	const rest = most % unit
	const below = whole >= 1n ? [`${naturals(0n, whole - 1n)}${optional(fractions(scale, 0))}`] : []
	return alternation([...below, `${whole}${optional(fractionsUpTo(rest, scale))}`])
}

/**
 * The spellings in the wire's decimal grammar of the amounts from `min` to `max` units of 10^-`scale` (min <= 0 <= max),
 * each at most `scale` fraction digits once its trailing zeros go: money's, in minor units at its fraction digits.
 */
export const amounts = (min: bigint, max: bigint, scale: number): string =>
	alternation([magnitudesUpTo(max, scale), `-${magnitudesUpTo(-min, scale)}`])

/**
 * The years 0001 to 9999 a calendar date spells, four digits each, and the leap years among them, whose February has a
 * 29th: every fourth year, a century only when its century is a fourth (ir/date.ts leapCycle).
 *
 * @formatConstant ISO 8601's extended calendar date YYYY-MM-DD, and the Gregorian leap year cycle over its years
 */
const calendar = {
	year: "(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})",
	leapYear: "(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)",
	thirtyOne: "(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])",
	thirty: "(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)",
	february: "02-(?:0[1-9]|1[0-9]|2[0-8])",
	leapDay: "02-29"
} as const

/**
 * Every calendar date from 0001-01-01 to 9999-12-31, as `YYYY-MM-DD` (ir/date.ts CalendarDate): each month's own days,
 * and February's 29th in a leap year alone.
 */
export const calendarDates = alternation([
	`${calendar.year}-${alternation([calendar.thirtyOne, calendar.thirty, calendar.february])}`,
	`${calendar.leapYear}-${calendar.leapDay}`
])

/**
 * A uuid's hyphenated 8-4-4-4-12 hexadecimal spelling in either case (ir/carriers.ts uuidGroups), which the wire's parse
 * takes, lowercased, as its one value.
 */
export const uuidSpelling = (groups: ReadonlyArray<number>): string =>
	groups.map((width) => `[0-9a-fA-F]{${width}}`).join("-")

/**
 * Every text PostgreSQL's text holds, as code points: no NUL, and no lone surrogate, which has no UTF-8 encoding
 * (core/text.ts validateText). Under the `u` flag a lone surrogate is one code point of its own, outside both ranges.
 */
export const admittedText = String.raw`[\u{1}-\u{D7FF}\u{E000}-\u{10FFFF}]*`

/** The alphabet of base64, RFC 4648 §4. */
const base64Alphabet = "[A-Za-z0-9+/]"

/**
 * The last group of a canonical base64 text of one or two bytes, RFC 4648 §4 padded: its last digit's bits past the
 * bytes zero (§3.5), so each byte string has exactly one spelling.
 *
 * @formatConstant RFC 4648 §4's base64 alphabet: the digits whose low four or two bits are zero
 */
const base64Tails = {
	one: `${base64Alphabet}[AQgw]==`,
	two: `${base64Alphabet}{2}[AEIMQUYcgkosw048]=`
} as const

/**
 * The canonical base64 texts of the byte strings of at most `most` bytes: whole groups of three bytes, then one group
 * of one or two, each group four digits.
 *
 * @formatConstant RFC 4648 §4's base64: three bytes to a group of four digits
 */
export const base64Texts = (most: number): string => {
	const groupBytes = 3
	const groupDigits = 4
	const full = Math.floor(most / groupBytes)
	const left = most % groupBytes
	const group = `${base64Alphabet}{${groupDigits}}`
	const runs = (n: number): string => (n <= 0 ? "" : `(?:${group}){0,${n}}`)
	const tails =
		left === 0 ? [] : left === 1 ? [base64Tails.one] : [base64Tails.one, base64Tails.two]
	return alternation([
		runs(full),
		...(full >= 1 ? [`${runs(full - 1)}${alternation([base64Tails.one, base64Tails.two])}`] : []),
		...(tails.length === 0 ? [] : [`(?:${group}){${full}}${alternation(tails)}`])
	])
}
