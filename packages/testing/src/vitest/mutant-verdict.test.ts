import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Deferred, Duration, Effect, Fiber, Formatter } from "effect"
import { TestClock } from "effect/testing"
import { exhaust } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { boolean, element } from "#gen.ts"
import { type RunVerdict, type TimedVerdict, verdictWithin } from "#vitest/mutant-verdict.ts"
import { searched } from "#vitest/searched.ts"

/** How a mutant's run ends, simplest first. */
const ENDINGS = ["killed", "survived", "past its deadline"] as const

type Ending = (typeof ENDINGS)[number]

/** A run's deadline in these cases, on the test clock. */
const DEADLINE = Duration.seconds(10)

/** The verdict a run that ends as `ending` must get, however long its release takes. */
const expectedOf = (ending: Ending): TimedVerdict => {
	switch (ending) {
		case "killed":
			return { kind: "killed", by: "a failing test" }
		case "survived":
			return { kind: "survived" }
		case "past its deadline":
			return { kind: "timeout" }
	}
}

/** A run that says it has started, then ends as `ending`. */
const runOf = (ending: Ending, started: Deferred.Deferred<void>): Effect.Effect<RunVerdict> => {
	const begun = Deferred.succeed(started, undefined)
	switch (ending) {
		case "killed":
			return Effect.as(begun, { kind: "killed", by: "a failing test" })
		case "survived":
			return Effect.as(begun, { kind: "survived" })
		case "past its deadline":
			return Effect.andThen(begun, Effect.never)
	}
}

describe("a mutant's verdict", () => {
	it.effect(
		"is what its run decided, or a timeout when the run is past its deadline, however long its workers take to stop",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "mutant verdict",
						generator: (source) => ({
							ending: source.draw(element(ENDINGS)),
							slowStop: source.draw(boolean)
						}),
						literal: Formatter.format,
						limit: 6,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					({ ending, slowStop }) =>
						Effect.gen(function* () {
							const started = yield* Deferred.make<void>()
							const releasing = yield* Deferred.make<void>()
							const stopped = yield* Deferred.make<void>()
							if (!slowStop) {
								yield* Deferred.succeed(stopped, undefined)
							}
							const suite = Effect.acquireRelease(Effect.succeed(runOf(ending, started)), () =>
								Effect.andThen(Deferred.succeed(releasing, undefined), Deferred.await(stopped))
							)
							const judging = yield* Effect.forkChild(verdictWithin(suite, DEADLINE))
							yield* Deferred.await(started)
							yield* TestClock.adjust(DEADLINE)
							yield* Deferred.await(releasing)
							yield* TestClock.adjust("1 minute")
							yield* Deferred.succeed(stopped, undefined)
							const verdict = yield* Fiber.join(judging)
							deepStrictEqual(verdict, expectedOf(ending))
						})
				)
			)
	)
})
