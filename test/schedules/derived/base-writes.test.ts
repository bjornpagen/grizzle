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
 *
 * Plants (main's test phase): derived-refresh-level-order.patch.
 */

import { boolean, type Gen } from "@bjornpagen/testing/gen"
import {
	callGen,
	changeGen,
	type DerivedRace,
	derivedRaceSuite,
	endGen,
	heldGen,
	initialGen,
	initialSats,
	labelsGen,
	sat
} from "#test/schedules/derived/support.ts"

const raceGen: Gen<DerivedRace> = (source) => {
	const initial = source.draw(initialGen(boolean))
	const view = source.draw(heldGen(initial))
	return {
		labels: source.draw(labelsGen),
		initial,
		holder: { kind: "holds", view, end: source.draw(endGen) },
		calls: [source.draw(callGen(view, initial))],
		writer: {
			kind: "writes",
			reads: initial.kind === "populated" && source.draw(boolean),
			change: source.draw(changeGen(initial.stored))
		},
		reader: false
	}
}

derivedRaceSuite({
	file: "db.refresh under concurrent base writes",
	test: "every race of a refresh and a base writer meeting a raw refresher is serializable",
	suite: "schedules/derived/base-writes",
	draw: raceGen,
	required: ["a call waited", "writer committed"],
	kept: [
		{
			note: "a writer in a cycle: the call is parked between StudentWeekly and WeekBusy by the holder, the writer reads StudentWeekly and adds a sitting of student 5, which the call read; the writer commits first and the call retries with it",
			sketch: {
				labels: { student: 0, sitting: 0, week: 0 },
				initial: {
					kind: "populated",
					viewed: initialSats,
					stored: [...initialSats, sat(30, 5, 4, true)]
				},
				holder: { kind: "holds", view: "WeekBusy", end: "rollback" },
				calls: [["StudentWeekly", "WeekBusy"]],
				writer: {
					kind: "writes",
					reads: true,
					change: { kind: "add", sats: [sat(31, 5, 4, false)] }
				},
				reader: false
			},
			draws: "",
			reaches: ["a call waited", "refused: SerializationFailure", "writer committed"]
		}
	]
})
