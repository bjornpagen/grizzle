/**
 * Refresh under concurrent base writes: every race of a db.refresh call and a direct writer of the base, meeting a raw
 * refresher's lock, is serializable.
 *
 * db.refresh runs one transaction, so every level's definition reads one snapshot of the base and a higher level reads
 * the lower levels as the call just refreshed them. A raw `holder` refresher holds one view's lock, so a call can be
 * parked between its levels while a base write commits; a writer that read StudentWeekly before the call's commit and
 * wrote a sitting the call's definition read is the other half of a cycle, which SERIALIZABLE breaks.
 *
 * Property: every run, in every order of the race's moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the call, the holder's and the writer's transactions, each run alone from the
 * race's initial state in an order that respects real time, show what they showed in the run (the writer's read of
 * StudentWeekly row for row) and leave its state, the base and every view. The races draw the views populated or not,
 * the base changed since, the view the holder holds and how it ends, the call, which names that view or a level above
 * it, and the writer's read (over populated views) and change.
 *
 * The kept race is the window the race was first planted for: the call parked between StudentWeekly and WeekBusy by
 * the holder, while a writer reads StudentWeekly and adds a sitting of a student the call read.
 */

import { aimed } from "@bjornpagen/testing/gen"
import { derivedRaceSuite } from "#test/schedules/derived/support.ts"

import { raceGen, raceAims } from "#test/schedules/derived/base-writes.fixtures.ts"

export const everyRaceOfARefreshAndABaseWriterMeetingARawRefresherIsSerializable = derivedRaceSuite(
	{
		space: aimed(raceGen, raceAims),
		required: ["a call waited", "writer committed"]
	}
)
