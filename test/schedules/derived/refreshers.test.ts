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
 *
 * Plants (main's test phase): derived-refreshers-rewrite-check-off.patch.
 */

import { boolean, type Gen } from "@grizzle/testing/gen"
import {
	type Call,
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

derivedRaceSuite({
	file: "two concurrent refreshers of one relation",
	test: "every race of two refreshers meeting a raw refresher, beside a base writer, is serializable and every call answers",
	suite: "schedules/derived/refreshers",
	draw: raceGen,
	required: ["a call waited", "two calls in flight together"],
	kept: [
		{
			note: "diffs touching the same row: student 1's week 1 changes after the views and again while both calls wait on the holder's committed refresh, so each later diff replaces the row the holder replaced",
			sketch: {
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
			draws: "",
			reaches: ["two calls in flight together", "refused: SerializationFailure", "holder committed"]
		},
		{
			note: "a key the holder inserted: new students only, so every diff is insertions and each later one inserts a key already committed, a 40001 and never a 23505",
			sketch: {
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
			draws: "",
			reaches: ["two calls in flight together", "refused: SerializationFailure", "holder committed"]
		},
		{
			note: "diffs touching different rows: student 1's sitting 2 is dropped and sat again, so its total is back where the view has it, and student 9 appears; the call waiting on the holder is the pivot",
			sketch: {
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
			draws: "",
			reaches: ["a call waited", "refused: SerializationFailure", "holder rolled back"]
		},
		{
			note: "the first population: both calls read the views unpopulated and take the plain form, so each meets the other's population at the rewrite check",
			sketch: {
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
			draws: "",
			reaches: ["two calls in flight together", "refused: ConcurrentRefresh"]
		},
		{
			note: "first populations in the other order: the call whose snapshot is older commits last, and meets the other's population at the rewrite check rather than overwriting it with an older state",
			sketch: {
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
			draws: "",
			reaches: ["a call waited", "refused: ConcurrentRefresh"]
		}
	]
})
