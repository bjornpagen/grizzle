import { ok } from "#test/support/schedules/match.ts"
import type { Expectation, Schedule, ScheduleOutcome, Step } from "#test/support/schedules/types.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"

/**
 * Constructors for schedules and steps. Every argument is required: what a step expects is stated at each step, and
 * every session step must complete without waiting on a lock another session of the schedule holds.
 *
 *   schedule("a planted writer below SERIALIZABLE is refused", [
 *   	beginBelow("w", "read committed"),
 *   	sql("w", insert, refused),
 *   	rollback("w"),
 *   	check(`SELECT count(*)::text FROM t`, rowSet([["0"]]))
 *   ])
 */
export const schedule = <D extends string>(
	name: string,
	steps: ReadonlyArray<Step<D>>
): Schedule<D> => ({ name, steps })

export const sql = <D extends string>(
	session: D,
	text: string,
	expect: Expectation<ScheduleOutcome>
): Step<D> => ({ _tag: "Perform", session, action: { _tag: "Sql", sql: text }, expect })

/** BEGIN ISOLATION LEVEL SERIALIZABLE, as every transaction. */
export const begin = <D extends string>(session: D): Step<D> => ({
	_tag: "Perform",
	session,
	action: { _tag: "Begin" },
	expect: ok()
})

/** A planted writer's BEGIN below SERIALIZABLE: its writes are to be refused. */
export const beginBelow = <D extends string>(session: D, level: BelowSerializable): Step<D> => ({
	_tag: "Perform",
	session,
	action: { _tag: "BeginBelow", level },
	expect: ok()
})

export const commit = <D extends string>(
	session: D,
	expect: Expectation<ScheduleOutcome>
): Step<D> => ({ _tag: "Perform", session, action: { _tag: "Commit" }, expect })

export const rollback = <D extends string>(session: D): Step<D> => ({
	_tag: "Perform",
	session,
	action: { _tag: "Rollback" },
	expect: ok()
})

/** A statement on the runner's observer connection, as the owner. */
export const check = (text: string, expect: Expectation<ScheduleOutcome>): Step<never> => ({
	_tag: "Check",
	sql: text,
	expect
})
