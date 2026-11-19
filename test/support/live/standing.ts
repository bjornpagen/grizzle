import { Effect, Formatter, Option, Stream } from "effect"
import type { ListEvent, SetEvent } from "#compiler/live/index.ts"
import type { CallInput, LiveCalls } from "#test/support/live/system.ts"

/**
 * The installation's live source standing for `watch`, a read's in-process watch: its events run to the first that
 * settles them, which is its `ready`. A fresh installation's first live registrations, an HTTP read's once among them,
 * which is its watch's first value, meet no replication slot until the live leader the first of them starts makes one,
 * and wait for it (adapter/live/listen.ts: the source's open waits for the leader's `stands`), so the first settling
 * event is the ready. An error, or a watch that ends unsettled, fails the case.
 */
export const standing = (
	watch: Stream.Stream<SetEvent<object> | ListEvent<object>>
): Effect.Effect<void> =>
	Effect.flatMap(
		Stream.runHead(Stream.filter(watch, (e) => e.kind === "ready" || e.kind === "error")),
		(settled) =>
			Option.isSome(settled) && settled.value.kind === "ready"
				? Effect.void
				: Effect.die(`a watch settles at its ready: ${Formatter.format(settled)}`)
	)

/**
 * The installation's live source standing for the read `member` with `input` on `calls`, a surface's calls
 * (test/support/live/system.ts LiveCalls): the read's watch run to its first value, which a fresh installation's first
 * live reads, an HTTP read's once among them, answer once the live leader the first of them starts has made the slot
 * (standing). An error, or a watch that ends with no value, fails the case.
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
