/**
 * Levels: a call naming a level chain publishes every view it names in one commit.
 *
 * Property: every race of one db.refresh call meeting a raw refresher's lock, beside a reader that reads every view in
 * one statement, in every order of its moves, is explained by its serial reference
 * (test/support/schedules/serial.ts): the call, the holder's and the reader's transactions, each run alone from the
 * race's initial state in an order that respects real time, show what they showed in the run, the reader's rows of
 * every view at once, and leave its state. So a reader never sees one view of a call refreshed and another not. The
 * races draw the views refreshed over one base and the base changed since, the view the holder holds and how it ends,
 * and the call, which names that view or a level above it.
 *
 * The kept race is the window the race was first planted for: a call naming the whole chain, parked by the holder at
 * WeekBusy after it refreshed the levels below, while the reader reads.
 *
 * Plants (main's test phase): derived-refresh-level-order.patch.
 */

import { constant, type Gen } from "@bjornpagen/testing/gen"
import {
	callGen,
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
	const initial = source.draw(initialGen(constant(true)))
	const view = source.draw(heldGen(initial))
	return {
		labels: source.draw(labelsGen),
		initial,
		holder: { kind: "holds", view, end: source.draw(endGen) },
		calls: [source.draw(callGen(view, initial))],
		writer: { kind: "none" },
		reader: true
	}
}

derivedRaceSuite({
	file: "db.refresh across levels",
	test: "every race of a level chain's refresh and a reader of every view is serializable",
	suite: "schedules/derived/levels",
	draw: raceGen,
	required: ["a call waited", "reader committed"],
	kept: [
		{
			note: "one commit: the call names WeekBusy, StudentTotal and StudentWeekly, and waits on the holder at WeekBusy after refreshing the level below, while the reader reads every view",
			sketch: {
				labels: { student: 0, sitting: 0, week: 0 },
				initial: {
					kind: "populated",
					viewed: initialSats,
					stored: [...initialSats, sat(40, 6, 7, true)]
				},
				holder: { kind: "holds", view: "WeekBusy", end: "rollback" },
				calls: [["WeekBusy", "StudentTotal", "StudentWeekly"]],
				writer: { kind: "none" },
				reader: true
			},
			draws: "",
			reaches: ["a read while a call waited", "reader committed"]
		}
	]
})
