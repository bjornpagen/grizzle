/** What the properties of refreshers.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { boolean, type Gen, constant } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import {
	type Call,
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
	const calls: readonly [Call, Call] = [
		source.draw(callGen(view, initial)),
		source.draw(callGen(view, initial))
	]
	return {
		labels: source.draw(labelsGen),
		initial,
		holder: { kind: "holds", view, end: source.draw(endGen) },
		calls,
		writer: source.draw(boolean)
			? { kind: "writes", reads: false, change: source.draw(changeGen(initial.stored)) }
			: { kind: "none" },
		reader: false
	}
}

const labels = Object.freeze({ student: 0, sitting: 0, week: 0 })

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
		why: "diffs touching the same row: student 1's week 1 changes after the views and again while both calls wait on the holder's committed refresh, so each later diff replaces the row the holder replaced",
		value: {
			labels,
			initial: {
				kind: "populated",
				viewed: initialSats,
				stored: [...initialSats, sat(5, 1, 1, true)]
			},
			holder: { kind: "holds", view: "StudentWeekly", end: "commit" },
			calls: [["StudentWeekly"], ["StudentWeekly"]],
			writer: {
				kind: "writes",
				reads: false,
				change: { kind: "add", sats: [sat(6, 1, 1, false)] }
			},
			reader: false
		},
		reaches: ["two calls in flight together", "refused: SerializationFailure", "holder committed"]
	},
	{
		why: "a key the holder inserted: new students only, so every diff is insertions and each later one inserts a key already committed, a 40001 and never a 23505",
		value: {
			labels,
			initial: {
				kind: "populated",
				viewed: initialSats,
				stored: [...initialSats, sat(6, 6, 1, true)]
			},
			holder: { kind: "holds", view: "StudentTotal", end: "commit" },
			calls: [["StudentTotal"], ["StudentTotal"]],
			writer: {
				kind: "writes",
				reads: false,
				change: { kind: "add", sats: [sat(7, 7, 1, true)] }
			},
			reader: false
		},
		reaches: ["two calls in flight together", "refused: SerializationFailure", "holder committed"]
	},
	{
		why: "diffs touching different rows: student 1's sitting 2 is dropped and sat again, so its total is back where the view has it, and student 9 appears; the call waiting on the holder is the pivot",
		value: {
			labels,
			initial: {
				kind: "populated",
				viewed: initialSats,
				stored: [sat(1, 1, 1, true), sat(3, 1, 2, true), sat(4, 2, 1, true)]
			},
			holder: { kind: "holds", view: "StudentWeekly", end: "rollback" },
			calls: [["StudentTotal", "StudentWeekly"], ["StudentTotal"]],
			writer: {
				kind: "writes",
				reads: false,
				change: { kind: "add", sats: [sat(2, 1, 1, false), sat(13, 9, 1, true)] }
			},
			reader: false
		},
		reaches: ["a call waited", "refused: SerializationFailure", "holder rolled back"]
	},
	{
		why: "the first population: both calls read the views unpopulated and take the plain form, so each meets the other's population at the rewrite check",
		value: {
			labels,
			initial: { kind: "unpopulated", stored: initialSats },
			holder: { kind: "holds", view: "StudentTotal", end: "commit" },
			calls: [["StudentTotal"], ["StudentTotal"]],
			writer: {
				kind: "writes",
				reads: false,
				change: { kind: "add", sats: [sat(8, 8, 1, true)] }
			},
			reader: false
		},
		reaches: ["two calls in flight together", "refused: ConcurrentRefresh"]
	},
	{
		why: "first populations in the other order: the call whose snapshot is older commits last, and meets the other's population at the rewrite check rather than overwriting it with an older state",
		value: {
			labels,
			initial: { kind: "unpopulated", stored: initialSats },
			holder: { kind: "holds", view: "StudentWeekly", end: "rollback" },
			calls: [["StudentWeekly", "StudentTotal"], ["StudentTotal"]],
			writer: {
				kind: "writes",
				reads: false,
				change: { kind: "add", sats: [sat(8, 8, 1, true)] }
			},
			reader: false
		},
		reaches: ["a call waited", "refused: ConcurrentRefresh"]
	}
]

/** The property's aims (race): each kept case's value at every situation it reaches. */
export const raceAims: ReadonlyArray<readonly [Reached<DerivedFeature>, Gen<DerivedRace>]> =
	Arr.flatMap(raceCases, (c) =>
		Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
	)
