import { Effect } from "effect"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"

/**
 * A call run as the application runs it: again after each transient refusal, and only after one, each refused attempt
 * handed to `refused` first. grizzle makes one attempt per call and never retries; a transient refusal is one a
 * concurrent transaction's work caused, which changed nothing, and running the call again is the caller's policy. No
 * count bounds it: each refusal is another transaction's doing, and SSI's refusals under a cluster's load (a summarized
 * writer, a retained reader held concurrent by the cluster's oldest snapshot) last as long as that load does, so a call
 * that never answers hangs its case (caseHang). Every other failure is the call's own.
 */
export const untilAnswered = <A, R>(
	call: Effect.Effect<A, CallError, R>,
	refused: (transient: CallErrorOf<"transient">) => void
): Effect.Effect<A, CallError, R> =>
	Effect.catchIf(call, isTransient, (transient) =>
		Effect.suspend(() => {
			refused(transient)
			return untilAnswered(call, refused)
		})
	)

/** Whether a call's failure is a transient refusal, which the caller runs the call again after (`untilAnswered`). */
const isTransient = (error: CallError): error is CallErrorOf<"transient"> =>
	error.kind === "transient"
