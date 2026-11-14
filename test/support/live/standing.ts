import { Effect, Formatter, Option, Stream } from "effect"
import type { ListEvent, SetEvent } from "#compiler/live/index.ts"

/**
 * The installation's live source standing for `watch`, a read's in-process watch: its events run to the first that
 * settles them, a `ready` or the `error` that ended them, and the watch called again each time that error is
 * `unavailable`, whose retry is safe, as a call's contract asks of its caller. A fresh installation's first live
 * registrations, an HTTP read's once among them, which is its watch's first value, meet no replication slot until the
 * live leader the first of them starts makes one (adapter/errors/failures.ts SlotAbsent). The refusal itself paces it,
 * never a timer. It answers how many calls were refused before the source stood. Any other error, or a watch that
 * ends unsettled, fails the case.
 */
export const standing = (
	watch: () => Stream.Stream<SetEvent<object> | ListEvent<object>>
): Effect.Effect<number> => {
	const from = (refused: number): Effect.Effect<number> =>
		Effect.flatMap(
			Stream.runHead(Stream.filter(watch(), (e) => e.kind === "ready" || e.kind === "error")),
			(settled) => {
				if (Option.isNone(settled)) {
					return Effect.die("a watch settles at its ready or its error")
				}
				const event = settled.value
				if (event.kind === "ready") {
					return Effect.succeed(refused)
				}
				return event.error.kind === "unavailable"
					? from(refused + 1)
					: Effect.die(
							`a watch settles at its ready, or is refused unavailable and safe to call again: ${Formatter.format(event)}`
						)
			}
		)
	return from(0)
}
