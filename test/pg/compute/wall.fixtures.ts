/**
 * What test/pg/compute/wall.test.ts reads: the zones and instants its cases draw, the schema a case installs, and the
 * features a case reaches.
 */

import { array, element, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { clockReadingRange, millisPerDay, wallCycle } from "#compiler/core/clock.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Logic, Num, Time, Type } from "#compiler/public/compute.ts"
import { closedId, contract, date, generated, int4, int8 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { daysFromCivil, floorDiv } from "#test/support/oracle/reference/calendar.ts"
import { offsetAt, transitionsOf, type Zone } from "#test/support/oracle/reference/tzif.ts"
import { fullWorld } from "#test/support/worlds.ts"

/**
 * The zones a case's roster draws from, each an Area/Location name of PostgreSQL 19's tzdata, chosen for what a wall
 * clock branches on: metis's six (Chicago, New York, São Paulo, Los Angeles, Denver, Phoenix); offsets of half and
 * quarter hours (Kolkata, Kathmandu, Adelaide, Chatham, St. John's), a half-hour daylight shift (Lord Howe) and a
 * negative one (Dublin); the date line's edges (Kiritimati, Apia, Niue); the southern hemisphere's daylight time
 * (Sydney, Santiago); a local mean time of hours and seconds (Manila); zones whose rules tzdata changed after Node's ICU
 * (Vancouver, Edmonton, Winnipeg, Havana, Casablanca, Ojinaga); a daylight shift of two hours (Troll); and UT and fixed
 * offsets (Etc/UTC, Etc/GMT+12, Etc/GMT-14), London and Tokyo.
 */
export const zones = [
	"America/Chicago",
	"America/New_York",
	"America/Sao_Paulo",
	"America/Los_Angeles",
	"America/Denver",
	"America/Phoenix",
	"Asia/Kolkata",
	"Asia/Kathmandu",
	"Australia/Adelaide",
	"Pacific/Chatham",
	"America/St_Johns",
	"Australia/Lord_Howe",
	"Europe/Dublin",
	"Pacific/Kiritimati",
	"Pacific/Apia",
	"Pacific/Niue",
	"Australia/Sydney",
	"America/Santiago",
	"Asia/Manila",
	"America/Vancouver",
	"America/Edmonton",
	"America/Winnipeg",
	"America/Havana",
	"Africa/Casablanca",
	"America/Ojinaga",
	"Antarctica/Troll",
	"Etc/UTC",
	"Etc/GMT+12",
	"Etc/GMT-14",
	"Europe/London",
	"Asia/Tokyo"
] as const
export type ZoneName = (typeof zones)[number]

/**
 * metis's instants in milliseconds, each from PostgreSQL 19: Chicago's 2025, 2026 and 2027 gaps and overlaps, and New
 * York's, Denver's and Los Angeles' of 2026; São Paulo's gap at midnight of 2018-11-04, its repeated date of 2019-02-16
 * and its 2018 overlap, and two instants before 1970, across 1968-02-29; Phoenix's 1967 and Chicago's 1969 changes.
 */
const metisInstants = [
	1772956800000n,
	1793516400000n,
	1805011200000n,
	1825570800000n,
	1741507200000n,
	1762066800000n,
	1772953200000n,
	1793512800000n,
	1772960400000n,
	1793520000000n,
	1772964000000n,
	1793523600000n,
	1541300400000n,
	1550368800000n,
	1518919200000n,
	-121122000000n,
	-57967200000n,
	-84380400000n,
	-68659200000n,
	-21484800000n,
	-5763600000n
] as const

/**
 * The instants a probe is drawn near: the Unix epoch, leap days of 1968 and 2028, the ends of timestamptz's range, and
 * the bounds of its first and last Gregorian cycle, where Time.wall reads an offset one cycle in (core/clock.ts
 * wallCycle).
 */
const anchors = [
	0n,
	daysFromCivil(1968n, 2n, 29n) * millisPerDay,
	daysFromCivil(2028n, 2n, 29n) * millisPerDay,
	clockReadingRange.millis.low,
	clockReadingRange.millis.high,
	wallCycle.below,
	wallCycle.above
] as const

/** How far from a zone's transition a probe lies: a minute and an hour each way, past and short, and a millisecond. */
const deltas = [
	-3_660_000n,
	-3_540_000n,
	-60_000n,
	-1n,
	0n,
	1n,
	60_000n,
	3_540_000n,
	3_660_000n
] as const

/**
 * Where a probe's instant lies: around a transition of its zone's file, the `pick`th of them (wrapped), `delta` from it;
 * one of metis's instants; within three days of an anchor; or in a year of timestamptz's range, `into` milliseconds past
 * its first day.
 */
export type InstantSpec =
	| { readonly kind: "transition"; readonly pick: number; readonly delta: bigint }
	| { readonly kind: "metis"; readonly ms: bigint }
	| { readonly kind: "near"; readonly anchor: bigint; readonly by: number }
	| { readonly kind: "year"; readonly year: number; readonly into: number }

/** One probe: a zone of the case's roster and where its instant lies. */
export interface Probe {
	readonly zone: ZoneName
	readonly at: InstantSpec
}

/** A case: its roster's zones, each once, and its probes over them. */
export interface WallCase {
	readonly zones: Arr.NonEmptyReadonlyArray<ZoneName>
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/**
 * The milliseconds of three days, how far from an anchor a probe is drawn.
 *
 * @formatConstant three days of 86,400,000 milliseconds
 */
const nearMillis = 3 * 86_400_000

/**
 * The milliseconds of a common year, how far into a year a probe is drawn.
 *
 * @formatConstant 365 days of 86,400,000 milliseconds
 */
const yearMillis = 365 * 86_400_000

/** The years a year probe lies in: timestamptz's, 4714 BC (-4713) to 294276. */
const firstYear = -4713
const lastYear = 294_276

/** An instant's spec, drawn by kind, transitions weighted most. */
const instantGen: Gen<InstantSpec> = weighted<InstantSpec>([
	[2, (s) => ({ kind: "transition", pick: s.draw(int(0, 4096)), delta: s.draw(element(deltas)) })],
	[1, (s) => ({ kind: "metis", ms: s.draw(element(metisInstants)) })],
	[
		1,
		(s) => ({
			kind: "near",
			anchor: s.draw(element(anchors)),
			by: s.draw(int(-nearMillis, nearMillis))
		})
	],
	[
		1,
		(s) => ({
			kind: "year",
			year: s.draw(oneOf([int(1850, 2100), int(firstYear, lastYear)])),
			into: s.draw(int(0, yearMillis))
		})
	]
])

/** A case: one to four zones and twenty to sixty probes over them. */
export const caseGen: Gen<WallCase> = (s) => {
	const drawn = Arr.dedupe(s.draw(array(element(zones), { min: 1, max: 4 })))
	const roster = Arr.isReadonlyArrayNonEmpty(drawn) ? drawn : (["Etc/UTC"] as const)
	const probe: Gen<Probe> = (t) => ({ zone: t.draw(element(roster)), at: t.draw(instantGen) })
	const probes = s.draw(array(probe, { min: 20, max: 60 }))
	return {
		zones: roster,
		probes: Arr.isReadonlyArrayNonEmpty(probes)
			? probes
			: [{ zone: roster[0], at: { kind: "metis", ms: 0n } }]
	}
}

/** An instant clamped into timestamptz's range in milliseconds, every instant Time.wall is defined on. */
const clamped = (ms: bigint): bigint =>
	ms < clockReadingRange.millis.low
		? clockReadingRange.millis.low
		: ms > clockReadingRange.millis.high
			? clockReadingRange.millis.high
			: ms

/** A probe's instant, its zone read from its file: a transition by its pick, the epoch for a zone with none. */
export const instantOf = (spec: InstantSpec, zone: Zone): bigint => {
	switch (spec.kind) {
		case "transition": {
			const times = transitionsOf(zone)
			return clamped((times[spec.pick % Math.max(times.length, 1)] ?? 0n) + spec.delta)
		}
		case "metis":
			return spec.ms
		case "near":
			return clamped(spec.anchor + BigInt(spec.by))
		case "year":
			return clamped(daysFromCivil(BigInt(spec.year), 1n, 1n) * millisPerDay + BigInt(spec.into))
	}
}

/** What a case reached. */
export type WallFeature =
	| "an instant short of a transition into daylight time"
	| "an instant past a transition into daylight time"
	| "an instant short of a transition out of daylight time"
	| "an instant past a transition out of daylight time"
	| "an instant before 1970"
	| "an instant of the first Gregorian cycle of the range"
	| "an instant of the last Gregorian cycle of the range"
	| "a zone of an offset not of whole hours"
	| "one of metis's instants"
	| "a wall clock before the local epoch within a day of it"

/** The milliseconds in a second. */
const millisPerSecond = 1000n

/**
 * The features of a probe at instant `t` of zone `zone`, its wall clock `wall`: where a transition within an hour of it
 * raises or lowers the offset, which side of it the probe lies on; before 1970; in either outer Gregorian cycle; at an
 * offset of no whole hour; and a wall clock in the last day before the local epoch, which a truncating division puts in
 * the wrong day.
 */
export const featuresOf = (
	zone: Zone,
	t: bigint,
	wall: bigint,
	spec: InstantSpec
): ReadonlyArray<WallFeature> => {
	const features: Array<WallFeature> = []
	const found = Arr.findFirst(transitionsOf(zone), (at) => (at > t ? at - t : t - at) <= 3_660_000n)
	if (Option.isSome(found)) {
		const near = found.value
		const before = offsetAt(zone, floorDiv(near, millisPerSecond) - 1n)
		const after = offsetAt(zone, floorDiv(near, millisPerSecond))
		const side = t < near ? "short of" : "past"
		if (after > before) {
			features.push(`an instant ${side} a transition into daylight time`)
		} else if (after < before) {
			features.push(`an instant ${side} a transition out of daylight time`)
		}
	}
	if (t < 0n) {
		features.push("an instant before 1970")
	}
	if (t < wallCycle.below) {
		features.push("an instant of the first Gregorian cycle of the range")
	}
	if (t > wallCycle.above) {
		features.push("an instant of the last Gregorian cycle of the range")
	}
	if ((wall - t) % 3_600_000n !== 0n) {
		features.push("a zone of an offset not of whole hours")
	}
	if (spec.kind === "metis") {
		features.push("one of metis's instants")
	}
	if (wall < 0n && wall >= -millisPerDay) {
		features.push("a wall clock before the local epoch within a day of it")
	}
	return features
}

const millisKey = Symbol("Millis")
/**
 * A case's schema under its declared name: Zone, a zone roster of its zones; Millis, a bigint within timestamptz's
 * range in milliseconds, as a millis reading of the database's clock is; and Probe, an instant and a zone by id.
 */
const wallSchema = (name: string, roster: Arr.NonEmptyReadonlyArray<string>) => {
	const Zone = closed.zones("Zone", roster)
	const Millis = contract<typeof millisKey>()("Millis", int8, (x) =>
		Logic.and([
			Logic.ge(x, clockReadingRange.millis.low),
			Logic.le(x, clockReadingRange.millis.high)
		])
	)
	const Probe = relation("Probe", { id: int4, at: Millis, zone: closedId(Zone) }, ["id"])
	const s = schema(name, [Zone, Probe], [])
	return {
		s,
		programs: {
			probes: ChangeSet.empty(s).insert(Probe, []),
			walls: query(s).rule((r) => {
				const { id, at, zone } = v(Probe, "probe")
				return r.match(Probe, { id, at, zone }).find({ id, wall: Time.wall(at, zone) })
			})
		}
	}
}

/**
 * A case's world: its schema's full role, in its login, which serves the case's programs, so the installation installs
 * the library function `wall` their query calls.
 */
export const wallWorld = (name: string, roster: Arr.NonEmptyReadonlyArray<string>) => {
	const { s, programs } = wallSchema(name, roster)
	return { s, programs, world: fullWorld(s, programs, []) }
}

/**
 * A date of grizzle's, 0001-01-01 to 9999-12-31, as an epoch day: one of 1850 to 2100's, within a few years of the
 * epoch, or any, so days before 1970 and leap days come up.
 */
const epochDayGen: Gen<number> = oneOf([
	int(Number(daysFromCivil(1850n, 1n, 1n)), Number(daysFromCivil(2100n, 12n, 31n))),
	int(-1500, 1500),
	int(Number(daysFromCivil(1n, 1n, 1n)), Number(daysFromCivil(9999n, 12n, 31n))),
	(s) => {
		const year = 4 * s.draw(int(1, 2499))
		const leap = year % 100 === 0 && year % 400 !== 0 ? year - 4 : year
		return Number(daysFromCivil(BigInt(leap), 2n, 29n))
	}
])

/** An epoch day a date is made of, inside grizzle's dates or past them by up to a thousand days either way. */
const anyDayGen: Gen<number> = oneOf([
	epochDayGen,
	int(Number(daysFromCivil(1n, 1n, 1n)) - 1000, Number(daysFromCivil(1n, 1n, 1n)) - 1),
	int(Number(daysFromCivil(10000n, 1n, 1n)), Number(daysFromCivil(10000n, 1n, 1n)) + 1000)
])

/** A day probe: its date, as an epoch day, and an integer read as an epoch day. */
export interface DayProbe {
	readonly day: number
	readonly n: number
}

/** A batch of distinct dates, each with an integer epoch day beside it. */
export const dayCaseGen: Gen<Arr.NonEmptyReadonlyArray<DayProbe>> = (s) => {
	const first: DayProbe = { day: s.draw(epochDayGen), n: s.draw(anyDayGen) }
	const more = s.draw(
		array((t) => ({ day: t.draw(epochDayGen), n: t.draw(anyDayGen) }), { min: 4, max: 40 })
	)
	return [
		first,
		...Arr.filter(
			Arr.dedupeWith(more, (a, b) => a.day === b.day),
			(p) => p.day !== first.day
		)
	]
}

/** What a days case reached. */
export type DayFeature =
	| "a date before 1970"
	| "a date of 1970 or after"
	| "a leap day"
	| "an integer epoch day of no date grizzle holds"

/** The epoch days of the first and the last date grizzle holds. */
export const firstDay = daysFromCivil(1n, 1n, 1n)
export const lastDay = daysFromCivil(9999n, 12n, 31n)

/**
 * Days: a date and an integer, and three fields PostgreSQL generates of them: the date's epoch day, the date of that
 * epoch day, and the date of the integer where it is the epoch day of one of grizzle's dates, 1970-01-01 elsewhere.
 */
export const daysSchema = (name: string) => {
	const Days = relation.generated("Days", { day: date, n: int4 }, ["day"], (d) => ({
		epoch: generated(int4, Time.epochDay(d.day)),
		back: generated(date, Time.dateOfEpochDay(Time.epochDay(d.day))),
		ofN: generated(
			date,
			Logic.when(
				Num.within(d.n, Number(firstDay), Number(lastDay)),
				(n) => Time.dateOfEpochDay(n),
				Type.literal(date, "1970-01-01")
			)
		)
	}))
	const s = schema(name, [Days], [])
	return {
		s,
		Days,
		programs: {
			insertDays: ChangeSet.empty(s).insert(Days, []),
			days: query(s).rule((r) => {
				const { day, n, epoch, back, ofN } = v(Days, "d")
				return r.match(Days, { day, n, epoch, back, ofN }).find({ day, epoch, back, ofN })
			})
		},
		world: fullWorld(s, {}, [])
	}
}
