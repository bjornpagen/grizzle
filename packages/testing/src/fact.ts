import { Effect, Option } from "effect"

/**
 * Waits for a fact by observing it: runs `fact` back to back, yielding to the other fibers between polls, until it
 * returns a value, and returns that value. A test never sleeps to let a concurrent step "probably" reach a point; it
 * polls what the system states (a lock wait in `pg_locks`, a row, a queue's length) until it holds. Nothing waits on a
 * timer and nothing is judged by time, so the wait passes under a TestClock that never moves, and a fact that never
 * holds is bounded only by the case's hang guard, which reports it hung.
 */
export const awaitFact = <A, E, R>(
	fact: Effect.Effect<Option.Option<A>, E, R>
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		let seen = yield* fact
		while (Option.isNone(seen)) {
			yield* Effect.yieldNow
			seen = yield* fact
		}
		return seen.value
	})
