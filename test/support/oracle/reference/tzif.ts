/**
 * The TZif reference: a zone's offset from UT at an instant read from its compiled zone file, the Time Zone Information
 * Format of RFC 8536, apart from PostgreSQL's localtime.c and grizzle's SQL, which a test holds Time.wall to
 * (test/pg/compute/wall.test.ts). The file is the server's own, read from the timezone directory of the share directory
 * its pg_config reports, which a build with its bundled tzdata installs its zones into, so the reference and the server
 * read one tzdata by construction and no version is compared.
 *
 * A zone (Zone) is its version 2+ data block, read as 64-bit times (RFC 8536 §3.2): its transition times, each
 * transition's local time type, and each type's offset from UT; and its footer's TZ string (§3.3), the POSIX rule the
 * zone follows after its last transition (RuleOf). An instant before the first transition is the first type's (type 0);
 * one on or after a transition is that transition's type until the next; one on or after the last is that last type's
 * until the first of the footer rule's transitions after it, and the rule's from then on, as tzcode's localtime.c
 * appends the rule's transitions after the file's last, which PostgreSQL's copy of it does, so a footer whose rule
 * would state another type at the last transition (America/Ojinaga's, after its 2022-10-30 change) moves no instant
 * before its own next transition.
 */

import { utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Option, String as Str } from "effect"
import {
	civilFromDays,
	daysFromCivil,
	floorDiv,
	floorMod
} from "#test/support/oracle/reference/calendar.ts"

/** A local time type: its offset from UT in seconds. */
interface TimeType {
	readonly utoff: bigint
}

/** A rule's transition date (RFC 8536 §3.3, POSIX TZ): Jn, a day of a year of no Feb 29; n, a day counting Feb 29; or Mm.w.d. */
type RuleDate =
	| { readonly kind: "julian"; readonly day: bigint }
	| { readonly kind: "zeroBased"; readonly day: bigint }
	| {
			readonly kind: "month"
			readonly month: bigint
			readonly week: bigint
			readonly weekday: bigint
	  }

/** A footer rule: its standard offset, and where it has one, its daylight offset and the two transitions a year. */
type Rule =
	| { readonly kind: "fixed"; readonly utoff: bigint }
	| {
			readonly kind: "daylight"
			readonly std: bigint
			readonly dst: bigint
			readonly start: { readonly date: RuleDate; readonly time: bigint }
			readonly end: { readonly date: RuleDate; readonly time: bigint }
	  }

/** A zone read from its TZif file. */
export interface Zone {
	readonly times: ReadonlyArray<bigint>
	readonly types: ReadonlyArray<TimeType>
	/** Each transition's type, by its index in `types`. */
	readonly indices: ReadonlyArray<number>
	readonly rule: Rule | undefined
}

/** A refusal of a file the reference cannot read as a TZif file of version 2 or later. */
const unreadable = (why: string): never => {
	throw new Error(`a TZif file the reference reads: ${why}`)
}

/**
 * The bytes of a TZif header's magic, "TZif".
 *
 * @formatConstant RFC 8536 §3.1: the four-octet magic "TZif"
 */
const magic = [0x54, 0x5a, 0x69, 0x66] as const

/**
 * The octets of a TZif header: magic, version, 15 unused octets and six four-octet counts.
 *
 * @formatConstant RFC 8536 §3.1: a 44-octet header
 */
const headerOctets = 44

/** A reader of a file's octets, big-endian as TZif writes them. */
class Octets {
	at = 0
	readonly bytes: Uint8Array
	constructor(bytes: Uint8Array) {
		this.bytes = bytes
	}
	byte(): number {
		const b = this.bytes[this.at]
		if (b === undefined) {
			return unreadable("its data past its end")
		}
		this.at += 1
		return b
	}
	signed(octets: 4 | 8): bigint {
		let value = 0n
		for (let i = 0; i < octets; i++) {
			value = (value << 8n) | BigInt(this.byte())
		}
		return BigInt.asIntN(octets * 8, value)
	}
	skip(octets: number): void {
		this.at += octets
	}
}

/** A header's six counts (RFC 8536 §3.1), each a four-octet unsigned integer. */
const counts = (o: Octets) => {
	for (const m of magic) {
		if (o.byte() !== m) {
			unreadable("its magic")
		}
	}
	const version = o.byte()
	if (version < 0x32) {
		unreadable("version 2 or later")
	}
	o.skip(headerOctets - 5 - 24)
	const count = (): number => Number(o.signed(4))
	return {
		isutcnt: count(),
		isstdcnt: count(),
		leapcnt: count(),
		timecnt: count(),
		typecnt: count(),
		charcnt: count()
	}
}

/** A zone read from the bytes of its TZif file: its version 2+ block and its footer (see the module's header). */
export const zoneOf = (bytes: Uint8Array): Zone => {
	const o = new Octets(bytes)
	const v1 = counts(o)
	o.skip(v1.timecnt * 5 + v1.typecnt * 6 + v1.charcnt + v1.leapcnt * 8 + v1.isstdcnt + v1.isutcnt)
	const v2 = counts(o)
	const times = Array.from({ length: v2.timecnt }, () => o.signed(8))
	const indices = Array.from({ length: v2.timecnt }, () => o.byte())
	const types = Array.from({ length: v2.typecnt }, (): TimeType => {
		const utoff = o.signed(4)
		o.skip(2)
		return { utoff }
	})
	o.skip(v2.charcnt + v2.leapcnt * 12 + v2.isstdcnt + v2.isutcnt)
	const footer =
		Str.split(utf8Text(bytes.subarray(o.at)) ?? unreadable("a footer of UTF-8"), "\n")[1] ?? ""
	return { times, types, indices, rule: footer === "" ? undefined : ruleOf(footer) }
}

/** Whether a character is an ASCII letter. */
const isLetter = (c: string): boolean => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z")

/** Whether a character is an ASCII digit. */
const isDigit = (c: string): boolean => c.length === 1 && c >= "0" && c <= "9"

/** A POSIX TZ string's reader (RFC 8536 §3.3): names, offsets and rules, left to right. */
class TzText {
	at = 0
	readonly text: string
	constructor(text: string) {
		this.text = text
	}
	peek(): string {
		return this.text[this.at] ?? ""
	}
	done(): boolean {
		return this.at >= this.text.length
	}
	take(): string {
		const c = this.peek()
		this.at += 1
		return c
	}
	/** A zone abbreviation: letters, or any characters between < and >. */
	name(): void {
		if (this.peek() === "<") {
			const close = Str.indexOf(">")(Str.slice(this.at)(this.text))
			this.at = Option.isSome(close) ? this.at + close.value + 1 : this.text.length
			return
		}
		while (isLetter(this.peek())) {
			this.at += 1
		}
	}
	number(): bigint {
		let digits = ""
		while (isDigit(this.peek())) {
			digits += this.take()
		}
		return digits === "" ? unreadable(`a number in ${this.text}`) : BigInt(digits)
	}
	/** [+|-]hh[:mm[:ss]] in seconds, its sign kept. */
	time(): bigint {
		const sign = this.peek() === "-" ? -1n : 1n
		if (this.peek() === "-" || this.peek() === "+") {
			this.at += 1
		}
		let seconds = this.number() * 3600n
		if (this.peek() === ":") {
			this.at += 1
			seconds += this.number() * 60n
			if (this.peek() === ":") {
				this.at += 1
				seconds += this.number()
			}
		}
		return sign * seconds
	}
	/** A rule's date and its time, 02:00:00 where it states none. */
	transition(): { readonly date: RuleDate; readonly time: bigint } {
		let date: RuleDate
		if (this.peek() === "J") {
			this.at += 1
			date = { kind: "julian", day: this.number() }
		} else if (this.peek() === "M") {
			this.at += 1
			const month = this.number()
			this.take()
			const week = this.number()
			this.take()
			date = { kind: "month", month, week, weekday: this.number() }
		} else {
			date = { kind: "zeroBased", day: this.number() }
		}
		if (this.peek() === "/") {
			this.at += 1
			return { date, time: this.time() }
		}
		return { date, time: 7200n }
	}
}

/**
 * A footer's rule: its standard name and offset, a POSIX offset being west of Greenwich, so the type's utoff is its
 * negation; then, where it names daylight time, its offset, an hour ahead of standard where it states none, and its two
 * transitions.
 */
const ruleOf = (text: string): Rule => {
	const t = new TzText(text)
	t.name()
	const std = -t.time()
	if (t.done()) {
		return { kind: "fixed", utoff: std }
	}
	t.name()
	const dst = t.peek() === "," || t.done() ? std + 3600n : -t.time()
	if (t.take() !== ",") {
		return unreadable(`a rule of two transitions in ${text}`)
	}
	const start = t.transition()
	if (t.take() !== ",") {
		return unreadable(`a rule of two transitions in ${text}`)
	}
	return { kind: "daylight", std, dst, start, end: t.transition() }
}

/** Whether a year of the proleptic Gregorian calendar is a leap year. */
const leap = (year: bigint): boolean =>
	year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n)

/** The days after 1970-01-01 of a rule's date in `year`. */
const dayOfRule = (date: RuleDate, year: bigint): bigint => {
	const jan1 = daysFromCivil(year, 1n, 1n)
	switch (date.kind) {
		case "julian":
			return jan1 + date.day - 1n + (leap(year) && date.day >= 60n ? 1n : 0n)
		case "zeroBased":
			return jan1 + date.day
		case "month": {
			const first = daysFromCivil(year, date.month, 1n)
			const weekdayOfFirst = floorMod(first + 4n, 7n)
			const firstMatch = first + floorMod(date.weekday - weekdayOfFirst, 7n)
			const next =
				date.month === 12n
					? daysFromCivil(year + 1n, 1n, 1n)
					: daysFromCivil(year, date.month + 1n, 1n)
			let day = firstMatch + (date.week - 1n) * 7n
			while (day >= next) {
				day -= 7n
			}
			return day
		}
	}
}

/** The seconds in a day. */
const secondsPerDay = 86_400n

/**
 * A daylight rule's offset at the instant `t`, in seconds since the Unix epoch, after the file's last transition at
 * `after` of offset `held`, or with none: the type of the latest of the rule's transitions at or before t and after
 * `after`, over the years around t's, each year's start (read in standard time) and end (read in daylight time) in
 * turn, so a year whose daylight time runs to the next one's start keeps it; `held` where none is.
 */
const ruleOffset = (
	rule: Extract<Rule, { readonly kind: "daylight" }>,
	t: bigint,
	last: { readonly after: bigint; readonly held: bigint } | undefined
): bigint => {
	const year = civilFromDays(floorDiv(t, secondsPerDay)).year
	let offset = last === undefined ? rule.std : last.held
	let latest: bigint | undefined
	for (const y of [year - 1n, year, year + 1n]) {
		const start = dayOfRule(rule.start.date, y) * secondsPerDay + rule.start.time - rule.std
		const end = dayOfRule(rule.end.date, y) * secondsPerDay + rule.end.time - rule.dst
		for (const [at, utoff] of [
			[start, rule.dst],
			[end, rule.std]
		] as const) {
			if (
				at <= t &&
				(last === undefined || at > last.after) &&
				(latest === undefined || at >= latest)
			) {
				latest = at
				offset = utoff
			}
		}
	}
	return offset
}

/** The zone's offset from UT at the instant `t`, in seconds since the Unix epoch (see the module's header). */
export const offsetAt = (zone: Zone, t: bigint): bigint => {
	const typeAt = (index: number): bigint => {
		const type = zone.types[index]
		return type === undefined ? unreadable(`a type of index ${index}`) : type.utoff
	}
	const last = zone.times.length - 1
	const lastTime = zone.times[last]
	if (lastTime === undefined || (zone.times[0] ?? lastTime) > t) {
		return lastTime === undefined && zone.rule !== undefined
			? ruleAt(zone.rule, t, undefined)
			: typeAt(0)
	}
	if (t >= lastTime) {
		const held = typeAt(zone.indices[last] ?? 0)
		return zone.rule === undefined ? held : ruleAt(zone.rule, t, { after: lastTime, held })
	}
	let lo = 0
	let hi = last
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1
		if ((zone.times[mid] ?? t) <= t) {
			lo = mid
		} else {
			hi = mid
		}
	}
	return typeAt(zone.indices[lo] ?? 0)
}

/**
 * A footer rule's offset at t, after the file's last transition where it has one: a daylight rule's by its transitions
 * after it (ruleOffset); a fixed rule, which states no transition, keeps the last transition's type, as tzcode appends
 * none of it, and states its own offset only where the file has no transition.
 */
const ruleAt = (
	rule: Rule,
	t: bigint,
	last: { readonly after: bigint; readonly held: bigint } | undefined
): bigint =>
	rule.kind === "daylight" ? ruleOffset(rule, t, last) : last === undefined ? rule.utoff : last.held

/** The milliseconds in a second. */
const millisPerSecond = 1000n

/**
 * The zone's wall clock at the instant `ms`, both in milliseconds, the instant's since the Unix epoch and the wall
 * clock's since the local epoch: the instant plus the offset at its second, the floor of its milliseconds, since a
 * transition falls on a whole second.
 */
export const wallMillis = (zone: Zone, ms: bigint): bigint =>
	ms + offsetAt(zone, floorDiv(ms, millisPerSecond)) * millisPerSecond

/** The zone's transition instants in milliseconds, which a test probes around. */
export const transitionsOf = (zone: Zone): ReadonlyArray<bigint> =>
	Arr.map(zone.times, (t) => t * millisPerSecond)
