/**
 * The proleptic Gregorian calendar by days since 1970-01-01, written from the calendar's definition apart from the
 * engine's day count (packages/engine/src/ir/date.ts dayNumber, which walks years and months): Howard Hinnant's
 * days_from_civil and civil_from_days, over eras of 400 years that start on March 1, so February's leap day ends each
 * era's year and every era has 146,097 days. The reference evaluator's epoch days (Time.epochDay, Time.dateOfEpochDay)
 * and the TZif reference's wall clocks (tzif.ts) count days by it.
 */

import { String as Str } from "effect"

/** A calendar date as YYYY-MM-DD, the reference's date value. */
export type ReferenceDate = `${string}-${string}-${string}`

/**
 * The days of an era of the calendar.
 *
 * @formatConstant the Gregorian calendar's cycle: 400 years of 146,097 days
 */
const eraDays = 146_097n

/**
 * The days from 0000-03-01 to 1970-01-01, the epoch's place in its era.
 *
 * @formatConstant 719,468 days, 0000-03-01 to 1970-01-01 in the proleptic Gregorian calendar
 */
const epochFromEra = 719_468n

/** The floor of a / b over bigints, b positive: BigInt division truncates toward zero. */
export const floorDiv = (a: bigint, b: bigint): bigint => {
	const q = a / b
	return a % b < 0n ? q - 1n : q
}

/** a mod b in [0, b), b positive. */
export const floorMod = (a: bigint, b: bigint): bigint => a - floorDiv(a, b) * b

/** The days after 1970-01-01 of year y, month m (1 to 12) and day d (days_from_civil). */
export const daysFromCivil = (year: bigint, month: bigint, day: bigint): bigint => {
	const y = month <= 2n ? year - 1n : year
	const era = floorDiv(y, 400n)
	const yearOfEra = y - era * 400n
	const dayOfYear = (153n * (month > 2n ? month - 3n : month + 9n) + 2n) / 5n + day - 1n
	const dayOfEra = yearOfEra * 365n + yearOfEra / 4n - yearOfEra / 100n + dayOfYear
	return era * eraDays + dayOfEra - epochFromEra
}

/** The year, month and day of the date `days` after 1970-01-01 (civil_from_days). */
export const civilFromDays = (
	days: bigint
): { readonly year: bigint; readonly month: bigint; readonly day: bigint } => {
	const z = days + epochFromEra
	const era = floorDiv(z, eraDays)
	const dayOfEra = z - era * eraDays
	const yearOfEra =
		(dayOfEra - dayOfEra / 1460n + dayOfEra / 36_524n - dayOfEra / (eraDays - 1n)) / 365n
	const dayOfYear = dayOfEra - (365n * yearOfEra + yearOfEra / 4n - yearOfEra / 100n)
	const mp = (5n * dayOfYear + 2n) / 153n
	const day = dayOfYear - (153n * mp + 2n) / 5n + 1n
	const month = mp < 10n ? mp + 3n : mp - 9n
	return { year: yearOfEra + era * 400n + (month <= 2n ? 1n : 0n), month, day }
}

/** A date's text, YYYY-MM-DD, its year of four digits (no date before year 1 or after 9999 is spelled here). */
export const dateText = (days: bigint): ReferenceDate => {
	const { year, month, day } = civilFromDays(days)
	const pad = (n: bigint, width: number): string => Str.padStart(width, "0")(n.toString())
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`
}

/** A date's days after 1970-01-01, read from its text YYYY-MM-DD. */
export const daysOfDate = (date: string): bigint => {
	const [year, month = "", day = ""] = Str.split(date, "-")
	return daysFromCivil(BigInt(year), BigInt(month), BigInt(day))
}
