import { Effect } from "effect"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"

/**
 * Every failure a call ends with but a transient refusal: what a call `settled` runs ends with, since it runs the call
 * again past each transient one.
 */
export type Settled = Exclude<CallError, CallErrorOf<"transient">>

/**
 * `call` run again at once while it fails `transient`, and ended by its value or by any other failure, which it fails
 * with as it is: the one combinator a caller applies to run a call to an answer that is not a transient refusal.
 * grizzle never runs a call again by itself; a caller that wants this applies it.
 *
 * A transient refusal changed nothing, and it means another transaction's work committed first: SERIALIZABLE refused
 * the attempt (40001), a deadlock aborted it (40P01), or the statement met a concurrent transaction's committed change
 * (TransientReason names which). PostgreSQL's serializable isolation raises 40001 only where a run of the same
 * transaction from the beginning does not meet the same conflict again ("The second time through, the transaction will
 * see the previously-committed change as part of its initial view of the database", PostgreSQL 19's Transaction
 * Isolation, Serializable Isolation Level), so each attempt after the first starts past work that committed, and the
 * system advances whatever the attempts number. No count of attempts is defensible: any bound refuses a call that its
 * next attempt completes. A caller that answers by a deadline states it on the call itself (`Effect.timeout`), its own
 * decision, never this combinator's.
 *
 * The failure keeps the call's own kinds but `transient`, so a call that fails with fewer kinds than every CallError
 * keeps them; over every kind it is Settled.
 */
export const settled = <A, E extends CallError, R>(
	call: Effect.Effect<A, E, R>
): Effect.Effect<A, Exclude<E, Extract<E, CallErrorOf<"transient">>>, R> =>
	Effect.retry(call, {
		while: (error: E): error is Extract<E, CallErrorOf<"transient">> => error.kind === "transient"
	})
