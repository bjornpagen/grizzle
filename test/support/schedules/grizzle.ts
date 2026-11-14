import { Effect, Result } from "effect"
import type { ApplyError, TransientFailure } from "#adapter/errors/execution.ts"
import type { TransientTag } from "#compiler/core/errors.ts"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"

/**
 * What a retried operation reports: the reason of each refused call in order, then the value of the call that
 * answered.
 */
export interface Retried<A> {
	readonly refused: ReadonlyArray<TransientTag>
	readonly answered: A
}

/** A call's failures but its transient refusal, which the caller runs the call again after. */
export type Answered = Exclude<CallError, CallErrorOf<"transient">>

/**
 * A grizzle write as an application calls it: again after each transient refusal, until a call answers.
 *
 * grizzle makes one attempt per call (the round-trip suite, test/pg/adapter/round-trips.test.ts, holds every public
 * call to one round trip). Every refusal is a concurrent transaction's (PostgreSQL 19rc2's
 * src/backend/storage/lmgr/README-SSI: "no transaction is canceled until one of the other transactions in the set of
 * conflicts which could generate an anomaly has successfully committed"), and no count of them is PostgreSQL's: while
 * one commits, every attempt that reads its writes is refused until the commit is visible to a new snapshot, however
 * many (test/schedules/platform/support.ts runGrizzle). So a write a model judges is retried until it answers, which it
 * does once the race's other transactions have ended, a write that never answers being its case's hang (caseHang). Any
 * other failure is the failure, so none is a refusal. Each refusal is read by its reason (CallError transient
 * `reason`).
 */
export const untilAnswered = <A, R>(
	call: Effect.Effect<A, CallError, R>
): Effect.Effect<Retried<A>, Answered, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientTag> = []
		for (;;) {
			const result = yield* Effect.result(call)
			if (Result.isSuccess(result)) {
				return { refused, answered: result.success }
			}
			const error = result.failure
			if (error.kind !== "transient") {
				return yield* Effect.fail(error)
			}
			refused.push(error.reason)
		}
	})

/**
 * A write of the write runtime's own suites, which read its internal outcome and errors (test/support/served-db.ts
 * applicationOf), called as untilAnswered calls one: again after each TransientFailure, each refused attempt's reason
 * kept.
 */
export const untilApplied = <A, R>(
	call: Effect.Effect<A, ApplyError, R>
): Effect.Effect<Retried<A>, Exclude<ApplyError, TransientFailure>, R> =>
	Effect.gen(function* () {
		const refused: Array<TransientTag> = []
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
