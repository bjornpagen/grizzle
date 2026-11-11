/**
 * A fuzz run's corpus (explore.ts replayCorpus): replayed in the order it loads, every case that adds no situation the
 * cases replayed before it had not is dropped, and every other kept.
 *
 * Over drawn corpora, each an ordering of distinct values from a palette whose values note "sevens" (two of them),
 * "other", or nothing, the cases a one-case fuzz run leaves of the corpus are exactly the model's: a fold over the
 * corpus in its order, keeping a case exactly when it notes a situation no case before it noted. The search's floor
 * and its one fuzzed case draw from a range that holds the palette's values a few in a million times, so a case they
 * add is new and lies past the corpus's survivors.
 *
 * Oracle: the specification, that fold. Features: a case dropped for a situation seen before it, a case dropped that
 * notes nothing, a case kept, and a corpus kept whole.
 *
 * That a run that fuzzes another suite never reads the corpus is fuzz.test.ts's, beside its run as under test.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/corpus-keeps-every-case.patch (no replayed case dropped) turns the
 * property red.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import type { Corpus } from "#fuzz.ts"
import { int, shuffled } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { shortlex } from "#tape.ts"
import { runOfTest } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

type Found = "sevens" | "other"

/** What a case notes of each value of the palette: two values note the same thing, and two note nothing. */
const FOUND: ReadonlyMap<number, Found> = new Map([
	[777, "sevens"],
	[7777, "sevens"],
	[12_345, "other"]
])

/** The values a corpus is drawn from: those FOUND notes, and two that note nothing. */
const PALETTE: ReadonlyArray<number> = [777, 7777, 12_345, 5, 99]

/** Notes what `FOUND` says of the value, and passes. */
const noteFound = (value: number, c: Case<Found>) =>
	Effect.sync(() => {
		const found = FOUND.get(value)
		if (found !== undefined) {
			c.note(found)
		}
	})

/** One value of a range the palette's values are a few in a million of. */
const search = (suite: string): Exploration<number, number, Found> => ({
	suite,
	oracle: {
		kind: "specification",
		name: "a range planted so its cases rarely land on the palette's values"
	},
	draw: drawn(int(0, 1_000_000)),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency: 4,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** A corpus held in memory, starting from one tape of each value. */
const memoryCorpus = (values: ReadonlyArray<number>) => {
	const saved: Array<Float64Array> = Arr.map(values, (value) => Float64Array.of(value))
	const corpus: Corpus = {
		load: Effect.sync(() => [...saved]),
		save: (tape, length) =>
			Effect.sync(() => {
				saved.push(tape.slice(0, length))
			}),
		drop: (tape, length) =>
			Effect.sync(() =>
				Option.map(
					Arr.findFirstIndex(saved, (kept) => shortlex(kept, kept.length, tape, length) === 0),
					(at) => saved.splice(at, 1)
				)
			)
	}
	return { saved, corpus }
}

/** A fuzz run of `suite` in the test `ctx` runs, from this process's seed, for one case over `corpus`. */
const fuzzRun = (ctx: TestContext, suite: string, corpus: Corpus) =>
	Effect.map(runOfTest(ctx), (run) =>
		Run.of({
			...run,
			replay: Option.none(),
			fuzz: Option.some({ suite, budget: { kind: "cases", cases: 1 }, corpus })
		})
	)

/** The corpus's survivors by the specification: each case kept exactly when it notes what no case before it noted. */
const survivorsOf = (corpus: ReadonlyArray<number>): ReadonlyArray<number> =>
	Arr.reduce(
		corpus,
		{ seen: new Set<Found>(), kept: Arr.empty<number>() },
		({ seen, kept }, value) => {
			const found = FOUND.get(value)
			return found === undefined || seen.has(found)
				? { seen, kept }
				: { seen: new Set([...seen, found]), kept: [...kept, value] }
		}
	).kept

type Feature =
	| "a case dropped for a situation seen before"
	| "a case dropped that notes nothing"
	| "a case kept"
	| "a corpus kept whole"

describe("a fuzz run's corpus", () => {
	it.effect("drops each case that adds nothing the cases replayed before it did not", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "minimized corpora",
					oracle: {
						kind: "specification",
						name: "replayed in order, a case is kept exactly when it notes a situation no case before it noted"
					},
					draw: drawn(shuffled(PALETTE, { min: 0, max: PALETTE.length })),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a case dropped for a situation seen before",
							"a case dropped that notes nothing",
							"a case kept",
							"a corpus kept whole"
						],
						{ cases: 40, sense: notesOnly }
					),
					kept: [],
					runs: 40,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(values, c) =>
					Effect.gen(function* () {
						const survivors = survivorsOf(values)
						for (const value of values) {
							if (!Arr.contains(survivors, value)) {
								c.note(
									FOUND.has(value)
										? "a case dropped for a situation seen before"
										: "a case dropped that notes nothing"
								)
							}
						}
						if (Arr.isReadonlyArrayNonEmpty(survivors)) {
							c.note("a case kept")
						}
						if (survivors.length === values.length) {
							c.note("a corpus kept whole")
						}
						const { saved, corpus } = memoryCorpus(values)
						yield* explore(search("minimized corpus"), noteFound).pipe(
							Effect.provideServiceEffect(Run, fuzzRun(ctx, "minimized corpus", corpus))
						)
						deepStrictEqual(
							Arr.map(Arr.take(saved, survivors.length), (tape) => Arr.fromIterable(tape)),
							Arr.map(survivors, (value) => [value])
						)
					})
			)
		)
	)
})
