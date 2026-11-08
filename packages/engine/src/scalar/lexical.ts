import { unsupported } from "#compiler/core/errors.ts"
import { derived, type Limit, regexMaxRepeat } from "#compiler/core/limits.ts"
import { captureLoc } from "#compiler/core/loc.ts"
import { binary64DecimalDigits, binary64Digits, integerRanges } from "#compiler/ir/carriers.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
import type { ParseForm } from "#compiler/ir/proof.ts"
import {
	baseOf,
	contractOf,
	type NumericTypmod,
	numericMaxFractionDigits,
	numericMaxIntegerDigits,
	type Patterns,
	type ScalarType
} from "#compiler/ir/scalar.ts"
import { type Inclusion, patternIncludes } from "#compiler/scalar/regex/inclusion.ts"
import type { PatternAutomata } from "#compiler/scalar/regex/patterns.ts"
import { describeFieldOrThrow } from "#compiler/scalar/registry.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"

/**
 * A type a text has a lexical form of, the target of a parse: XML Schema's lexical space of the datatype the type
 * holds, cut to the values the type holds exactly, so PostgreSQL's input function for the type reads every member
 * without raising and to the value XML Schema's lexical mapping gives it:
 *
 * - an integer carrier: xs:integer's `[+-]?[0-9]+` within the carrier's range;
 * - numeric(p, s), 0 <= s <= p: xs:decimal's `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` with at most p - s integer digits
 *   and s fraction digits besides leading and trailing zeros, so the typmod neither rounds nor overflows;
 * - double precision: xs:double's mantissa, exponent, `INF`, `-INF` and `NaN` (XML Schema 1.0, which has no `+INF`),
 *   with the mantissa's digits and the exponent bounded so the value is finite and nonzero unless it is zero;
 * - boolean: xs:boolean's `true`, `false`, `1` and `0`;
 * - date: xs:date's `YYYY-MM-DD` without a timezone, years 0001 to 9999.
 *
 * And one target no type names, the parse Compute.parseDouble reads (`doubleText`): every decimal text of a double,
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?` of any digits and any exponent, and `INF`, `+INF`, `-INF` and
 * `NaN` (the grammar of XML Schema 1.1's xs:double lexical space), each member the double IEEE 754-2019's conversion
 * from decimal character sequences gives it: its exact value rounded to the nearest double, ties to even, ±Infinity
 * past the greatest finite double, and a zero of the mantissa's sign below half the least subnormal.
 *
 * And one more, the parse Compute.parseDecimal reads (`decimalText`): every decimal text,
 * `[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)` of any digits (the grammar of XML Schema 1.1's xs:decimal lexical space), within
 * decimalTextMaxBytes UTF-8 bytes, so plain numeric holds each member's value, the one xs:decimal's lexical mapping
 * gives it, exactly. Its pattern is the grammar alone, and the byte bound cuts it beside the pattern (formOctets), as
 * str.bytes cuts a pattern: a regex counts no run past regexMaxRepeat, and numeric's limits are runs of digits.
 */
export type LexicalTarget =
	| { readonly kind: "integer"; readonly carrier: "int2" | "int4" | "int8" }
	| { readonly kind: "decimal"; readonly typmod: NumericTypmod }
	| { readonly kind: "double" }
	| { readonly kind: "boolean" }
	| { readonly kind: "date" }
	| { readonly kind: "doubleText" }
	| { readonly kind: "decimalText" }

/** The value a member of a lexical form names, as the target's carrier holds it on the host. */
export type LexicalValue = bigint | Decimal | number | boolean | CalendarDate

/**
 * Whether numeric(p, s) has a decimal form: a scale from 0 to the precision, so every value is a numeral of p - s
 * integer and s fraction digits, each count a counted repetition PostgreSQL's regex compiler takes (regexMaxRepeat).
 */
const decimalWritable = ({ precision, scale }: NumericTypmod): boolean =>
	scale >= 0 &&
	scale <= precision &&
	scale <= regexMaxRepeat.value &&
	precision - scale - 1 <= regexMaxRepeat.value

/**
 * The most UTF-8 bytes of a member of decimalText's form: every decimal text of at most this many bytes names a value
 * plain numeric holds, its point taking a byte, so it has at most numericMaxFractionDigits digits past the point and no
 * more before it than numericMaxIntegerDigits; one byte more admits `.` and numericMaxFractionDigits + 1 digits, which
 * numeric_in refuses as "value overflows numeric format".
 */
export const decimalTextMaxBytes: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "UTF-8 bytes",
	scope: "a decimal text Compute.parseDecimal reads, the bytes of its form's every member",
	from: [numericMaxFractionDigits, numericMaxIntegerDigits],
	derivation:
		"numericMaxFractionDigits + 1, the point and the most fraction digits numeric holds, at most numericMaxIntegerDigits so its integer digits fit as well",
	compute: ([fraction, integer]) => Math.min(fraction.value + 1, integer.value)
})

/**
 * The lexical target of a parse's form (ir/proof.ts ParseForm): its target type's own, every double's text, or every
 * decimal text.
 */
export const parseTargetOf = (form: ParseForm, type: ScalarType): LexicalTarget | undefined => {
	switch (form) {
		case "target":
			return lexicalTargetOf(type)
		case "doubleText":
			return { kind: "doubleText" }
		case "decimalText":
			return { kind: "decimalText" }
	}
}

/**
 * The lexical target of a type: its own carrier's, a contract's none, since a parse yields its carrier's value and a
 * contract over it is entered by a domain cast after; undefined for a type no lexical form names.
 */
export const lexicalTargetOf = (type: ScalarType): LexicalTarget | undefined => {
	if (contractOf(type) !== undefined) {
		return undefined
	}
	switch (type.carrier) {
		case "int2":
		case "int4":
		case "int8":
			return { kind: "integer", carrier: type.carrier }
		case "numeric": {
			const typmod = type.typmod
			return typmod !== undefined && decimalWritable(typmod)
				? { kind: "decimal", typmod }
				: undefined
		}
		case "float8":
			return { kind: "double" }
		case "bool":
			return { kind: "boolean" }
		case "date":
			return { kind: "date" }
		case "float4":
		case "money":
		case "uuid":
		case "text":
		case "bytes":
		case "code":
		case "bits":
		case "range4":
		case "range8":
		case "rangeDate":
		case "vector":
		case "exactInteger":
		case "exactMoney":
			return undefined
	}
}

/** `atom` repeated from `low` to `high` times, as the grammar spells a counted repetition: nothing for none. */
const repeat = (atom: string, low: number, high: number): string => {
	if (high === 0) {
		return ""
	}
	if (low === high) {
		return high === 1 ? atom : `${atom}{${high}}`
	}
	return low === 0 && high === 1 ? `${atom}?` : `${atom}{${low},${high}}`
}

/** One digit from `low` to `high`. */
const digitClass = (low: number, high: number): string =>
	low === high ? `${low}` : `[${low}-${high}]`

/**
 * The numerals of value at most `n` with no leading zero, and `0`: the shorter numerals, then for each digit of `n`
 * the numerals as long as `n` that agree with it before that digit and are below it there, then `n` itself. Each
 * member has one path through it, so a run of the automaton holds one state per alternative, and `0*` before it admits
 * every numeral of value at most `n`.
 */
const numeralAtMost = (n: bigint): string => {
	const digits = n.toString()
	const width = digits.length
	const shorter = width > 1 ? [`[1-9]${repeat("[0-9]", 0, width - 2)}`] : []
	const below = digits.split("").flatMap((d, i): ReadonlyArray<string> => {
		const least = i === 0 ? 1 : 0
		const v = Number(d)
		return v > least
			? [
					`${digits.slice(0, i)}${digitClass(least, v - 1)}${repeat("[0-9]", width - 1 - i, width - 1 - i)}`
				]
			: []
	})
	return `(?:${["0", ...shorter, ...below, ...(n > 0n ? [digits] : [])].join("|")})`
}

/** Any leading zeros, then at most `k` significant integer digits, `k` at least one: the integer part of a numeral. */
const integerDigits = (k: number): string => `0*(?:0|[1-9]${repeat("[0-9]", 0, k - 1)})`

/**
 * At most `s` significant fraction digits, then any trailing zeros: `s` digits and zeros after them, or fewer than `s`
 * digits, at least `least` of them, so each member has one path through it.
 */
const fractionDigits = (s: number, least: 0 | 1): string =>
	s === 0
		? least === 0
			? "0*"
			: "0+"
		: `(?:[0-9]{${s}}0*${s > least ? `|${repeat("[0-9]", least, s - 1)}` : ""})`

/**
 * The significant digits of a double precision mantissa on either side of its point: DBL_DIG, the digits every
 * decimal of which survives binary64 unchanged, so no admitted mantissa is longer than a double resolves.
 */
const doubleMantissaDigits: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "decimal digits",
	scope:
		"the significant digits of a double precision lexical form's mantissa, before its point and after it",
	from: [binary64DecimalDigits],
	derivation:
		"DBL_DIG: every decimal of that many significant digits rounds to a binary64 value and back unchanged",
	compute: ([digits]) => digits.value
})

/**
 * The greatest decimal exponent of a double precision lexical form: the mantissa is below 10^DBL_DIG and, when
 * nonzero, at least 10^-DBL_DIG, so with |exponent| at most binary64Digits - 1 - DBL_DIG every value but zero lies in
 * [10^-(binary64Digits - 1), 10^(binary64Digits - 1)): below the greatest finite binary64, so float8in never
 * overflows to infinity, and above the least subnormal, 2^-1074, so it never underflows to zero, the two results
 * float8in refuses.
 */
const doubleExponentMax: Limit = derived({
	owner: "grizzle's lexical forms",
	unit: "a decimal exponent",
	scope: "the magnitude of a double precision lexical form's exponent",
	from: [binary64Digits, doubleMantissaDigits],
	derivation:
		"binary64Digits - 1 - DBL_DIG: the mantissa's own magnitude, up to DBL_DIG digits either side of its point, plus the exponent stays inside binary64's finite nonzero range",
	compute: ([digits, mantissa]) => digits.value - 1 - mantissa.value
})

/**
 * The integer form of a carrier: an optional sign, any leading zeros, and a magnitude within the carrier's range on
 * that sign's side.
 */
const integerForm = (carrier: "int2" | "int4" | "int8"): string => {
	const [lo, hi] = integerRanges[carrier]
	return `\\+?0*${numeralAtMost(hi)}|-0*${numeralAtMost(-lo)}`
}

/**
 * The decimal form of numeric(p, s), 0 <= s <= p: k = p - s significant integer digits after any leading zeros, and s
 * significant fraction digits before any trailing zeros, with a digit on one side of the point at least.
 */
const decimalForm = ({ precision, scale }: NumericTypmod): string => {
	const k = precision - scale
	const integer = k === 0 ? "0+" : integerDigits(k)
	return `[+-]?(?:${integer}(?:\\.${fractionDigits(scale, 0)})?|\\.${fractionDigits(scale, 1)})`
}

/** The double precision form: a bounded mantissa with an optional bounded exponent, or one of the special values. */
const doubleForm = (): string => {
	const m = doubleMantissaDigits.value
	const mantissa = `${integerDigits(m)}(?:\\.${fractionDigits(m, 0)})?|\\.${fractionDigits(m, 1)}`
	const exponent = `[eE][+-]?0*${numeralAtMost(BigInt(doubleExponentMax.value))}`
	return `[+-]?(?:${mantissa})(?:${exponent})?|-?INF|NaN`
}

/**
 * Every decimal text of a double: a mantissa of any digits with an optional exponent of any digits, or one of the
 * special spellings `INF`, `+INF`, `-INF` and `NaN`, the grammar of XML Schema 1.1's xs:double lexical space.
 */
const doubleTextForm = (): string =>
	"[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?INF|NaN"

/**
 * Every decimal text: a sign and digits on either side of a point, of any digits, the grammar of XML Schema 1.1's
 * xs:decimal lexical space.
 */
const decimalTextForm = (): string => "[+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)"

/** The proleptic Gregorian dates 0001-01-01 to 9999-12-31, leap days by the leap year rule over the year's digits. */
const dateForm = (): string => {
	const year = "(?:000[1-9]|00[1-9][0-9]|0[1-9][0-9]{2}|[1-9][0-9]{3})"
	const fourth = "(?:0[48]|[2468][048]|[13579][26])"
	const leapYear = `(?:[0-9]{2}${fourth}|${fourth}00)`
	const long = "(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])"
	const short = "(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)"
	const february = "02-(?:0[1-9]|1[0-9]|2[0-8])"
	return `${year}-(?:${long}|${short}|${february})|${leapYear}-02-29`
}

/**
 * The lexical form of a target, a pattern of the admitted grammar under flags "u" (scalar/regex/parse.ts), anchored at
 * both ends: what `str.regex` types a lexical field by, what Compute.matches guards a parse with, and what the parse's
 * totality is proved against.
 */
export const formSource = (target: LexicalTarget): string => {
	const body = ((): string => {
		switch (target.kind) {
			case "integer":
				return integerForm(target.carrier)
			case "decimal":
				return decimalForm(target.typmod)
			case "double":
				return doubleForm()
			case "boolean":
				return "true|false|1|0"
			case "date":
				return dateForm()
			case "doubleText":
				return doubleTextForm()
			case "decimalText":
				return decimalTextForm()
		}
	})()
	return `^(?:${body})$`
}

/**
 * The byte bound a form holds its members within beside its pattern, as str.bytes holds a pattern's: decimalText's,
 * decimalTextMaxBytes; none for every other form, whose pattern alone is the form.
 */
export const formOctets = (target: LexicalTarget): number | undefined => {
	switch (target.kind) {
		case "decimalText":
			return decimalTextMaxBytes.value
		case "integer":
		case "decimal":
		case "double":
		case "boolean":
		case "date":
		case "doubleText":
			return undefined
	}
}

/**
 * Whether every value of a conjunction's language is a member of a target's lexical form (regex/inclusion.ts): what
 * makes a parse of a value of that language total. The conjunction is a RegexRef's, admitted by the text analysis; every
 * automaton is read from `patterns`.
 */
export const formIncludes = (
	conjunction: Patterns,
	target: LexicalTarget,
	patterns: PatternAutomata
): Inclusion => patternIncludes(conjunction, [{ source: formSource(target), flags: "u" }], patterns)

/** A decimal numeral's sign and the digits on each side of its point, at least one digit in all. */
interface Numeral {
	readonly negative: boolean
	readonly integer: string
	readonly fraction: string
}

/** Whether a code unit is an ASCII digit. */
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39

/**
 * The numeral a text is, `[+-]?digits(.digits)?` with at least one digit on one side of the point, or undefined: the
 * mantissa of xs:decimal's and xs:double's lexical spaces, and xs:integer's with no point.
 */
const numeralOf = (text: string): Numeral | undefined => {
	const signed = text.startsWith("-") || text.startsWith("+")
	const start = signed ? 1 : 0
	let point = -1
	for (let i = start; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code === 0x2e && point < 0) {
			point = i
		} else if (!isDigit(code)) {
			return undefined
		}
	}
	const integer = point < 0 ? text.slice(start) : text.slice(start, point)
	const fraction = point < 0 ? "" : text.slice(point + 1)
	return integer.length + fraction.length === 0
		? undefined
		: { negative: text.startsWith("-"), integer, fraction }
}

/** The digits of a numeral's integer part past its leading zeros. */
const significantInteger = (digits: string): number => {
	let i = 0
	while (i < digits.length && digits.charCodeAt(i) === 0x30) {
		i++
	}
	return digits.length - i
}

/** The digits of a numeral's fraction before its trailing zeros. */
const significantFraction = (digits: string): number => {
	let end = digits.length
	while (end > 0 && digits.charCodeAt(end - 1) === 0x30) {
		end--
	}
	return end
}

/** The units and scale of a numeral: its digits as one integer, signed, and its fraction digits' count. */
const unitsOf = (n: Numeral): { readonly units: bigint; readonly scale: number } => {
	const magnitude = BigInt(`${n.integer}${n.fraction}`)
	return { units: n.negative ? -magnitude : magnitude, scale: n.fraction.length }
}

/** An integer a member names, within the carrier's range. */
const integerValue = (text: string, carrier: "int2" | "int4" | "int8"): bigint | undefined => {
	const n = numeralOf(text)
	if (n === undefined || n.fraction.length > 0 || n.integer.length === 0 || text.includes(".")) {
		return undefined
	}
	const value = BigInt(text)
	const [lo, hi] = integerRanges[carrier]
	return value < lo || value > hi ? undefined : value
}

/** A decimal a member names, with no more significant digits on either side of its point than the typmod holds. */
const decimalValue = (text: string, { precision, scale }: NumericTypmod): Decimal | undefined => {
	const n = numeralOf(text)
	if (
		n === undefined ||
		significantInteger(n.integer) > precision - scale ||
		significantFraction(n.fraction) > scale
	) {
		return undefined
	}
	const { units, scale: digits } = unitsOf(n)
	const made = Decimal.fromParts(units < 0n, units < 0n ? -units : units, digits)
	return made.ok ? made.value : undefined
}

/** The exponent of a double precision member, `[+-]?digits`, within the form's bound. */
const exponentValue = (text: string): number | undefined => {
	const n = numeralOf(text)
	if (n === undefined || n.fraction.length > 0 || n.integer.length === 0 || text.includes(".")) {
		return undefined
	}
	const value = Number(BigInt(text))
	return Math.abs(value) > doubleExponentMax.value ? undefined : value
}

/**
 * A double precision member: `NaN`, `INF`, `-INF`, or a mantissa of at most doubleMantissaDigits significant digits on
 * either side of its point with an optional exponent of magnitude at most doubleExponentMax, as the value its exact
 * rational `mantissa * 10^exponent` rounds to by `round`.
 */
const doubleValue = (
	text: string,
	round: (negative: boolean, num: bigint, den: bigint) => number
): number | undefined => {
	if (text === "NaN") {
		return Number.NaN
	}
	if (text === "INF" || text === "-INF") {
		return text === "INF" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
	}
	const e = Math.max(text.indexOf("e"), text.indexOf("E"))
	const n = numeralOf(e < 0 ? text : text.slice(0, e))
	const exponent = e < 0 ? 0 : exponentValue(text.slice(e + 1))
	const m = doubleMantissaDigits.value
	if (
		n === undefined ||
		exponent === undefined ||
		significantInteger(n.integer) > m ||
		significantFraction(n.fraction) > m
	) {
		return undefined
	}
	const { units, scale } = unitsOf({ ...n, negative: false })
	const shift = exponent - scale
	return shift >= 0
		? round(n.negative, units * 10n ** BigInt(shift), 1n)
		: round(n.negative, units, 10n ** BigInt(-shift))
}

/** Whether a text is an exponent's digits, `[+-]?[0-9]+`. */
const isExponent = (text: string): boolean => {
	const start = text.startsWith("-") || text.startsWith("+") ? 1 : 0
	if (text.length === start) {
		return false
	}
	for (let i = start; i < text.length; i++) {
		if (!isDigit(text.charCodeAt(i))) {
			return false
		}
	}
	return true
}

/**
 * Whether a text is a decimal text of a double (doubleTextForm), decided by a scan: `NaN`, an optionally signed `INF`,
 * or a numeral with an optional exponent.
 */
const isDoubleText = (text: string): boolean => {
	const e = Math.max(text.indexOf("e"), text.indexOf("E"))
	return (
		text === "NaN" ||
		text === "INF" ||
		text === "+INF" ||
		text === "-INF" ||
		(numeralOf(e < 0 ? text : text.slice(0, e)) !== undefined &&
			(e < 0 || isExponent(text.slice(e + 1))))
	)
}

/**
 * The double a decimal text of one names, by IEEE 754-2019's conversion from decimal character sequences: ECMAScript's
 * StringToNumber over the text with `INF` spelled `Infinity`, which reads exactly the form's members, its own spelling
 * of the infinities and NaN among them, and rounds a decimal's exact value to the nearest double, ties to even, with
 * ±Infinity past the greatest finite double and a zero of the mantissa's sign below half the least subnormal; undefined
 * for a text no member of the form.
 */
export const doubleOfText = (text: string): number | undefined =>
	isDoubleText(text) ? Number(text.replace("INF", "Infinity")) : undefined

/**
 * The value a decimal text names (decimalTextForm), by xs:decimal's lexical mapping: its digits, signed, over ten to
 * the count of its fraction digits, exactly, in Decimal's one form; undefined for a text no member of the form, one
 * past decimalTextMaxBytes among them. A member is ASCII, so its characters are its bytes.
 */
export const decimalOfText = (text: string): Decimal | undefined => {
	const n = numeralOf(text)
	if (n === undefined || text.length > decimalTextMaxBytes.value) {
		return undefined
	}
	const { units, scale } = unitsOf(n)
	const made = Decimal.fromParts(units < 0n, units < 0n ? -units : units, scale)
	return made.ok ? made.value : undefined
}

/**
 * The value a text names under a target's lexical form, or undefined when it is no member of the form: the form
 * decided again by a scan of the text, never by its pattern, so the two definitions of each form are held to agree
 * (test/unit/scalar/lexical.test.ts). The value is the one XML Schema's lexical mapping gives the member and
 * PostgreSQL's input function reads from it: an integer exactly; a decimal exactly, which the form leaves unrounded at
 * the typmod; a double rounded once, half to even, from its exact rational value by `round`; a boolean by its literal;
 * a date as its own text; a double's decimal text by doubleOfText; a decimal text by decimalOfText.
 */
export const lexicalValue = (
	target: LexicalTarget,
	text: string,
	round: (negative: boolean, num: bigint, den: bigint) => number
): LexicalValue | undefined => {
	switch (target.kind) {
		case "integer":
			return integerValue(text, target.carrier)
		case "decimal":
			return decimalValue(text, target.typmod)
		case "double":
			return doubleValue(text, round)
		case "boolean":
			return text === "true" || text === "1"
				? true
				: text === "false" || text === "0"
					? false
					: undefined
		case "date": {
			const date = toCalendarDate(text)
			return date.ok ? date.value : undefined
		}
		case "doubleText":
			return doubleOfText(text)
		case "decimalText":
			return decimalOfText(text)
	}
}

/**
 * lexicalForm(T): the lexical form of a field descriptor's type, a pattern under flags "u" for `str.regex` to type a
 * lexical field by and for Compute.matches to guard a parse with, so a text of the form casts into T total
 * (Compute.cast). A contract's form is its base's, which a cast into the contract parses, then enters the contract by
 * its predicate's proof: date's, whose range is the form's own. A type with no form is refused, UnsupportedOperation.
 */
export const lexicalFormOf = (type: unknown): string => {
	const loc = captureLoc("lexicalForm", [])
	const target = lexicalTargetOf(baseOf(describeFieldOrThrow(type, loc).scalar))
	if (target === undefined) {
		throw unsupported(
			loc,
			"lexicalForm of a type with a lexical form: an integer type, numeric(p, s) with 0 <= s <= p, double precision, boolean or date"
		)
	}
	return formSource(target)
}
