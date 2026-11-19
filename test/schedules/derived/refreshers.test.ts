/**
 * Two concurrent refreshers of one relation: every race of two db.refresh calls meeting a raw refresher's lock, beside
 * a base writer, is serializable, and every call answers once its caller retries its TransientFailures.
 *
 * "Two refreshers without one [a lease] are correct and merely repeat work." A raw transaction of the role `holder`,
 * as another db.refresh would be, refreshes a view and holds its lock, so the grizzle refreshers that meet it wait
 * with snapshots taken before they waited, and a base write may commit meanwhile.
 *
 * Property: every run, in every order of the race's moves (a larger race in a drawn PCT order), is explained by its
 * serial reference (test/support/schedules/serial.ts): the calls, the raw refresher's and the writer's transactions,
 * each run alone from the race's initial state in an order that respects real time, show what they showed in the run
 * and leave its state, the base and every view, its rows or its being unpopulated. So no call fails for a conflict
 * with another refresher (a key the other inserted is 40001, never 23505), and no refresher whose snapshot is older
 * overwrites a newer population. The races draw the views populated or not, the base changed since, the view the
 * holder holds and how it ends, the two calls, each naming that view, and the writer's change.
 *
 * The kept races are the windows the races were first planted for: diffs touching the same row, a key the holder
 * inserted, diffs touching different rows (the waiter the pivot), and two first populations in each order of their
 * snapshots, which meet each other at the rewrite check.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { derivedRaceSuite } from "#test/schedules/derived/support.ts"

import { raceGen, raceAims } from "#test/schedules/derived/refreshers.fixtures.ts"

export const everyRaceOfTwoRefreshersMeetingARawRefresherBesideABaseWriterIsSerializableAndEveryCallAnswers =
	derivedRaceSuite({
		space: aimed(raceGen, raceAims),
		required: ["a call waited", "two calls in flight together"]
	})
