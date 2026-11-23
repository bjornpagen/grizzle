import { Effect, Formatter, Option, Stream } from "effect"
import type { CallInput, LiveCalls } from "#test/support/live/system.ts"

/**
 * The installation's live source standing for the read `member` with `input` on `calls`, a surface's calls
 * (test/support/live/system.ts LiveCalls): the read's watch run to its first value, which a fresh installation's first
 * live reads, an HTTP read's once among them, answer once the live leader the first of them starts has made the slot
 * (adapter/live/listen.ts: the source's open waits for the leader's `stands`). An error, or a watch that ends with no value, fails the case.
 */
export const standingOn = (
	calls: LiveCalls,
	member: string,
	input: CallInput
): Effect.Effect<void> =>
	Effect.matchEffect(Stream.runHead(calls.watch(member, input)), {
		onFailure: (error) => Effect.die(`a watch answers its first value: ${Formatter.format(error)}`),
		onSuccess: (first) =>
			Option.isNone(first)
				? Effect.die(`the watch of ${member} ends with no value and no error`)
				: Effect.void
	})
