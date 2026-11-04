import {
	type Case,
	drawn,
	type Explored,
	explore,
	type SearchFailure
} from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import type { Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, type Scope } from "effect"
import type { TestContext } from "vitest"
import type { Trace } from "#test/support/schedules/types.ts"

/** What a planted case reached: a schedule run to its end, and a step of it observed waiting. */
type PlantedFeature = `ran: ${string}` | `waited: ${string}`

/**
 * The cases of a planted property's rotating stream; the floor stream runs a quarter of them. Each case installs its
 * schema and runs its schedules in a fraction of a second, and every case reaches the window, so a few fresh draws a
 * run check the rule over values no earlier run drew.
 */
const plantedRuns = 4

/**
 * The shrink candidates a failing planted property tries: each reruns the case's schedules, and a case's drawn values
 * are a handful of keys and payloads, which this many candidates shrink.
 */
const plantedShrink = 20

/** Notes what a schedule's trace reached on the case. */
const noteTrace = (trace: Trace, c: Case<PlantedFeature>): void => {
	c.note(`ran: ${trace.schedule}`)
	for (const entry of trace.entries) {
		if (entry._tag === "Blocked" || entry._tag === "Victim") {
			c.note(`waited: ${trace.schedule}: ${entry.label}`)
		}
	}
}

/**
 * Planted schedules: the schedules a test writes by hand, run as a property over the values they run on.
 *
 * A hand schedule plants a window no generated race reaches (interleaves whole calls): a
 * step between two statements of one grizzle transaction, held there by a blocker fact another session is inserting,
 * or a lock one session holds while another's call waits on it. The window is constructed; the keys, payloads and
 * values it runs on are drawn by the testing library, so the window's rule is checked over
 * the values it must not depend on, fresh ones every run, and a failure shrinks to the smallest values that break it.
 * Each case opens its own installation and sessions, so no two cases share state.
 *
 * A case notes what its schedules reached (traces): each schedule that ran to its end, and each step
 * observed waiting, the window itself.
 *
 * A planted property: `property` runs the planted schedules on one drawn value and answers their traces; every schedule
 * named in `ran` must have run to its end over the run's cases, and a property that names none requires no coverage.
 */
export const planted =
	<T, E, R>(
		suite: string,
		draw: Gen<T>,
		ran: ReadonlyArray<string>,
		property: (value: T) => Effect.Effect<ReadonlyArray<Trace>, E, R | Scope.Scope>
	): ((ctx: TestContext) => Effect.Effect<Explored, SearchFailure, R>) =>
	(ctx) =>
		searched(
			ctx,
			explore(
				{
					suite,
					draw: drawn(draw),
					literal: Formatter.format,
					coverage: Arr.isReadonlyArrayNonEmpty(ran)
						? required<PlantedFeature>(
								Arr.map(ran, (name): PlantedFeature => `ran: ${name}`),
								{ cases: plantedRuns, sense: notesOnly }
							)
						: noCoverage,
					kept: [],
					runs: plantedRuns,
					shrink: { kind: "bounded", candidates: plantedShrink },
					concurrency: 1,
					steerEvery: plantedRuns,
					caseHang: Duration.minutes(2)
				},
				(value, c) =>
					Effect.gen(function* () {
						for (const trace of yield* Effect.scoped(property(value))) {
							noteTrace(trace, c)
						}
					})
			)
		)
