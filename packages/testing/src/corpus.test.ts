import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { noFeatures } from "#features.ts"
import type { Corpus } from "#fuzz.ts"
import { int } from "#gen.ts"
import { completeShrink } from "#shrink.ts"
import { shortlex } from "#tape.ts"
import { runOfProcess } from "#vitest/run.ts"

type Found = "sevens" | "other"

/** The values a case notes, and what it notes for each: two values note the same thing. */
const FOUND: ReadonlyMap<number, Found> = new Map([
	[777, "sevens"],
	[7777, "sevens"],
	[12_345, "other"]
])

/** Notes what `FOUND` says of the value, and passes. */
const noteFound = (value: number, c: Case<Found>) =>
	Effect.sync(() => {
		const found = FOUND.get(value)
		if (found !== undefined) {
			c.note(found)
		}
	})

/** One value of a range the floor stream never lands on any of `FOUND`'s values in. */
const search = (suite: string): Exploration<number, number, Found> => ({
	suite,
	draw: drawn(int(0, 1_000_000)),
	literal: Formatter.format,
	features: noFeatures,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency: 4,
	steerEvery: 16,
	steering: { kind: "none" },
	caseHang: Duration.minutes(1)
})

/** A corpus held in memory, starting from `tapes`. */
const memoryCorpus = (tapes: ReadonlyArray<ReadonlyArray<number>>) => {
	const saved: Array<Float64Array> = Arr.map(tapes, (tape) => Float64Array.from(tape))
	const corpus: Corpus = {
		load: Effect.sync(() => [...saved]),
		save: (values, length) =>
			Effect.sync(() => {
				saved.push(values.slice(0, length))
			}),
		drop: (values, length) =>
			Effect.sync(() =>
				Option.map(
					Arr.findFirstIndex(saved, (kept) => shortlex(kept, kept.length, values, length) === 0),
					(at) => saved.splice(at, 1)
				)
			)
	}
	return { saved, corpus }
}

/** A fuzz run of `suite` from this process's seed, for one window of cases over `corpus`. */
const fuzzRun = (suite: string, corpus: Corpus) =>
	Effect.map(runOfProcess, (run) =>
		Run.of({
			...run,
			replay: Option.none(),
			fuzz: Option.some({ suite, budget: { kind: "cases", cases: 1 }, corpus })
		})
	)

describe("a fuzz run's corpus", () => {
	it.effect("drops each case that adds nothing the cases replayed before it did not", () =>
		Effect.gen(function* () {
			const { saved, corpus } = memoryCorpus([[777], [7777], [12_345]])
			yield* explore(search("minimized corpus"), noteFound).pipe(
				Effect.provideServiceEffect(Run, fuzzRun("minimized corpus", corpus))
			)
			deepStrictEqual(
				Arr.map(saved, (values) => Arr.fromIterable(values)),
				[[777], [12_345]]
			)
		})
	)

	it.effect("is never read by a suite the run does not fuzz", () =>
		Effect.gen(function* () {
			const unread: Corpus = {
				load: Effect.die("the corpus was read"),
				save: () => Effect.die("the corpus was written"),
				drop: () => Effect.die("the corpus was written")
			}
			const explored = yield* explore(search("unfuzzed"), noteFound).pipe(
				Effect.provideServiceEffect(Run, fuzzRun("another suite", unread))
			)
			strictEqual(explored.cases, 125)
		})
	)
})
