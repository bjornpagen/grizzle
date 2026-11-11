import { Effect } from "effect"
import { TransientFailure } from "#adapter/public/errors.ts"

/**
 * A call run as the application runs it: again after each TransientFailure, and only after one, each refused attempt
 * handed to `refused` first. grizzle makes one attempt per call and never retries; a TransientFailure is a refusal a
 * concurrent transaction's work caused, which changed nothing, and running the call again is the caller's policy. No
 * count bounds it: each refusal is another transaction's doing, and SSI's refusals under a cluster's load (a summarized
 * writer, a retained reader held concurrent by the cluster's oldest snapshot) last as long as that load does, so a call
 * that never answers hangs its case (caseHang). Every other failure is the call's own.
 */
export const untilAnswered = <A, E, R>(
	call: Effect.Effect<A, E, R>,
	refused: (transient: TransientFailure) => void
): Effect.Effect<A, E, R> =>
	Effect.catchIf(call, isTransient, (transient) =>
		Effect.suspend(() => {
			refused(transient)
			return untilAnswered(call, refused)
		})
	)

/** Whether a call's failure is a TransientFailure, which the caller runs the call again after (`untilAnswered`). */
const isTransient = <E>(error: E): error is E & TransientFailure =>
	error instanceof TransientFailure
