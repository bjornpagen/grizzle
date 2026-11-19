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
 * @owner PostgreSQL 19rc2
 * @unit microseconds since 2000-01-01 00:00:00 UTC
 * @scope a reading of the database's clock
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/datatype/timestamp.h#L256
 * @quote #define MIN_TIMESTAMP	INT64CONST(-211813488000000000)
 * @verified 2026-11-19
 */
const minTimestamp = -211_813_488_000_000_000n

/**
 * The instant past the last PostgreSQL's timestamptz holds, END_TIMESTAMP, 294277-01-01, in microseconds since
 * 2000-01-01: every reading of the database's clock is before it.
 *
 * @limitKind published
 * @owner PostgreSQL 19rc2
 * @unit microseconds since 2000-01-01 00:00:00 UTC
 * @scope a reading of the database's clock
 * @constraint compile-time constant
 * @source https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/datatype/timestamp.h#L258
 * @quote #define END_TIMESTAMP	INT64CONST(9223371331200000000)
 * @verified 2026-11-19
 */
const endTimestamp = 9_223_371_331_200_000_000n

/**
 * PostgreSQL's epoch, 2000-01-01, in microseconds since the Unix epoch: (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) days
 * of 86400 seconds.
 *
 * @limitKind derived
 * @owner PostgreSQL 19rc2
 * @unit microseconds
 * @scope a reading of the database's clock
 * @derivation (POSTGRES_EPOCH_JDATE - UNIX_EPOCH_JDATE) * SECS_PER_DAY * USECS_PER_SEC = (2451545 - 2440588) * 86400 *
 *   10^6 (https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/datatype/timestamp.h#L234-L235)
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
