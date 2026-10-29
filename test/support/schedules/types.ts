import type { Effect } from "effect"
import type { LockWait } from "#test/support/substrate/barrier.ts"
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
 * A grizzle operation and its expectation over one result type. `run` never fails: build.ts `op` wraps the caller's
 * effect in Effect.result, so for an operation A is `Result.Result<X, E>`.
 */
export interface ScheduleOp<A> {
	readonly run: Effect.Effect<A>
	readonly expect: Expectation<A>
}

/** An Op whose result type is hidden, so one step list holds operations of different result types. */
export interface AnyOp {
	readonly unpack: <R>(use: <A>(op: ScheduleOp<A>) => R) => R
}

/** A step's name in the trace and in failures, by which outcomeOf finds it. */
export type StepId = { readonly _tag: "Unnamed" } | { readonly _tag: "Named"; readonly id: string }

/**
 * A step's wait, or an Await's: the step must never be observed waiting on a lock another session of the schedule
 * holds, or it may be (it closes a deadlock cycle, or waits out one). An Await's joined step must have completed by the
 * Await either way; the driver breaks every deadlock before it decides the next step.
 */
export type Join = { readonly _tag: "Complete" } | { readonly _tag: "May" }

/** The holder a blocked step must be observed waiting on: any backend, or the named session's. */
export type Blocker<S extends string> =
	| { readonly _tag: "Any" }
	| { readonly _tag: "Session"; readonly session: S }

/**
 * What a session step's waiting must be:
 * - Complete: the step must finish without ever being observed waiting on a lock another session of the schedule
 *   holds;
 * - May: anything; only its result is judged;
 * - Blocks: the step must be observed waiting on a lock held by `by` (or by any session of the schedule); its result
 *   is judged when a later Await joins it. A step that answers 40P01 waited, since only a waiting backend is a deadlock
 *   victim; and a step that completed because PostgreSQL broke the cycle it closed by aborting `by`'s step, observed
 *   waiting on this one, waited on `by` too. Which waiter PostgreSQL aborts is its choice, so either meets Blocks.
 */
export type Wait<S extends string> = Join | { readonly _tag: "Blocks"; readonly by: Blocker<S> }

/**
 * D: the direct sessions a step runs on, G: the grizzle sessions, W: every session it names (a Blocks wait's session,
 * an Await's session). runSchedule requires W ⊆ D | G and D, G to be the actors' own keys.
 */
export type Step<D extends string, G extends string, W extends string> =
	| {
			readonly _tag: "Perform"
			readonly id: StepId
			readonly session: D
			readonly action: DirectAction
			readonly expect: Expectation<ScheduleOutcome>
			readonly wait: Wait<W>
	  }
	| {
			readonly _tag: "Operate"
			readonly id: StepId
			readonly session: G
			readonly name: string
			readonly op: AnyOp
			readonly wait: Wait<W>
	  }
	| { readonly _tag: "Await"; readonly id: StepId; readonly session: W; readonly join: Join }
	| {
			readonly _tag: "Check"
			readonly id: StepId
			readonly sql: string
			readonly expect: Expectation<ScheduleOutcome>
	  }

/**
 * The schedule model: named sessions, ordered steps, and what each step must produce.
 *
 * A schedule is a handcrafted interleaving of concurrent sessions, "for race conditions that random row data cannot
 * establish". A step runs raw SQL or a psql statement on a direct session, a grizzle operation on a grizzle session, or
 * a check on the driver's observer, and its result is judged by the step's expectation: rows, a SQLSTATE, a commit
 * raising law X, or a grizzle operation's typed result. A schedule is data: runner.ts compiles
 * it into a script for the one concurrency driver, whose choices are the steps in order, and judges
 * the run the driver records against each step's expectation and wait. Nothing sleeps and nothing is judged by time.
 *
 * Sessions are named by type: D the direct sessions, G the grizzle sessions, W every session a step names. A step on a
 * session no actor plays, SQL on a grizzle session, and a wait that both blocks and may wait do not compile.
 */
export interface Schedule<D extends string, G extends string, W extends string> {
	readonly name: string
	readonly steps: ReadonlyArray<Step<D, G, W>>
}

/**
 * What a step did: a direct step's or check's outcome, or an operation's verdict, when the operation judges its own
 * typed result (a schedule's Operate step); an operation that does not succeeds as Ok or fails as its failure.
 */
export type StepOutcome =
	| ScheduleOutcome
	| { readonly _tag: "Judged"; readonly verdict: Verdict }
	| { readonly _tag: "Interrupted" }

interface EntryHead {
	readonly index: number
	readonly id: StepId
	/** A session's name, or "observer" for a Check. */
	readonly session: string
	readonly label: string
}

/**
 * One executed step, in order. A blocked step appears when it is observed waiting and again, finished, at the Await
 * that joins it.
 */
export type TraceEntry = EntryHead &
	(
		| { readonly _tag: "Finished"; readonly outcome: StepOutcome }
		| {
				readonly _tag: "Blocked"
				readonly wait: LockWait
				readonly blockedBy: ReadonlyArray<string>
		  }
		| { readonly _tag: "Victim" }
		| { readonly _tag: "Unfinished" }
	)

export interface Trace {
	readonly schedule: string
	readonly entries: ReadonlyArray<TraceEntry>
}
