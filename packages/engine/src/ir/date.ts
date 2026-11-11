import type { ValueFault } from "#compiler/core/errors.ts"
import { defined } from "#compiler/core/invariant.ts"
import * as Result from "#compiler/core/result.ts"

/**
 * A calendar date host value: ISO 8601's extended calendar form `YYYY-MM-DD`, a day of the proleptic Gregorian
 * calendar from 0001-01-01 to 9999-12-31, which is the date descriptor's host type, domain and language. The text is
 * the value's one form: two dates are equal exactly when their texts are, their order is code unit order, and the text
 * is PostgreSQL's date_out under DateStyle ISO, which every login pins. The language is wider than the dates, as Uuid's
 * is: TypeScript writes each part as `${string}`, so any text with two hyphens is in it, and it is refused at the
 * boundary instead (toCalendarDate).
 */
export type CalendarDate = `${string}-${string}-${string}`

/** The first and the last calendar date, which bound the date descriptor's domain. */
export const firstCalendarDate: CalendarDate = "0001-01-01"
export const lastCalendarDate: CalendarDate = "9999-12-31"

/**
 * The code units of a calendar date's text: four year digits, a hyphen, two month digits, a hyphen, two day digits.
 *
 * @formatConstant ISO 8601's extended calendar date YYYY-MM-DD
 */
const dateTextLength = 10

/**
 * The offsets of the two hyphens in a calendar date's text, and of its month and its day.
 *
 * @formatConstant ISO 8601's extended calendar date YYYY-MM-DD
 */
const dateLayout = { monthHyphen: 4, dayHyphen: 7 } as const

/**
 * The days of each month of a common year, January first, and of February in a leap year.
 *
 * @formatConstant the Gregorian calendar's month lengths
 */
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/**
 * February, the month a leap year lengthens, and its length then.
 *
 * @formatConstant the Gregorian calendar's leap day
 */
const leapDay = { month: 2, days: 29 } as const

/**
 * The Gregorian leap year rule: every fourth year, but not a century unless it is a fourth century.
 *
 * @formatConstant the Gregorian calendar's leap year cycle
 */
const leapCycle = { year: 4, century: 100, era: 400 } as const

/** Whether a year of the proleptic Gregorian calendar is a leap year. */
const isLeapYear = (year: number): boolean =>
	year % leapCycle.year === 0 && (year % leapCycle.century !== 0 || year % leapCycle.era === 0)

/** The days of a month of a year, January as 1; undefined for a number that is no month. */
const daysInMonth = (year: number, month: number): number | undefined => {
	const common: number | undefined = monthDays[month - 1]
	return common === undefined
		? undefined
		: month === leapDay.month && isLeapYear(year)
			? leapDay.days
			: common
}

/** The value of the decimal digits of `text` from `start` to `end`, or undefined where one is no ASCII digit. */
const digitsValue = (text: string, start: number, end: number): number | undefined => {
	let value = 0
	for (let i = start; i < end; i++) {
		const code = text.charCodeAt(i)
		if (code < 0x30 || code > 0x39) {
			return undefined
		}
		value = value * 10 + (code - 0x30)
	}
	return value
}

/**
 * The calendar date admission core: a string of the extended form `YYYY-MM-DD` that names a day from 0001-01-01 to
 * 9999-12-31, every other value `dateSyntax`. The canonical value is the text itself, since the form has one spelling
 * per day.
 */
export const toCalendarDate = (value: unknown): Result.Result<CalendarDate, ValueFault> => {
	if (
		typeof value !== "string" ||
		value.length !== dateTextLength ||
		value.charCodeAt(dateLayout.monthHyphen) !== 0x2d ||
		value.charCodeAt(dateLayout.dayHyphen) !== 0x2d
	) {
		return Result.err("dateSyntax")
	}
	const year = digitsValue(value, 0, dateLayout.monthHyphen)
	const month = digitsValue(value, dateLayout.monthHyphen + 1, dateLayout.dayHyphen)
	const day = digitsValue(value, dateLayout.dayHyphen + 1, dateTextLength)
	if (year === undefined || month === undefined || day === undefined || year === 0) {
		return Result.err("dateSyntax")
	}
	const days = daysInMonth(year, month)
	if (days === undefined || day < 1 || day > days) {
		return Result.err("dateSyntax")
	}
	return Result.ok(convertDate(value))
}

/**
 * date_out's text under DateStyle ISO, which every login pins, as its host value: a date of the descriptor's range is
 * already its one form, so the conversion only reads it as one, trusting it as every conversion of PostgreSQL's own
 * output does (values/convert.ts).
 */
export const convertDate = (text: string): CalendarDate =>
	`${text.slice(0, dateLayout.monthHyphen)}-${text.slice(dateLayout.monthHyphen + 1, dateLayout.dayHyphen)}-${text.slice(dateLayout.dayHyphen + 1)}`

/** The year, month and day a calendar date names. */
const dateParts = (
	date: CalendarDate
): { readonly year: number; readonly month: number; readonly day: number } => ({
	year: Number(date.slice(0, dateLayout.monthHyphen)),
	month: Number(date.slice(dateLayout.monthHyphen + 1, dateLayout.dayHyphen)),
	day: Number(date.slice(dateLayout.dayHyphen + 1))
})

/**
 * The calendar date's text positions PostgreSQL's substr reads a part from, 1-based as substr counts: the year's four
 * digits from 1, the month's two from 6, the day's two from 9.
 */
export const datePartSlices = {
	year: { start: 1, length: dateLayout.monthHyphen },
	month: {
		start: dateLayout.monthHyphen + 2,
		length: dateLayout.dayHyphen - dateLayout.monthHyphen - 1
	},
	day: { start: dateLayout.dayHyphen + 2, length: dateTextLength - dateLayout.dayHyphen - 1 }
} as const

/**
 * The days of a common year.
 *
 * @formatConstant the Gregorian calendar's common year
 */
const commonYearDays = 365

/** The days of the proleptic Gregorian calendar before January 1 of `year`, counted from 0001-01-01. */
const daysBeforeYear = (year: number): number => {
	const y = year - 1
	return (
		commonYearDays * y +
		Math.floor(y / leapCycle.year) -
		Math.floor(y / leapCycle.century) +
		Math.floor(y / leapCycle.era)
	)
}

/**
 * A calendar date's day number, its days after 0001-01-01: the order of dates is the order of their day numbers, so
 * an interval of dates is an interval of day numbers, the bound domain a date's comparisons are judged in.
 */
export const dayNumber = (date: CalendarDate): number => {
	const { year, month, day } = dateParts(date)
	let days = daysBeforeYear(year)
	for (let m = 1; m < month; m++) {
		days += defined(daysInMonth(year, m), "a month before a calendar date's own")
	}
	return days + day - 1
}

/** The year's digits, and the month's and the day's, of a calendar date's text. */
const partWidths = {
	year: dateLayout.monthHyphen,
	monthOrDay: dateLayout.dayHyphen - dateLayout.monthHyphen - 1
} as const

/**
 * The calendar date of a day number, its days after 0001-01-01: dayNumber's inverse, a date span's endpoint as the
 * evaluator holds it read back as the host's.
 */
export const dateOfDayNumber = (days: bigint): CalendarDate => {
	const n = Number(days)
	let year = Math.floor(n / (commonYearDays + 1)) + 1
	while (daysBeforeYear(year + 1) <= n) {
		year++
	}
	let rest = n - daysBeforeYear(year)
	let month = 1
	for (let length = daysInMonth(year, month); length !== undefined && rest >= length;) {
		rest -= length
		month++
		length = daysInMonth(year, month)
	}
	const pad = (value: number, width: number): string => String(value).padStart(width, "0")
	return `${pad(year, partWidths.year)}-${pad(month, partWidths.monthOrDay)}-${pad(rest + 1, partWidths.monthOrDay)}`
}
