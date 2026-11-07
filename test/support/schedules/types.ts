import type { PgErrorFields } from "#test/support/substrate/errors.ts"
import type { BelowSerializable } from "#test/support/substrate/session.ts"
import type { TextRows } from "#test/support/substrate/substrate.ts"

/**
 * What a direct session does in one step. Every transaction begins SERIALIZABLE; BeginBelow is a planted writer below
 * it, whose writes grizzle refuses.
 */
export type DirectAction =
	| { readonly _tag: "Sql"; readonly sql: string }
	| { readonly _tag: "Begin" }
	| { readonly _tag: "BeginBelow"; readonly level: BelowSerializable }
	| { readonly _tag: "Commit" }
	| { readonly _tag: "Rollback" }

/**
 * What a direct step, an observer check or an explorer move did. A defect or interruption is not an outcome: it ends
 * the schedule as a defect.
 */
export type ScheduleOutcome =
	| { readonly _tag: "Ok"; readonly rows: TextRows; readonly rowCount: number }
	| { readonly _tag: "PgError"; readonly fields: PgErrorFields }
	| { readonly _tag: "RolledBack"; readonly command: string }
	| { readonly _tag: "Failed"; readonly error: unknown }

/** A judgment of one typed result. `shown` renders the result for messages only; it is never compared. */
export type Verdict =
	| { readonly _tag: "Meets"; readonly shown: string }
	| { readonly _tag: "Misses"; readonly shown: string; readonly why: string }

/** What a step must produce, judged on its typed result. */
export type Expectation<A> = (actual: A) => Verdict

/**
 * D: the direct sessions a step runs on. A step runs an action on a direct session, which must complete without
 * waiting on a lock another session of the schedule holds, or a check on the driver's observer; each is judged by its
 * expectation.
 */
export type Step<D extends string> =
	| {
			readonly _tag: "Perform"
			readonly session: D
			readonly action: DirectAction
			readonly expect: Expectation<ScheduleOutcome>
	  }
	| { readonly _tag: "Check"; readonly sql: string; readonly expect: Expectation<ScheduleOutcome> }

/**
 * A schedule: direct sessions' steps in order, and what each must produce: rows, a SQLSTATE, a commit that rolled back.
 * A schedule is data: runner.ts compiles it into a script for the one concurrency driver, whose choices are the steps
 * in order, and judges the run the driver records against each step's expectation. Nothing sleeps and nothing is
 * judged by time. A step on a session no actor plays does not compile.
 */
export interface Schedule<D extends string> {
	readonly name: string
	readonly steps: ReadonlyArray<Step<D>>
}

/** What a step did: a direct step's or check's outcome, or a move interrupted where it waited on a lock. */
export type StepOutcome = ScheduleOutcome | { readonly _tag: "Interrupted" }
