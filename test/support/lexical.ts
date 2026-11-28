import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import {
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { type Array as Arr, DateTime, Record as Rec, String as Str } from "effect"
import { integerRanges } from "#compiler/ir/carriers.ts"
import { numericTextMaxBytes, type LexicalTarget } from "#compiler/scalar/lexical.ts"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { numericMaxIntegerDigits } from "#compiler/scalar/values/fault.ts"
import { referenceDecimal } from "#test/support/oracle/evaluate/decimal-text.ts"
import { referenceDouble } from "#test/support/oracle/evaluate/double-text.ts"

/**
 * Candidates for the lexical forms (scalar/lexical.ts), shared by the unit suite and the PostgreSQL differential: each
 * built from the parts XML Schema's lexical space spells (sign, digits either side of a point, exponent; year, month,
 * day), near every boundary a form draws, with whether the specification makes it a member and the value it names,
 * read from those parts alone; and named corruptions of the members.
 */
/** The digits of a numeral past its leading zeros. */
const significantLeading = (digitsText: string): number => {
	let i = 0
	while (i < digitsText.length && digitsText[i] === "0") {
		i++
	}
	return digitsText.length - i
}

/** The digits of a fraction before its trailing zeros. */
const significantTrailing = (digitsText: string): number => {
	let end = digitsText.length
	while (end > 0 && digitsText[end - 1] === "0") {
		end--
	}
	return end
}

const digit = characterOf(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"])
const digits = (min: number, max: number): Gen<string> => string(digit, { min, max })
const sign = weighted([
	[2, constant("")],
	[1, constant("+")],
	[1, constant("-")]
])

/**
 * The exact integers' digits a candidate's target draws: a few, so its texts stay short at its byte bound, in bigint's
 * space (at most int8ExactDigits) and past it in numeric's.
 */
const exactDigits = [1, 2, 3, 6, 19, 20] as const

/**
 * The lexical targets, one generator per kind of LexicalTarget, so a kind the type gains is a missing key here: an
 * integer carrier of the carriers' ranges, an exact integer of exactDigits, numeric(p, s) for every precision up to
 * `maxPrecision` and every scale from 0 to p, and the double, boolean and date forms.
 */
const targetsOfKind = (
	maxPrecision: number
): {
	readonly [K in LexicalTarget["kind"]]: Gen<Extract<LexicalTarget, { readonly kind: K }>>
} => ({
	integer: map(element(nonEmpty(Rec.keys(integerRanges), "the integer carriers")), (carrier) => ({
		kind: "integer",
		carrier
	})),
	exactInteger: map(element(exactDigits), (digits) => ({ kind: "exactInteger", digits })),
	decimal: (source) => {
		const precision = source.draw(int(1, maxPrecision))
		return { kind: "decimal", typmod: { precision, scale: source.draw(int(0, precision)) } }
	},
	double: constant({ kind: "double" }),
	boolean: constant({ kind: "boolean" }),
	date: constant({ kind: "date" }),
	float8Text: constant({ kind: "float8Text" }),
	numericText: constant({ kind: "numericText" })
})

/** A target of any kind, each kind alike. */
export const targetGen = (maxPrecision: number): Gen<LexicalTarget> =>
	oneOf<LexicalTarget>(nonEmpty(Rec.values(targetsOfKind(maxPrecision)), "a generator per kind"))

/** The greatest precision of a candidate's numeric target, whose texts stay a few digits long. */
const candidateMaxPrecision = 6

/** A target of a type's form, a field's: every kind but a double's text and a decimal text, which are no type's. */
export type TypeTarget = Exclude<LexicalTarget, { readonly kind: "float8Text" | "numericText" }>

const candidateTargets = targetsOfKind(candidateMaxPrecision)

/**
 * A type's target a literal of it is a value of, as candidateGen draws one: an integer carrier, numeric(p, s), double
 * precision, boolean or date; every type's target but an exact integer's, of which no literal is a value
 * (scalar/compute/literal.ts), so an accumulated field of it starts nowhere.
 */
export type StartedTarget = Exclude<TypeTarget, { readonly kind: "exactInteger" }>

export const startedTargetGen: Gen<StartedTarget> = oneOf<StartedTarget>([
	candidateTargets.integer,
	candidateTargets.decimal,
	candidateTargets.double,
	candidateTargets.boolean,
	candidateTargets.date
])

/**
 * A type's target: a started one (startedTargetGen), or an exact integer field's, at numeric's own limit
 * (scalar/exact.ts exactInteger), the one exact integer a field declares, each kind alike.
 */
export const typeTargetGen: Gen<TypeTarget> = weighted<TypeTarget>([
	[5, startedTargetGen],
	[1, constant({ kind: "exactInteger", digits: numericMaxIntegerDigits })]
])

/** A candidate text, whether the specification makes it a member, and the value it names when it is one. */
export interface Candidate {
	readonly target: LexicalTarget
	readonly text: string
	readonly member: boolean
	readonly value: bigint | Numeric | number | boolean | string | undefined
	readonly shape: Shape
}

export type Shape =
	| "integer in range"
	| "integer past range"
	| "exact integer within bytes"
	| "exact integer past bytes"
	| "decimal fits"
	| "decimal past typmod"
	| "double finite"
	| "double zero"
	| "double special"
	| "double past bound"
	| "boolean"
	| "date valid"
	| "date invalid"
	| "double text finite"
	| "double text special"
	| "double text no special"
	| "decimal text"
	| "decimal text past bytes"
	| "corrupted"

export const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	"integer in range",
	"integer past range",
	"exact integer within bytes",
	"exact integer past bytes",
	"decimal fits",
	"decimal past typmod",
	"double finite",
	"double zero",
	"double special",
	"double past bound",
	"boolean",
	"date valid",
	"date invalid",
	"double text finite",
	"double text special",
	"double text no special",
	"decimal text",
	"decimal text past bytes",
	"corrupted"
]

/** An integer near one of its carrier's ends, spelled with a sign and leading zeros. */
const integerGen =
	(carrier: "int2" | "int4" | "int8"): Gen<Candidate> =>
	(source) => {
		const [lo, hi] = integerRanges[carrier]
		const end = source.draw(element([lo, hi, 0n]))
		const offset = BigInt(source.draw(int(-2, 2)))
		const value = source.draw(element([end + offset, BigInt(source.draw(int(-999, 999)))]))
		const zeros = Str.repeat(source.draw(int(0, 3)))("0")
		const plus = value >= 0n && source.draw(element([false, true]))
		const text = `${value < 0n ? "-" : plus ? "+" : ""}${zeros}${value < 0n ? -value : value}`
		const member = value >= lo && value <= hi
		return {
			target: { kind: "integer", carrier },
			text,
			member,
			value: member ? value : undefined,
			shape: member ? "integer in range" : "integer past range"
		}
	}

/**
 * An exact integer of `digits` digits: a sign and a numeral of a drawn few digits or of the digits its byte bound leaves
 * the sign, one fewer or one more, leading zeros among them, a member exactly where it is within `digits` bytes. A long
 * numeral is a drawn head of digits padded with zeros, so a field's target, at numeric's own limit, draws no digit per
 * byte.
 */
const exactIntegerGen =
	(bound: number): Gen<Candidate> =>
	(source) => {
		const s = source.draw(sign)
		const room = bound - s.length
		const length = source.draw(
			element([source.draw(int(1, 3)), Math.max(room - 1, 1), Math.max(room, 1), room + 1])
		)
		const head = source.draw(digits(1, Math.min(length, 3)))
		const text = `${s}${head}${Str.repeat(length - head.length)("0")}`
		const member = text.length <= bound
		return {
			target: { kind: "exactInteger", digits: bound },
			text,
			member,
			value: member ? BigInt(text) : undefined,
			shape: member ? "exact integer within bytes" : "exact integer past bytes"
		}
	}

/** A decimal of drawn integer and fraction digits, leading and trailing zeros among them, against a typmod. */
const decimalGen =
	(precision: number, scale: number): Gen<Candidate> =>
	(source) => {
		const integer = source.draw(digits(0, precision - scale + 1))
		const fraction = source.draw(digits(0, scale + 1))
		const point = fraction.length > 0 || source.draw(element([false, true]))
		const s = source.draw(sign)
		const body = `${integer}${point ? "." : ""}${fraction}`
		const text = `${s}${body}`
		const significantInteger = significantLeading(integer)
		const significantFraction = significantTrailing(fraction)
		const spelled = integer.length + fraction.length > 0
		const member =
			spelled && significantInteger <= precision - scale && significantFraction <= scale
		const magnitude = spelled ? BigInt(`${integer}${fraction}`) : 0n
		const value = Numeric.fromParts(s === "-" && magnitude !== 0n, magnitude, fraction.length)
		return {
			target: { kind: "decimal", typmod: { precision, scale } },
			text,
			member,
			value: member && value.ok ? value.value : undefined,
			shape: member ? "decimal fits" : "decimal past typmod"
		}
	}

/**
 * A double: a mantissa of drawn digits with an optional exponent near the bound, a zero of either sign spelled with
 * leading and trailing zeros and an exponent, or a special value.
 */
const doubleGen: Gen<Candidate> = oneOf<Candidate>([
	map(element(["NaN", "INF", "-INF", "+INF", "nan", "Infinity"]), (text) => ({
		target: { kind: "double" },
		text,
		member: text === "NaN" || text === "INF" || text === "-INF",
		value:
			text === "NaN"
				? Number.NaN
				: text === "INF"
					? Number.POSITIVE_INFINITY
					: text === "-INF"
						? Number.NEGATIVE_INFINITY
						: undefined,
		shape: "double special"
	})),
	(source) => {
		const integer = source.draw(digits(1, 17))
		const fraction = source.draw(digits(0, 17))
		const exponent = source.draw(element([undefined, 0, 1, -1, 293, -293, 294, -294, 120]))
		const s = source.draw(sign)
		const text = `${s}${integer}${fraction.length > 0 ? `.${fraction}` : ""}${exponent === undefined ? "" : `e${exponent}`}`
		const member =
			significantLeading(integer) <= 15 &&
			significantTrailing(fraction) <= 15 &&
			(exponent === undefined || Math.abs(exponent) <= 293)
		return {
			target: { kind: "double" },
			text,
			member,
			value: member ? Number(text) : undefined,
			shape: member ? "double finite" : "double past bound"
		}
	},
	(source) => {
		const s = source.draw(sign)
		const integer = Str.repeat(source.draw(int(1, 3)))("0")
		const fraction = Str.repeat(source.draw(int(0, 3)))("0")
		const exponent = source.draw(element([undefined, 0, -1, 293, -293]))
		const text = `${s}${integer}${fraction.length > 0 ? `.${fraction}` : ""}${exponent === undefined ? "" : `e${exponent}`}`
		return {
			target: { kind: "double" },
			text,
			member: true,
			value: Number(text),
			shape: "double zero"
		}
	}
])

/** A boolean literal or a spelling boolin reads that xs:boolean does not. */
const booleanGen: Gen<Candidate> = map(
	element(["true", "false", "1", "0", "TRUE", "t", "yes", "on", "01", " true", ""]),
	(text) => ({
		target: { kind: "boolean" },
		text,
		member: text === "true" || text === "false" || text === "1" || text === "0",
		value:
			text === "true" || text === "1" ? true : text === "false" || text === "0" ? false : undefined,
		shape: "boolean"
	})
)

/**
 * The UTC midnight a year, month and day name in Effect's DateTime, whose parts are ECMAScript's proleptic Gregorian
 * calendar (setUTCFullYear): a year of any number, a month or day out of its range carried into the next, so a day the
 * calendar lacks names another. It shares nothing with the engine's own day arithmetic (ir/date.ts), which the oracle
 * judges.
 */
const midnight = (year: number, month: number, day: number): DateTime.Utc =>
	DateTime.makeUnsafe({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 })

/** Whether a year, month and day are a date of the proleptic Gregorian calendar, and within the form. */
const calendarDate = (year: number, month: number, day: number): boolean => {
	const parts = DateTime.toPartsUtc(midnight(year, month, day))
	return (
		year >= 1 && year <= 9999 && parts.year === year && parts.month === month && parts.day === day
	)
}

/** The milliseconds of a calendar day, which UTC counts without leap seconds. */
const dayMillis = 86_400_000

/** A date's days after 0001-01-01, as the proleptic Gregorian calendar counts them. */
export const dateDays = (year: number, month: number, day: number): number =>
	Math.round(
		(DateTime.toEpochMillis(midnight(year, month, day)) -
			DateTime.toEpochMillis(midnight(1, 1, 1))) /
			dayMillis
	)

/** A date near the calendar's corners: leap days, month ends, years 0000, 0001, 9999 and 10000. */
const dateGen: Gen<Candidate> = (source) => {
	const year = source.draw(
		element([0, 1, 4, 100, 400, 1900, 2000, 2023, 2024, 9999, 10000, source.draw(int(0, 9999))])
	)
	const month = source.draw(
		weighted([
			[2, constant(2)],
			[1, constant(1)],
			[1, constant(4)],
			[1, constant(12)],
			[1, constant(13)],
			[1, constant(0)],
			[1, int(1, 12)]
		])
	)
	const day = source.draw(element([28, 29, 30, 31, 1, 0, 32, source.draw(int(1, 31))]))
	const text = `${Str.padStart(4, "0")(String(year))}-${Str.padStart(2, "0")(String(month))}-${Str.padStart(2, "0")(String(day))}`
	const member = calendarDate(year, month, day)
	return {
		target: { kind: "date" },
		text,
		member,
		value: member ? text : undefined,
		shape: member ? "date valid" : "date invalid"
	}
}

/** An exact decimal of no sign: its digits as one integer and the power of ten that scales them. */
interface ExactDecimal {
	readonly digits: bigint
	readonly scale: bigint
}

/** The exact decimal of m * 2^e. */
const exactOfBinary = (m: bigint, e: number): ExactDecimal =>
	e >= 0
		? { digits: m << BigInt(e), scale: 0n }
		: { digits: m * 5n ** BigInt(-e), scale: BigInt(e) }

/** A whole number of `bits` bits, drawn in halves of at most 26 bits each. */
const bitsGen =
	(bits: number): Gen<bigint> =>
	(source) => {
		const high = Math.max(bits - 26, 0)
		const top = BigInt(source.draw(int(0, 2 ** high - 1)))
		return (
			(top << BigInt(Math.min(bits, 26))) | BigInt(source.draw(int(0, 2 ** Math.min(bits, 26) - 1)))
		)
	}

/** A binary exponent of a normal double, most often at either end of the range or near 2^0. */
const binadeGen: Gen<number> = weighted([
	[2, int(-1022, -990)],
	[2, int(990, 1023)],
	[3, int(-60, 120)],
	[1, int(-1022, 1023)]
])

/**
 * A point of binary64 a conversion's rounding turns on, or a double: the greatest finite double, the overflow
 * threshold midway past it, the least normal, a subnormal, half the least subnormal, a double of a drawn binade, and
 * the midpoint between two neighbouring doubles, a subnormal's among them, where a decimal on it is a tie.
 */
const binaryPointGen: Gen<ExactDecimal> = weighted([
	[1, constant(exactOfBinary((1n << 53n) - 1n, 971))],
	[1, constant(exactOfBinary((1n << 54n) - 1n, 970))],
	[1, constant(exactOfBinary(1n, -1022))],
	[1, constant(exactOfBinary(1n, -1075))],
	[
		2,
		(source) =>
			exactOfBinary(
				source.draw(
					oneOf([constant(1n), constant(2n), constant(3n), bitsGen(52), constant((1n << 52n) - 1n)])
				),
				-1074
			)
	],
	[
		2,
		(source) => exactOfBinary(source.draw(bitsGen(52)) | (1n << 52n), source.draw(binadeGen) - 52)
	],
	[
		4,
		(source) =>
			exactOfBinary(2n * (source.draw(bitsGen(52)) | (1n << 52n)) + 1n, source.draw(binadeGen) - 53)
	],
	[2, (source) => exactOfBinary(2n * source.draw(bitsGen(52)) + 1n, -1075)]
])

/**
 * A decimal at or beside a point: the point itself, its digits cut short (just below), one more digit of 1 after them
 * (just above), its last digit one more or one less, or its 17 leading digits.
 */
const besideGen = (point: ExactDecimal): Gen<ExactDecimal> =>
	weighted([
		[3, constant(point)],
		[
			2,
			(source) => {
				const width = point.digits.toString().length
				const cut = source.draw(int(1, Math.max(width - 1, 1)))
				return { digits: point.digits / 10n ** BigInt(cut), scale: point.scale + BigInt(cut) }
			}
		],
		[
			2,
			(source) => {
				const zeros = BigInt(source.draw(int(0, 3)))
				return { digits: point.digits * 10n ** (zeros + 1n) + 1n, scale: point.scale - zeros - 1n }
			}
		],
		[1, constant({ digits: point.digits + 1n, scale: point.scale })],
		[1, constant({ digits: point.digits > 1n ? point.digits - 1n : 1n, scale: point.scale })],
		[
			1,
			() => {
				const excess = BigInt(Math.max(point.digits.toString().length - 17, 0))
				return { digits: point.digits / 10n ** excess, scale: point.scale + excess }
			}
		]
	])

/** Digits of 1 to 40 places, the first nonzero. */
const digitsValueGen: Gen<bigint> = (source) =>
	BigInt(
		`${source.draw(characterOf(["1", "2", "3", "4", "5", "6", "7", "8", "9"]))}${source.draw(digits(0, 39))}`
	)

/** A decimal exponent near either threshold, near 10^0, or far past both. */
const scaleGen: Gen<bigint> = weighted([
	[3, map(int(-370, -300), BigInt)],
	[3, map(int(280, 330), BigInt)],
	[2, map(int(-30, 30), BigInt)],
	[
		1,
		(source) => {
			const magnitude = 10n ** BigInt(source.draw(int(3, 30))) + BigInt(source.draw(int(0, 999)))
			return source.draw(boolean) ? -magnitude : magnitude
		}
	]
])

/** A decimal a double's text names: a point of binary64 or beside it, digits at a drawn exponent, or zero. */
const doubleDecimalGen: Gen<ExactDecimal> = weighted([
	[6, (source) => source.draw(besideGen(source.draw(binaryPointGen)))],
	[3, (source) => ({ digits: source.draw(digitsValueGen), scale: source.draw(scaleGen) })],
	[1, (source) => ({ digits: 0n, scale: source.draw(scaleGen) })]
])

/** An exponent's text: its letter, a sign where it needs or may take one, and a few leading zeros. */
const exponentText =
	(exponent: bigint): Gen<string> =>
	(source) => {
		const sign =
			exponent < 0n
				? "-"
				: source.draw(
						weighted([
							[2, constant("")],
							[1, constant("+")]
						])
					)
		const zeros = Str.repeat(source.draw(int(0, 2)))("0")
		return `${source.draw(element(["e", "E"]))}${sign}${zeros}${exponent < 0n ? -exponent : exponent}`
	}

/**
 * A decimal spelled as a double's text: an optional sign, its digits with the point moved and the exponent moved with
 * it (past the digits, so a fraction of leading zeros, or before them, so trailing zeros), leading zeros, a bare
 * fraction `.5`, a trailing point `5.`, and the exponent omitted where it is zero and the draw says so.
 */
const spelledGen =
	(negative: boolean, value: ExactDecimal): Gen<string> =>
	(source) => {
		const appended = BigInt(
			source.draw(
				weighted([
					[4, constant(0)],
					[1, int(1, 600)]
				])
			)
		)
		const body = (value.digits * 10n ** appended).toString()
		const shift = source.draw(int(0, body.length + 3))
		const integer = shift <= body.length ? Str.slice(0, body.length - shift)(body) : ""
		const fraction =
			shift <= body.length
				? Str.slice(body.length - shift)(body)
				: `${Str.repeat(shift - body.length)("0")}${body}`
		const exponent = value.scale - appended + BigInt(shift)
		const lead = Str.repeat(source.draw(int(0, 2)))("0")
		const point =
			fraction.length > 0
				? `.${fraction}${Str.repeat(source.draw(int(0, 2)))("0")}`
				: source.draw(
						weighted([
							[2, constant("")],
							[1, constant(".")],
							[1, constant(".0")]
						])
					)
		const whole = integer.length > 0 ? `${lead}${integer}` : source.draw(element(["", "0", lead]))
		const mantissa = whole.length === 0 && point.length < 2 ? `0${point}` : `${whole}${point}`
		const sign = negative
			? "-"
			: source.draw(
					weighted([
						[2, constant("")],
						[1, constant("+")]
					])
				)
		const omitted = exponent === 0n && source.draw(boolean)
		return `${sign}${mantissa}${omitted ? "" : source.draw(exponentText(exponent))}`
	}

/**
 * A decimal text of a double, every one a member of its form: a special spelling (`INF`, `-INF`, `NaN`), or a
 * decimal at or beside a point binary64's rounding turns on, digits at an exponent near either threshold or far past
 * both, or zero, of either sign, spelled every way the form admits.
 */
export const doubleTextGen: Gen<string> = weighted([
	[1, element(["INF", "-INF", "NaN"])],
	[9, (source) => source.draw(spelledGen(source.draw(boolean), source.draw(doubleDecimalGen)))]
])

const nonzeroDigit = characterOf(["1", "2", "3", "4", "5", "6", "7", "8", "9"])

/** `count` digits, a drawn head, a run of one drawn digit and a drawn tail, so thousands of digits cost a few draws. */
const runOfDigits =
	(count: number): Gen<string> =>
	(source) => {
		const head = source.draw(digits(0, Math.min(count, 24)))
		const tail = source.draw(digits(0, Math.min(count - head.length, 6)))
		const run = Str.repeat(count - head.length - tail.length)(source.draw(digit))
		return `${head}${run}${tail}`
	}

/**
 * A count of digits from `low` to `high`, most often at an edge a decimal's parse turns on: a few; 253 to 258, about
 * the widest numeric(p, s) form's 256 integer and 255 fraction digits; or the most the form's bytes leave, `high`.
 */
const countWithin = (low: number, high: number): Gen<number> =>
	map(
		weighted([
			[3, int(low, Math.min(low + 5, high))],
			[3, int(253, 258)],
			[2, int(Math.max(high - 3, low), high)],
			[1, int(low, high)]
		]),
		(n) => Math.min(Math.max(n, low), high)
	)

/** A count of zeros, most often none, at the edge of a part's `count` digits now and then: how many lead or trail. */
const zerosWithin = (count: number): Gen<number> =>
	map(
		weighted([
			[5, constant(0)],
			[2, int(1, 3)],
			[1, int(0, count)]
		]),
		(n) => Math.min(n, count)
	)

/** An integer part of `count` digits, past any leading zeros its first nonzero one. */
const integerPart =
	(count: number): Gen<string> =>
	(source) => {
		const zeros = source.draw(zerosWithin(count))
		return zeros === count
			? Str.repeat(count)("0")
			: `${Str.repeat(zeros)("0")}${source.draw(nonzeroDigit)}${source.draw(runOfDigits(count - zeros - 1))}`
	}

/** A fraction part of `count` digits, before any trailing zeros its last nonzero one. */
const fractionPart =
	(count: number): Gen<string> =>
	(source) => {
		const zeros = source.draw(zerosWithin(count))
		return zeros === count
			? Str.repeat(count)("0")
			: `${source.draw(runOfDigits(count - zeros - 1))}${source.draw(nonzeroDigit)}${Str.repeat(zeros)("0")}`
	}

/** How a decimal text spells its point: none, a trailing one, digits on both sides, a bare fraction. */
type DecimalSpelling = "integer" | "trailing point" | "both" | "bare fraction"

/**
 * A decimal text within `bytes` bytes, a member of the grammar of xs:decimal's lexical space: an optional sign, then an
 * integer, an integer and a trailing point, digits either side of a point, or a bare fraction, each part's count of
 * digits at an edge (countWithin), leading and trailing zeros among them, its last digit ending at `bytes` now and then.
 */
const decimalWithin =
	(bytes: number): Gen<string> =>
	(source) => {
		const s = source.draw(sign)
		const room = bytes - s.length
		const spelling = source.draw(
			element<DecimalSpelling>(["integer", "trailing point", "both", "bare fraction"])
		)
		switch (spelling) {
			case "integer":
				return `${s}${source.draw(integerPart(source.draw(countWithin(1, room))))}`
			case "trailing point":
				return `${s}${source.draw(integerPart(source.draw(countWithin(1, room - 1))))}.`
			case "both": {
				const integer = source.draw(countWithin(1, room - 2))
				const fraction = source.draw(countWithin(1, room - 1 - integer))
				return `${s}${source.draw(integerPart(integer))}.${source.draw(fractionPart(fraction))}`
			}
			case "bare fraction":
				return `${s}.${source.draw(fractionPart(source.draw(countWithin(1, room - 1))))}`
		}
	}

/**
 * A member of numericText's form: a decimal text within numericTextMaxBytes, at the digit counts the widest numeric(p, s)
 * form and the form's own bytes turn on, or a spelling of zero.
 */
export const decimalTextGen: Gen<string> = weighted([
	[1, element(["0", "-0", "+0", "0.", ".0", "-.000", "000", "-0.0"])],
	[9, decimalWithin(numericTextMaxBytes)]
])

/**
 * A decimal text's candidate: a member of the grammar, of the form where it is within numericTextMaxBytes, its value the
 * one xs:decimal's lexical mapping gives it (test/support/oracle/evaluate/decimal-text.ts).
 */
const decimalCandidate = (target: LexicalTarget, text: string): Candidate => {
	const read = defined(referenceDecimal(text), "a member of the grammar")
	const value = Numeric.fromParts(read.negative, read.digits, Number(read.scale))
	const member = text.length <= numericTextMaxBytes
	return {
		target,
		text,
		member,
		value: member && value.ok ? value.value : undefined,
		shape: member ? "decimal text" : "decimal text past bytes"
	}
}

/** One corruption of a member: a space, a doubled sign or point, a letter, or nothing left. */
const corruptions = [" ", "+-", "..", "x", ""] as const

/** The candidates of a target's form. */
const candidatesOf = (target: LexicalTarget): Gen<Candidate> => {
	switch (target.kind) {
		case "integer":
			return integerGen(target.carrier)
		case "exactInteger":
			return exactIntegerGen(target.digits)
		case "decimal":
			return decimalGen(target.typmod.precision, target.typmod.scale)
		case "double":
			return doubleGen
		case "boolean":
			return booleanGen
		case "date":
			return dateGen
		case "float8Text":
			return weighted<Candidate>([
				[
					9,
					map(doubleTextGen, (text) => ({
						target,
						text,
						member: true,
						value: referenceDouble(text),
						shape:
							text === "NaN" || Str.endsWith("INF")(text)
								? "double text special"
								: "double text finite"
					}))
				],
				[
					1,
					map(element(["+INF", "inf", "Infinity", "nan", "-NaN"]), (text) => ({
						target,
						text,
						member: false,
						value: undefined,
						shape: "double text no special"
					}))
				]
			])
		case "numericText":
			return map(
				weighted([
					[4, decimalTextGen],
					[1, decimalWithin(numericTextMaxBytes + 3)]
				]),
				(text) => decimalCandidate(target, text)
			)
	}
}

/** A candidate of `target`'s form: a member, or one in four a member corrupted, which is none. */
export const candidateOf =
	(target: LexicalTarget): Gen<Candidate> =>
	(source) => {
		const base = source.draw(candidatesOf(target))
		const corruption = source.draw(
			weighted<(typeof corruptions)[number] | undefined>([
				[3, constant(undefined)],
				[1, element(corruptions)]
			])
		)
		if (corruption === undefined || !base.member) {
			return base
		}
		const text = corruption === "" ? "" : `${base.text}${corruption}`
		return { ...base, text, member: false, value: undefined, shape: "corrupted" }
	}

/** A candidate of any target's form, its numeric targets of at most candidateMaxPrecision digits. */
export const candidateGen: Gen<Candidate> = (source) =>
	source.draw(candidateOf(source.draw(targetGen(candidateMaxPrecision))))

/** Two values of a target's host type are one value: a Numeric by equals, a double by Object.is, -0 apart from 0. */
export const sameValue = (a: unknown, b: unknown): boolean =>
	a instanceof Numeric && b instanceof Numeric ? a.equals(b) : Object.is(a, b)
