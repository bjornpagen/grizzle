/**
 * A retried answer is sent again after its `Retry-After` when one parses (seconds, or an HTTP date's distance), after
 * the backoff otherwise, and never past the effective `--timeout` (design D-AD7, 13.1 R6): a delay equal to the timeout
 * is waited, a longer one ends the run with that answer and the delay recorded, `--timeout 0` waits any delay, a status
 * the design does not retry ends the run at once, and a run whose retries run out records nothing. Time is virtual.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	aimedSchedules,
	expectedOf,
	type ScheduleFeature,
	scheduleFeatures
} from "#test/runtime/client-retry-after.fixtures.ts"

/**
 * A run's attempts follow the retry policy and its cap. It replaces eight example cases; its rotating stream is eight
 * drawn schedules, its floor and steered phase reach each situation by an aimed one.
 */
export const retrySchedule = property.explore(aimedSchedules, {
	needs: {},
	situations: [
		"a delay waited",
		"a delay equal to the timeout",
		"a delay past the timeout",
		"an HTTP date",
		"no cap, a long delay waited",
		"retries run out",
		"a status not retried",
		"an invalid Retry-After"
	] satisfies ReadonlyArray<Reached<ScheduleFeature>>,
	check: (_, c: Case<ScheduleFeature>) => (schedule) =>
		Effect.gen(function* () {
			const outcome = yield* actualOf(schedule)
			c.noteAll(scheduleFeatures(schedule, outcome))
			assert.deepEqual(outcome, expectedOf(schedule))
		}),
	oracle: {
		kind: "specification",
		name: "design D-AD7's retry policy: the server's delay waited unless it passes the timeout, the budget, the retried statuses"
	},
	kept: [],
	budget: { runs: 8, steered: 24 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original: "retriedStatuses.has(status) ? Option.some(String(status)) : Option.none()",
			replacement: "retriedStatuses.has(status) ? Option.none() : Option.some(String(status))",
			why: "A retried status is not retried and every other status is; the property fails (CATCH's evidence, mutant 2ac02a7ae1)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original:
				"timeoutSeconds !== 0 && Duration.isGreaterThan(delay, Duration.seconds(timeoutSeconds))",
			replacement: "Duration.isGreaterThan(delay, Duration.seconds(timeoutSeconds))",
			why: "`--timeout 0` no longer removes the cap, so every server delay is past it; the property fails (CATCH's evidence, mutant 5fa83cbb28)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original:
				"timeoutSeconds !== 0 && Duration.isGreaterThan(delay, Duration.seconds(timeoutSeconds))",
			replacement: "true",
			why: "Every server delay reads as past the timeout, so none is waited; the property fails (CATCH's evidence, mutant 69f9ae27a9)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/client.ts",
			original: "\tif (left === 0) {",
			replacement: "\tif (left !== 0) {",
			why: "The budget reads as spent while it holds and as left once spent; the property fails (CATCH's evidence, mutant c8a7c020cf)."
		}
	]
})
