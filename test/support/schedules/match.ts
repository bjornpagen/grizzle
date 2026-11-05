import { exact, multiset, ordered } from "@grizzle/testing/oracle"
import { Array as Arr, Formatter, Option } from "effect"
import type { LawId } from "#compiler/core/ids.ts"
import { messageOf } from "#test/support/message.ts"
import type {
	Expectation,
	ScheduleOutcome,
	StepOutcome,
	Verdict
} from "#test/support/schedules/types.ts"
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
			return `SQLSTATE ${outcome.fields.code}${outcome.fields.constraint === undefined ? "" : ` on ${outcome.fields.constraint}`} (${outcome.fields.message})`
		case "RolledBack":
			return `rolled back (COMMIT answered ${outcome.command})`
		case "Failed":
			return `failed: ${messageOf(outcome.error)}`
	}
}

/** A verdict in words, for failure reports. */
export const describeVerdict = (verdict: Verdict): string => {
	switch (verdict._tag) {
		case "Meets":
			return `meets ${verdict.shown}`
		case "Misses":
			return `misses (${verdict.why}) ${verdict.shown}`
	}
}

/** A step's outcome in words: a direct outcome, an operation's verdict, or an interruption. */
export const describeStepOutcome = (outcome: StepOutcome): string => {
	switch (outcome._tag) {
		case "Judged":
			return describeVerdict(outcome.verdict)
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

/** Rows in order, cell by cell; and rows as a multiset, each row cell by cell. */
type Rows = ReadonlyArray<ReadonlyArray<string | null>>
const sameRows = (a: Rows, b: Rows): boolean => Option.isNone(ordered(ordered(exact))(a, b))
const sameRowSet = (a: Rows, b: Rows): boolean => Option.isNone(multiset(ordered(exact))(a, b))

/** Success, its rows unchecked. */
export const ok = (): Expectation<ScheduleOutcome> =>
	outcomeIs("ok", (outcome) => outcome._tag === "Ok")

/**
 * Expectations of a direct step's outcome, the combinator over any expectation, and printing outcomes.
 *
 * Rows compare cell by cell, through the testing library's equivalences; a row set is a multiset of rows, so no
 * comparison goes through a text rendering of the values.
 *
 * Success with exactly these text rows, in order. `rows()` is success with no rows.
 */
export const rows = (...expected: TextRows): Expectation<ScheduleOutcome> =>
	outcomeIs(
		`rows ${printRows(expected)}`,
		(outcome) => outcome._tag === "Ok" && sameRows(outcome.rows, expected)
	)

/** Success with these text rows in any order, each as many times. */
export const rowSet = (expected: TextRows): Expectation<ScheduleOutcome> =>
	outcomeIs(
		`row set ${printRows(expected)}`,
		(outcome) => outcome._tag === "Ok" && sameRowSet(outcome.rows, expected)
	)

/** A residual law's refusal: the law function raises SQLSTATE 23000 with the law's identifier as its CONSTRAINT. */
export const law = (id: LawId, code: "23000"): Expectation<ScheduleOutcome> =>
	outcomeIs(
		`SQLSTATE ${code} on ${id}`,
		(outcome) =>
			outcome._tag === "PgError" && outcome.fields.code === code && outcome.fields.constraint === id
	)

/** COMMIT answered with ROLLBACK because the transaction had already failed. */
export const rolledBack = (): Expectation<ScheduleOutcome> =>
	outcomeIs("rolled back", (outcome) => outcome._tag === "RolledBack")

/** The first option the result meets; a miss names why each option missed. */
export const anyOf = <A>(...options: Arr.NonEmptyReadonlyArray<Expectation<A>>): Expectation<A> =>
	firstMet(options)

/** anyOf over a list of options. */
export const firstMet =
	<A>(options: Arr.NonEmptyReadonlyArray<Expectation<A>>): Expectation<A> =>
	(actual) => {
		const [first, ...rest] = options
		const missed = first(actual)
		if (missed._tag === "Meets") {
			return missed
		}
		const whys = [missed.why]
		for (const option of rest) {
			const verdict = option(actual)
			if (verdict._tag === "Meets") {
				return verdict
			}
			whys.push(verdict.why)
		}
		return misses(
			missed.shown,
			`none of ${options.length} options: ${Arr.join(
				Arr.map(whys, (why, i) => `(${i + 1}) ${why}`),
				"; "
			)}`
		)
	}
