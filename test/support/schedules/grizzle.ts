import { Effect, Result } from "effect"
import type { ApplyError, TransientFailure } from "#adapter/errors/execution.ts"
import { type TransientReason } from "#compiler/core/errors.ts"

/**
 * What a retried operation reports: the reason of each refused call in order, then the value of the call that
 * answered.
 */
export interface Retried<A> {
	readonly refused: ReadonlyArray<TransientReason["_tag"]>
	readonly answered: A
}

/**
 * A grizzle write as an application calls it: again after each TransientFailure, until a call answers.
 *
 * grizzle makes one attempt per call (the round-trip suite, test/pg/adapter/suites/round-trips.ts, holds every public
 * call to one round trip). Every refusal is a concurrent transaction's (PostgreSQL 19rc1's
 * src/backend/storage/lmgr/README-SSI: "no transaction is canceled until one of the other transactions in the set of
 * conflicts which could generate an anomaly has successfully committed"), and no count of them is PostgreSQL's: while
 * one commits, every attempt that reads its writes is refused until the commit is visible to a new snapshot, however
 * many (test/schedules/platform/support.ts runGrizzle). So a write a model judges is retried until it answers, which it
 * does once the race's other transactions have ended, a write that never answers being its case's hang (caseHang). Any
 * other failure is the failure, so none is a refusal.
 */
export const untilAnswered = <A, R>(
	call: Effect.Effect<A, ApplyError, R>
): Effect.Effect<Retried<A>, Exclude<ApplyError, TransientFailure>, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientReason["_tag"]> = []
		for (;;) {
			const result = yield* Effect.result(call)
			if (Result.isSuccess(result)) {
				return { refused, answered: result.success }
			}
			const error = result.failure
			if (error._tag !== "TransientFailure") {
				return yield* Effect.fail(error)
			}
			refused.push(error.reason._tag)
		}
	})
