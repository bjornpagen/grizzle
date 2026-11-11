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
 *   	rollback("w")
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

/** A planted writer's BEGIN below SERIALIZABLE: its writes are to be refused. */
export const beginBelow = <D extends string>(session: D, level: BelowSerializable): Step<D> => ({
	_tag: "Perform",
	session,
	action: { _tag: "BeginBelow", level },
	expect: ok()
})

export const rollback = <D extends string>(session: D): Step<D> => ({
	_tag: "Perform",
	session,
	action: { _tag: "Rollback" },
	expect: ok()
})
