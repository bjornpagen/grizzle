/** What the properties of cancel-race.test.ts read: its spaces, models and helpers. */

import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Clock, Deferred, Effect, Exit } from "effect"

/** Where the interruption's first CancelRequest lands (see the header). */
type Lands = "before the read" | "during the wait" | "never"

/** How the flight runs its statements: each alone, or in one transaction. */
type Runner = "apart" | "transaction"

interface RaceCase {
	readonly runner: Runner
	/** The inserts before the locking statement. */
	readonly before: number
	/** The inserts after the locking statement. */
	readonly after: number
	readonly lands: Lands
}

const landings = ["before the read", "during the wait", "never"] as const

const runners = ["apart", "transaction"] as const

/** Every case: each runner, up to two inserts on either side of the locking statement, and each landing. */
export const raceCases: Gen<RaceCase> = (source) => ({
	runner: source.draw(element(runners)),
	before: source.draw(int(0, 2)),
	after: source.draw(int(0, 2)),
	lands: source.draw(element(landings))
})

export type RaceFeature = Lands | Runner

/**
 * A clock whose sleeps end only when the case ends them (wake), each registered as it starts, so the case knows when
 * abandon sleeps; it reads the time from the machine's clock.
 */
export const manualClock = () => {
	const live = Clock.Clock.defaultValue()
	const sleeping = new Set<Deferred.Deferred<void>>()
	const clock: Clock.Clock = {
		currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
		currentTimeMillis: live.currentTimeMillis,
		currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
		currentTimeNanos: live.currentTimeNanos,
		monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
		monotonicTimeNanos: live.monotonicTimeNanos,
		sleep: () =>
			Effect.suspend(() => {
				const slept = Deferred.makeUnsafe<void>()
				sleeping.add(slept)
				return Effect.ensuring(
					Deferred.await(slept),
					Effect.sync(() => {
						sleeping.delete(slept)
					})
				)
			})
	}
	return {
		clock,
		/** How many sleeps are under way. */
		sleeping: (): number => sleeping.size,
		/**
		 * Ends every sleep under way now, and none a woken fiber starts meanwhile, which a Set's iteration would visit.
		 */
		wake: (): void => {
			for (const slept of Arr.fromIterable(sleeping)) {
				Deferred.doneUnsafe(slept, Exit.void)
			}
		}
	}
}
