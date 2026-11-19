/** What the properties of levels.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { constant, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	callGen,
	type DerivedFeature,
	type DerivedRace,
	endGen,
	heldGen,
	initialGen,
	initialSats,
	labelsGen,
	sat
} from "#test/schedules/derived/support.ts"

export const raceGen: Gen<DerivedRace> = (source) => {
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

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const raceCases: ReadonlyArray<{
	readonly why: string
	readonly value: DerivedRace
	readonly reaches: ReadonlyArray<DerivedFeature>
}> = [
	{
		why: "one commit: the call names WeekBusy, StudentTotal and StudentWeekly, and waits on the holder at WeekBusy after refreshing the level below, while the reader reads every view",
		value: {
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
		reaches: ["a read while a call waited", "reader committed"]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<DerivedFeature>, Gen<DerivedRace>]> =
	Arr.flatMap(raceCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
