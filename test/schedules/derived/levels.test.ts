/**
 * Levels: a call naming a level chain publishes every view it names in one commit.
 *
 * Property: every race of one db.refresh call meeting a raw refresher's lock, beside a reader that reads every view in
 * one statement, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the call, the holder's and the reader's transactions, each run alone from the
 * race's initial state in an order that respects real time, show what they showed in the run, the reader's rows of
 * every view at once, and leave its state, in which every view the call names is its definition over that state (the
 * refresh's own rule, which the system run alone does not judge: support.ts publishedOf). So a reader never sees one
 * view of a call refreshed and another not, nor a level refreshed from a level below it the call has not refreshed
 * yet. The races draw the views refreshed over one base and the base changed since, the view the holder holds and how
 * it ends, and the call, which names that view or a level above it, in an order of its own.
 *
 * The kept race is the window the race was first planted for: a call naming the whole chain, parked by the holder at
 * WeekBusy after it refreshed the levels below, while the reader reads.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { derivedRaceSuite } from "#test/schedules/derived/support.ts"

import { raceGen, raceAims } from "#test/schedules/derived/levels.fixtures.ts"

export const everyRaceOfALevelChainsRefreshAndAReaderOfEveryViewIsSerializable = derivedRaceSuite({
	space: aimed(raceGen, raceAims),
	required: ["a call waited", "reader committed"]
})
