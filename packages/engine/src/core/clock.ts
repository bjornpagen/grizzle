/**
 * The units a reading of the database's clock counts since the Unix epoch, floored: `micros`, PostgreSQL's own
 * resolution, the exact reading; `millis`, the unit of JavaScript's Date and Effect's DateTime.
 */
export const clockUnits = ["micros", "millis"] as const
export type ClockUnit = (typeof clockUnits)[number]

/** Whether a value is the name of a clock unit (clockUnits). */
export const isClockUnit = (value: unknown): value is ClockUnit =>
	value === "micros" || value === "millis"

/**
 * The first instant PostgreSQL's timestamptz holds, MIN_TIMESTAMP, 4714-11-24 BC, in microseconds since 2000-01-01, its
 * own epoch: the earliest the database's clock can read.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit microseconds since 2000-01-01 00:00:00 UTC
 * @scope a reading of the database's clock
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/datatype/timestamp.h#L256
 * @quote #define MIN_TIMESTAMP	INT64CONST(-211813488000000000)
 * @verified 2026-11-20
 */
const minTimestamp = -211_813_488_000_000_000n

/**
 * The instant past the last PostgreSQL's timestamptz holds, END_TIMESTAMP, 294277-01-01, in microseconds since
 * 2000-01-01: every reading of the database's clock is before it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit microseconds since 2000-01-01 00:00:00 UTC
 * @scope a reading of the database's clock
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/datatype/timestamp.h#L258
 * @quote #define END_TIMESTAMP	INT64CONST(9223371331200000000)
 * @verified 2026-11-20
 */
const endTimestamp = 9_223_371_331_200_000_000n

/**
 * PostgreSQL's epoch, 2000-01-01, in microseconds since the Unix epoch: (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) days
 * of 86400 seconds.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0
 * @unit microseconds
 * @scope a reading of the database's clock
 * @derivation (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * SECS_PER_DAY * USECS_PER_SEC = (2451545 - 2440588) * 86400 *
 *   10^6 (https://github.com/postgres/postgres/blob/REL_19_0/src/include/datatype/timestamp.h#L234-L235)
 */
const postgresEpochMicros = 946_684_800_000_000n

/**
 * Every value a reading of the database's clock in `unit` can be, counted since the Unix epoch and floored (sql/print.ts
 * clockReading): the instants timestamptz holds, from MIN_TIMESTAMP to the one before END_TIMESTAMP, so a reading
 * binds a parameter with these bounds beside its type's (scalar/compute/typing.ts param), and a sum of it and a
 * bounded value fits where its bounds prove it.
 */
export const clockReadingRange: {
	readonly [U in ClockUnit]: { readonly low: bigint; readonly high: bigint }
} = Object.freeze({
	micros: Object.freeze({
		low: minTimestamp + postgresEpochMicros,
		high: endTimestamp + postgresEpochMicros - 1n
	}),
	millis: Object.freeze({
		low: (minTimestamp + postgresEpochMicros) / 1000n,
		high: (endTimestamp + postgresEpochMicros - 1n) / 1000n
	})
})

/**
 * The milliseconds in a day: 86,400 seconds of 1,000 milliseconds, as PostgreSQL's timestamps count a day, which keep no
 * leap second.
 */
export const millisPerDay = 86_400_000n

/**
 * The days of the Gregorian calendar's cycle, after which its dates fall on the same weekdays again.
 *
 * @formatConstant the Gregorian calendar's cycle: 400 years of 146,097 days
 */
const gregorianCycleDays = 146_097n

/**
 * Where Time.wall reads a zone's wall clock one Gregorian cycle in (physical/ddl/library.ts wallDefinition): an instant
 * below `below`, in the first cycle of timestamptz's range, is read one cycle later, and one above `above`, in the last,
 * one cycle earlier, the wall clock moved back by the cycle, so no wall clock past either end of the range is ever
 * built, whatever the zone's offset. Each is where every zone's rule repeats each cycle: before the zone's first
 * transition its first time type, and after its last the POSIX rule of its TZif footer, whose rules name months,
 * weekdays and days of the year, which a cycle keeps.
 */
export const wallCycle: {
	readonly millis: bigint
	readonly below: bigint
	readonly above: bigint
} = Object.freeze({
	millis: gregorianCycleDays * millisPerDay,
	below: clockReadingRange.millis.low + gregorianCycleDays * millisPerDay,
	above: clockReadingRange.millis.high - gregorianCycleDays * millisPerDay
})

/**
 * The most seconds a TZif file's local time type is offset from UT either way: utoff is a signed 32-bit count of seconds
 * that is never -2**31, so a zone's wall clock lies within this many seconds of its instant, as PostgreSQL's tzdata
 * compiles each zone into one, which bounds Time.wall's value (scalar/compute/typing.ts wall).
 *
 * @limitKind published
 * @owner RFC 8536, the Time Zone Information Format
 * @unit seconds
 * @scope the offset from UT of one local time type of one zone's TZif file
 * @constraint protocol constant
 * @source https://www.rfc-editor.org/rfc/rfc8536#section-3.2
 * @quote The value MUST NOT be -2**31 and SHOULD be in the range [-89999, 93599]
 * @verified 2026-11-21
 */
const tzifOffsetMaxSeconds = 2n ** 31n - 1n

/**
 * Every value Time.wall can be, in milliseconds since the local epoch: an instant of a millis reading's range moved by
 * at most a TZif offset either way.
 *
 * @limitKind derived
 * @owner PostgreSQL 19.0's timestamptz and RFC 8536's TZif
 * @unit milliseconds since the local epoch
 * @scope one value of Time.wall
 * @derivation an instant lies in clockReadingRange.millis and its zone's offset within tzifOffsetMaxSeconds of zero,
 *   so its wall clock lies within that many seconds, times 1,000, of the range's ends
 * @from {@link clockReadingRange}, {@link tzifOffsetMaxSeconds}
 */
export const wallRange: { readonly low: bigint; readonly high: bigint } = Object.freeze({
	low: clockReadingRange.millis.low - tzifOffsetMaxSeconds * 1000n,
	high: clockReadingRange.millis.high + tzifOffsetMaxSeconds * 1000n
})
