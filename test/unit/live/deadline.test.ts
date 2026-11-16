/**
 * The leader's stream deadline (packages/grizzle/src/adapter/live/leader.ts deadlined), the replication session's own
 * wal_sender_timeout as its setting's text states it (engine live/replication.ts parseSenderDeadline), under a test
 * clock: a body that never ends hears messages after drawn gaps of silence.
 *
 * - A stream ends with ReplicationSilent exactly when it has heard nothing for its deadline: it stands at a drawn
 *   instant short of the deadline after its last message, or after it began where none came, and has ended at it; a
 *   timeout of 0 never ends it, through a silence its drawn deadline would end. Oracle: the first drawn gap at least
 *   the deadline, a specification.
 *
 * Features: a stream silent from its start, a message one millisecond short of the deadline, a stream standing one
 * millisecond short of it, a stream heard several times before its end, and a timeout of 0.
 */
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Clock, Deferred, Duration, Effect, Exit, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { deadlined, ReplicationSilent } from "#adapter/live/leader.ts"
import { parseSenderDeadline } from "#compiler/plan/runtime.ts"
import { assert } from "#test/support/assert.ts"
import { type Feature, silenceSpace } from "#test/unit/live/deadline.fixtures.ts"

/**
 * A stream of the leader's deadline ends with ReplicationSilent exactly once it has heard nothing for its
 * wal_sender_timeout, and never under 0.
 *
 * Budget: its suite's count before the conversion (unit/live/deadline: 300 independent cases and 0 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theLeadersStreamDeadlineAStreamEndsWithReplicationSilentExactlyOnceItHasHeardNothingForItsWalSenderTimeoutAndNeverUnder0 =
	property.explore(silenceSpace, {
		needs: {},
		situations: [
			"a stream silent from its start",
			"a message one millisecond short of the deadline",
			"a stream standing one millisecond short of it",
			"a stream heard several times before its end",
			"a timeout of 0"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			(_, c: Case<Feature>) =>
			({ disabled, millis, shortBy, gaps }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const clock = yield* TestClock.make()
						return yield* Effect.provideService(
							Effect.gen(function* () {
								const parsed = parseSenderDeadline(String(disabled ? 0 : millis))
								assert.ok(parsed.ok, "the setting's text reads as a deadline")
								const deadline = parsed.value
								assert.deepEqual(
									deadline,
									disabled ? { kind: "none" } : { kind: "after", millis },
									"a timeout of 0 sets no deadline, and any other its milliseconds"
								)
								const started = yield* Deferred.make<() => void>()
								const watched = yield* Effect.forkChild(
									Effect.flip(
										deadlined(deadline, (heard) =>
											Effect.andThen(Deferred.succeed(started, heard), Effect.never)
										)
									)
								)
								const heard = yield* Deferred.await(started)
								const standing = (claim: string): void => {
									assert.equal(watched.pollUnsafe(), undefined, claim)
								}
								const ended = (claim: string): void => {
									const exit = watched.pollUnsafe()
									assert.ok(
										exit !== undefined &&
											Exit.isSuccess(exit) &&
											exit.value instanceof ReplicationSilent &&
											exit.value.millis === millis,
										claim
									)
								}
								const silent = (): Effect.Effect<void> =>
									Effect.gen(function* () {
										yield* clock.adjust(Duration.millis(millis - shortBy))
										standing("short of its deadline a silent stream stands")
										yield* clock.adjust(Duration.millis(shortBy))
										ended("at its deadline a silent stream has ended with ReplicationSilent")
									})
								const reaching = Arr.findFirstIndex(gaps, (gap) => !disabled && gap >= millis)
								const heardGaps = Option.isSome(reaching) ? Arr.take(gaps, reaching.value) : gaps
								for (const gap of heardGaps) {
									if (!disabled && gap === millis - 1) {
										c.note("a message one millisecond short of the deadline")
									}
									yield* clock.adjust(Duration.millis(gap))
									standing("a stream heard within its deadline stands")
									heard()
								}
								if (disabled) {
									c.note("a timeout of 0")
									yield* clock.adjust(Duration.millis(millis))
									standing(
										"a timeout of 0 sets no deadline, through a silence its drawn one would end"
									)
								} else {
									if (shortBy === 1) {
										c.note("a stream standing one millisecond short of it")
									}
									if (heardGaps.length === 0) {
										c.note("a stream silent from its start")
									}
									if (heardGaps.length > 1) {
										c.note("a stream heard several times before its end")
									}
									yield* silent()
								}
								yield* Fiber.interrupt(watched)
							}),
							Clock.Clock,
							clock
						)
					})
				),
		oracle: { kind: "specification", name: "the first gap at least the deadline" },
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/adapter/live/leader.ts",
				original: "\t\t\t\t\t\t\t? Effect.fail(new ReplicationSilent({ millis: deadline.millis }))",
				replacement: "\t\t\t\t\t\t\t? clock.sleep(span)",
				why: "Where the stream has been silent for its deadline, the watch sleeps another one in place of ending it, so a leader whose connection the network dropped without a word holds the installation's lock forever."
			}
		]
	})
