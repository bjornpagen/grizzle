/** What the properties of base-writes.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, constant } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	callGen,
	changeGen,
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
		why: "a writer in a cycle: the call is parked between StudentWeekly and WeekBusy by the holder, the writer reads StudentWeekly and adds a sitting of student 5, which the call read; the writer commits first and the call retries with it",
		value: {
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
		reaches: ["a call waited", "refused: SerializationFailure", "writer committed"]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<DerivedFeature>, Gen<DerivedRace>]> =
	Arr.flatMap(raceCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
