import { Array as Arr, Formatter } from "effect"
import { messageOf } from "#test/support/message.ts"
import type {
	Expectation,
	ScheduleOutcome,
	StepOutcome,
	Verdict
} from "#test/support/schedules/types.ts"
import { messageText } from "#test/support/substrate/errors.ts"
import type { TextRows } from "#test/support/substrate/substrate.ts"

export const meets = (shown: string): Verdict => ({ _tag: "Meets", shown })

export const misses = (shown: string, why: string): Verdict => ({ _tag: "Misses", shown, why })

const printRows = (rows: TextRows): string =>
	rows.length === 0
		? "no rows"
		: Arr.join(
				Arr.map(
					rows,
					(row) =>
						`(${Arr.join(
							Arr.map(row, (value) => (value === null ? "NULL" : Formatter.format(value))),
							", "
						)})`
				),
				" "
			)

/** An outcome in words, for failure reports. */
export const describeOutcome = (outcome: ScheduleOutcome): string => {
	switch (outcome._tag) {
		case "Ok":
			return `ok, ${outcome.rowCount} row${outcome.rowCount === 1 ? "" : "s"}${outcome.rows.length === 0 ? "" : `: ${printRows(outcome.rows)}`}`
		case "PgError":
			return `SQLSTATE ${outcome.fields.code}${outcome.fields.constraint === undefined ? "" : ` on ${outcome.fields.constraint}`} (${messageText(outcome.fields)})`
		case "RolledBack":
			return `rolled back (COMMIT answered ${outcome.command})`
		case "Failed":
			return `failed: ${messageOf(outcome.error)}`
	}
}

/** A step's outcome in words: a direct outcome, or an interruption. */
export const describeStepOutcome = (outcome: StepOutcome): string => {
	switch (outcome._tag) {
		case "Interrupted":
			return "interrupted where it waited on a lock"
		case "Ok":
		case "PgError":
		case "RolledBack":
		case "Failed":
			return describeOutcome(outcome)
	}
}

/** A direct outcome meets `what` exactly when `holds` does. */
const outcomeIs =
	(what: string, holds: (outcome: ScheduleOutcome) => boolean): Expectation<ScheduleOutcome> =>
	(outcome) => {
		const shown = describeOutcome(outcome)
		return holds(outcome) ? meets(shown) : misses(shown, `expected ${what}`)
	}

/**
 * Expectations of a direct step's outcome, and printing outcomes.
 *
 * Success, its rows unchecked.
 */
export const ok = (): Expectation<ScheduleOutcome> =>
	outcomeIs("ok", (outcome) => outcome._tag === "Ok")
