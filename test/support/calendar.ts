/**
 * The Gregorian calendar by day arithmetic, the oracle the tests of a migration folder's timestamp read it by, written
 * apart from the engine's (deploy/render/folder.ts timestampParts, ir/date.ts): a UTC second by its fields, drawn with
 * its calendar's edges often, its epoch milliseconds and back over the 400-year eras, its fourteen digits YYYYMMDDHHMMSS,
 * and the second fourteen digits name, or none.
 */

import { defined } from "@bjornpagen/testing/assert"
import { element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"

/** A UTC second by its fields, as the calendar writes it. */
export interface Second {
	readonly year: number
	readonly month: number
	readonly day: number
	readonly hour: number
	readonly minute: number
	readonly second: number
}

/** Whether `year` is a leap year of the Gregorian calendar. */
const leap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

/** The days of each month of a common year. */
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** The days of `month` in `year`. */
export const daysIn = (year: number, month: number): number =>
	month === 2 && leap(year) ? 29 : defined(monthDays[month - 1], "a month of the year")

const secondsPerDay = 86_400

/** The days from 1970-01-01 to a date, by day arithmetic over the Gregorian calendar's 400-year eras. */
const daysOf = (year: number, month: number, day: number): number => {
	const y = month <= 2 ? year - 1 : year
	const era = Math.floor(y / 400)
	const yearOfEra = y - era * 400
	const dayOfYear = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1
	const dayOfEra =
		yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
	return era * 146_097 + dayOfEra - 719_468
}

/** A field drawn among its edges more often than its middle. */
export const edged = (
	lo: number,
	hi: number,
	edges: Arr.NonEmptyReadonlyArray<number>
): Gen<number> =>
	weighted([
		[1, element(edges)],
		[2, int(lo, hi)]
	])

/** A UTC second, its calendar's edges drawn often: year ends, month ends, leap days, centuries, 1970 and 9999. */
export const secondGen: Gen<Second> = (source) => {
	const year = source.draw(edged(1970, 9999, [1970, 2000, 2024, 2026, 2100, 9999]))
	const month = source.draw(edged(1, 12, [1, 2, 12]))
	const last = daysIn(year, month)
	return {
		year,
		month,
		day: source.draw(edged(1, last, [1, last])),
		hour: source.draw(edged(0, 23, [0, 23])),
		minute: source.draw(edged(0, 59, [0, 59])),
		second: source.draw(edged(0, 59, [0, 59]))
	}
}

/** The epoch milliseconds of a second. */
export const millisOf = (s: Second): number =>
	(daysOf(s.year, s.month, s.day) * secondsPerDay + s.hour * 3600 + s.minute * 60 + s.second) * 1000

/** The fields of the second at `millis`, by day arithmetic over the Gregorian calendar's 400-year eras. */
export const secondAt = (millis: number): Second => {
	const seconds = Math.floor(millis / 1000)
	const days = Math.floor(seconds / secondsPerDay)
	const time = seconds - days * secondsPerDay
	const shifted = days + 719_468
	const era = Math.floor(shifted / 146_097)
	const dayOfEra = shifted - era * 146_097
	const yearOfEra = Math.floor(
		(dayOfEra -
			Math.floor(dayOfEra / 1460) +
			Math.floor(dayOfEra / 36_524) -
			Math.floor(dayOfEra / 146_096)) /
			365
	)
	const dayOfYear =
		dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
	const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153)
	const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9
	return {
		year: yearOfEra + era * 400 + (month <= 2 ? 1 : 0),
		month,
		day: dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1,
		hour: Math.floor(time / 3600),
		minute: Math.floor((time % 3600) / 60),
		second: time % 60
	}
}

const padded = (n: number, width: number): string => Str.padStart(width, "0")(String(n))

/** The oracle's timestamp of a second: its fields' digits, the year in four or more. */
export const digitsOf = (s: Second): string =>
	`${padded(s.year, 4)}${padded(s.month, 2)}${padded(s.day, 2)}${padded(s.hour, 2)}${padded(s.minute, 2)}${padded(s.second, 2)}`

/** The oracle's reading of fourteen digits: the second they name, with a year of four digits, or none. */
export const secondOfDigits = (text: string): Option.Option<number> => {
	const digits = Arr.every(Str.split(text, ""), (c) => c >= "0" && c <= "9")
	if (text.length !== 14 || !digits || Str.startsWith("0")(text)) {
		return Option.none()
	}
	const field = (from: number, width: number) => Number(Str.slice(from, from + width)(text))
	const s: Second = {
		year: field(0, 4),
		month: field(4, 2),
		day: field(6, 2),
		hour: field(8, 2),
		minute: field(10, 2),
		second: field(12, 2)
	}
	const millis = millisOf(s)
	return digitsOf(secondAt(millis)) === text ? Option.some(millis) : Option.none()
}
