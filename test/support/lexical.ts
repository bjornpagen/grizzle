import {
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	string
} from "@grizzle/testing/gen"
import { type Array as Arr, DateTime, Record as Rec, String as Str } from "effect"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { LexicalTarget } from "#compiler/scalar/lexical.ts"
import { Decimal } from "#compiler/scalar/values/decimal.ts"
import { nonEmpty } from "#test/support/assert.ts"

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
const sign = element(["", "", "+", "-"])

/**
 * The lexical targets, one generator per kind of LexicalTarget, so a kind the type gains is a missing key here: an
 * integer carrier of the carriers' ranges, numeric(p, s) for every precision up to `maxPrecision` and every scale from
 * 0 to p, and the double, boolean and date forms.
 */
export const targetGen = (maxPrecision: number): Gen<LexicalTarget> => {
	const ofKind: {
		readonly [K in LexicalTarget["kind"]]: Gen<Extract<LexicalTarget, { readonly kind: K }>>
	} = {
		integer: map(element(nonEmpty(Rec.keys(integerRanges), "the integer carriers")), (carrier) => ({
			kind: "integer",
			carrier
		})),
		decimal: (source) => {
			const precision = source.draw(int(1, maxPrecision))
			return { kind: "decimal", typmod: { precision, scale: source.draw(int(0, precision)) } }
		},
		double: constant({ kind: "double" }),
		boolean: constant({ kind: "boolean" }),
		date: constant({ kind: "date" })
	}
	return oneOf<LexicalTarget>(nonEmpty(Rec.values(ofKind), "a generator per kind"))
}

/** The greatest precision of a candidate's numeric target, whose texts stay a few digits long. */
const candidateMaxPrecision = 6

/** A candidate text, whether the specification makes it a member, and the value it names when it is one. */
export interface Candidate {
	readonly target: LexicalTarget
	readonly text: string
	readonly member: boolean
	readonly value: bigint | Decimal | number | boolean | string | undefined
	readonly shape: Shape
}

export type Shape =
	| "integer in range"
	| "integer past range"
	| "decimal fits"
	| "decimal past typmod"
	| "double finite"
	| "double special"
	| "double past bound"
	| "boolean"
	| "date valid"
	| "date invalid"
	| "corrupted"

export const shapes: Arr.NonEmptyReadonlyArray<Shape> = [
	"integer in range",
	"integer past range",
	"decimal fits",
	"decimal past typmod",
	"double finite",
	"double special",
	"double past bound",
	"boolean",
	"date valid",
	"date invalid",
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
		const value = Decimal.fromParts(s === "-" && magnitude !== 0n, magnitude, fraction.length)
		return {
			target: { kind: "decimal", typmod: { precision, scale } },
			text,
			member,
			value: member && value.ok ? value.value : undefined,
			shape: member ? "decimal fits" : "decimal past typmod"
		}
	}

/** A double: a mantissa of drawn digits with an optional exponent near the bound, or a special value. */
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
	const month = source.draw(element([2, 2, 1, 4, 12, 13, 0, source.draw(int(1, 12))]))
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

/** One corruption of a member: a space, a doubled sign or point, a letter, or nothing left. */
const corruptions = [" ", "+-", "..", "x", ""] as const

/** The candidates of a target's form. */
const candidatesOf = (target: LexicalTarget): Gen<Candidate> => {
	switch (target.kind) {
		case "integer":
			return integerGen(target.carrier)
		case "decimal":
			return decimalGen(target.typmod.precision, target.typmod.scale)
		case "double":
			return doubleGen
		case "boolean":
			return booleanGen
		case "date":
			return dateGen
	}
}

export const candidateGen: Gen<Candidate> = (source) => {
	const base = source.draw(candidatesOf(source.draw(targetGen(candidateMaxPrecision))))
	const corruption = source.draw(element([undefined, undefined, undefined, ...corruptions]))
	if (corruption === undefined || !base.member) {
		return base
	}
	const text = corruption === "" ? "" : `${base.text}${corruption}`
	return { ...base, text, member: false, value: undefined, shape: "corrupted" }
}

/** Two values of a target's host type are one value: a Decimal by equals, a double by Object.is but for one zero. */
export const sameValue = (a: unknown, b: unknown): boolean =>
	a instanceof Decimal && b instanceof Decimal
		? a.equals(b)
		: typeof a === "number" && typeof b === "number"
			? (Number.isNaN(a) && Number.isNaN(b)) || a === b
			: a === b
