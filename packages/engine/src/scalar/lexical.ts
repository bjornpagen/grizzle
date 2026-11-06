import { defect } from "#compiler/core/invariant.ts"
import { derived, type Limit, regexMaxRepeat } from "#compiler/core/limits.ts"
import * as Result from "#compiler/core/result.ts"
import { binary64DecimalDigits, binary64Digits, integerRanges } from "#compiler/ir/carriers.ts"
import { contractOf, type NumericTypmod, type ScalarType } from "#compiler/ir/scalar.ts"
import { type Inclusion, inclusion } from "#compiler/scalar/regex/inclusion.ts"
import { buildNfa, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { type CalendarDate, toCalendarDate } from "#compiler/ir/date.ts"
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
 */
export type LexicalTarget =
	| { readonly kind: "integer"; readonly carrier: "int2" | "int4" | "int8" }
	| { readonly kind: "decimal"; readonly typmod: NumericTypmod }
	| { readonly kind: "double" }
	| { readonly kind: "boolean" }
	| { readonly kind: "date" }

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
			return typmod !== undefined && decimalWritable(typmod) ? { kind: "decimal", typmod } : undefined
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
		case "code":
		case "bits":
		case "range4":
		case "range8":
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
export const numeralAtMost = (n: bigint): string => {
	const digits = n.toString()
	const width = digits.length
	const shorter = width > 1 ? [`[1-9]${repeat("[0-9]", 0, width - 2)}`] : []
	const below = [...digits].flatMap((d, i): ReadonlyArray<string> => {
		const least = i === 0 ? 1 : 0
		const v = Number(d)
		return v > least
			? [`${digits.slice(0, i)}${digitClass(least, v - 1)}${repeat("[0-9]", width - 1 - i, width - 1 - i)}`]
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
	scope: "the significant digits of a double precision lexical form's mantissa, before its point and after it",
	from: [binary64DecimalDigits],
	derivation: "DBL_DIG: every decimal of that many significant digits rounds to a binary64 value and back unchanged",
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
export const lexicalForm = (target: LexicalTarget): string => {
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
		}
	})()
	return `^(?:${body})$`
}

/** The automaton of a pattern the admitted grammar reads; a form or a RegexRef's pattern, which always parses. */
const nfaOf = (source: string, flags: "u" | "su"): Nfa => {
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		throw defect(`a pattern the admitted grammar reads: /${source}/${flags}`)
	}
	return buildNfa(parsed.value)
}

/**
 * Whether every value of a pattern's language is a member of a target's lexical form (regex/inclusion.ts): what makes
 * a parse of a value of that language total. A pattern is a RegexRef's, admitted by the text analysis.
 */
export const formIncludes = (
	pattern: { readonly source: string; readonly flags: "u" | "su" },
	target: LexicalTarget
): Inclusion => inclusion(nfaOf(pattern.source, pattern.flags), nfaOf(lexicalForm(target), "u"))

/** A member's sign and the digits on each side of its point, which the form makes a decimal numeral. */
const numeral = (
	text: string
): { readonly negative: boolean; readonly integer: string; readonly fraction: string } => {
	const negative = text.startsWith("-")
	const unsigned = text.startsWith("-") || text.startsWith("+") ? text.slice(1) : text
	const point = unsigned.indexOf(".")
	return point < 0
		? { negative, integer: unsigned, fraction: "" }
		: { negative, integer: unsigned.slice(0, point), fraction: unsigned.slice(point + 1) }
}

/** The units and scale of a numeral: its digits as one integer, and its fraction digits' count. */
const unitsOf = (n: ReturnType<typeof numeral>): { readonly units: bigint; readonly scale: number } => {
	const digits = `${n.integer}${n.fraction}`
	const magnitude = digits === "" ? 0n : BigInt(digits)
	return { units: n.negative ? -magnitude : magnitude, scale: n.fraction.length }
}

/** The rational a double precision member names, `mantissa * 10^exponent`, as its sign, numerator and denominator. */
const doubleRational = (
	text: string
): { readonly negative: boolean; readonly num: bigint; readonly den: bigint } => {
	const e = Math.max(text.indexOf("e"), text.indexOf("E"))
	const mantissa = e < 0 ? text : text.slice(0, e)
	const exponent = e < 0 ? 0 : Number(text.slice(e + 1))
	const n = numeral(mantissa)
	const { units, scale } = unitsOf({ ...n, negative: false })
	const shift = exponent - scale
	return shift >= 0
		? { negative: n.negative, num: units * 10n ** BigInt(shift), den: 1n }
		: { negative: n.negative, num: units, den: 10n ** BigInt(-shift) }
}

/**
 * The value a member of a target's lexical form names, as XML Schema's lexical mapping gives it and PostgreSQL's input
 * function reads it: an integer exactly; a decimal exactly, at the typmod's scale, which the form leaves unrounded; a
 * double rounded once, half to even, from its exact rational value by `round`; a boolean by its literal; a date as its
 * own text. A text that is no member is a defect: a parse stands only where its form is proved.
 */
export const lexicalValue = (
	target: LexicalTarget,
	text: string,
	round: (negative: boolean, num: bigint, den: bigint) => number
): Result.Result<LexicalValue, "lexical"> => {
	switch (target.kind) {
		case "integer":
			return Result.ok(BigInt(text))
		case "decimal": {
			const { units, scale } = unitsOf(numeral(text))
			const made = Decimal.fromParts(units < 0n, units < 0n ? -units : units, scale)
			return made.ok ? Result.ok(made.value) : Result.err("lexical")
		}
		case "double": {
			if (text === "NaN") {
				return Result.ok(Number.NaN)
			}
			if (text === "INF" || text === "-INF") {
				return Result.ok(text === "INF" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)
			}
			const { negative, num, den } = doubleRational(text)
			return Result.ok(round(negative, num, den))
		}
		case "boolean":
			return Result.ok(text === "true" || text === "1")
		case "date":
			return Result.mapError(toCalendarDate(text), () => "lexical" as const)
	}
}
