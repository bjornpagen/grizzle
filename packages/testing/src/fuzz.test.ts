/**
 * A fuzz run (explore.ts under Run.fuzz, fuzz.ts), against what it promises:
 *
 * - It finds a failure the test streams never reach and keeps it: a lock planted to open on five magic values, which
 *   random search opens once in 33 million cases, opens within the run's budget by climbing the counts it notes, and
 *   a second run over the corpus it kept fails again at once. A capability of the search, its lock the plant.
 * - It leaves every other suite as under test: over drawn searches, a suite another suite's fuzz run passes over
 *   explores exactly as the same run under test does, and never reads or writes the corpus. Oracle: a differential.
 * - A fuzz time reads as Go's -fuzztime does: every count of 1 to 3 in each unit. Oracle: the specification, Go's
 *   grammar.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): fuzz-blind.patch (a fuzz run perceiving no note) turns the first
 * property red; fuzz-every-suite.patch (a fuzz run fuzzing whatever suite it meets) the second; fuzz-time-seconds.patch
 * (every unit read as seconds) the third.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, exhaust, explore, Run } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { budgetOf, type Corpus } from "#fuzz.ts"
import { array, element, type Gen, int } from "#gen.ts"
import { completeShrink } from "#shrink.ts"
import { shortlex } from "#tape.ts"
import { runOfTest } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

/** Six values of 0..31: drawn at random, they begin with all five magic values once in 33 million cases. */
const values: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

const matchedOf = (drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < MAGIC.length && drawnValues[matched] === MAGIC[matched]) {
		matched += 1
	}
	return matched
}

/** Fails on the magic values, and notes each count of them a case begins with, so a fuzz run climbs. */
const lock = (drawnValues: ReadonlyArray<number>, c: Case<`${number} matched`>) =>
	Effect.gen(function* () {
		const matched = matchedOf(drawnValues)
		c.note(`${matched} matched`)
		if (matched === MAGIC.length) {
			return yield* Effect.die("opened")
		}
	})

const search = (
	suite: string
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, `${number} matched`> => ({
	suite,
	oracle: {
		kind: "specification",
		name: "a lock planted to open on its magic values, for the fuzz run to find"
	},
	draw: drawn(values),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency: 4,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Each unit of a fuzz time, as the duration it measures. */
const UNITS = {
	ms: Duration.millis,
	s: Duration.seconds,
	m: Duration.minutes,
	h: Duration.hours
} as const

/** A corpus held in memory, for a test of what a fuzz run keeps. */
const memoryCorpus = () => {
	const saved: Array<Float64Array> = []
	const corpus: Corpus = {
		load: Effect.sync(() => [...saved]),
		save: (tapeValues, length) =>
			Effect.sync(() => {
				saved.push(tapeValues.slice(0, length))
			}),
		drop: (tapeValues, length) =>
			Effect.sync(() =>
				Option.map(
					Arr.findFirstIndex(
						saved,
						(kept) => shortlex(kept, kept.length, tapeValues, length) === 0
					),
					(at) => saved.splice(at, 1)
				)
			)
	}
	return { saved, corpus }
}

/** A fuzz run of `suite` in the test `ctx` runs, from this process's seed, for `cases` cases over `corpus`. */
const fuzzRun = (ctx: TestContext, suite: string, corpus: Corpus, cases: number) =>
	Effect.map(runOfTest(ctx), (run) =>
		Run.of({
			...run,
			replay: Option.none(),
			fuzz: Option.some({ suite, budget: { kind: "cases", cases }, corpus })
		})
	)

describe("a fuzz run", () => {
	it.effect("finds a failure the test streams never reach, and keeps it in its corpus", (ctx) =>
		Effect.gen(function* () {
			const { saved, corpus } = memoryCorpus()
			const failure = yield* Effect.flip(
				explore(search("lock"), lock).pipe(
					Effect.provideServiceEffect(Run, fuzzRun(ctx, "lock", corpus, 200_000))
				)
			)
			strictEqual(failure._tag, "PropertyFalsified")
			const seeds = saved.length
			const again = yield* Effect.flip(
				explore(search("lock"), lock).pipe(
					Effect.provideServiceEffect(Run, fuzzRun(ctx, "lock", corpus, 1))
				)
			)
			deepStrictEqual(
				[again._tag, saved.length > 1, saved.length >= seeds],
				["PropertyFalsified", true, true]
			)
		})
	)

	it.effect(
		"leaves every other suite to run as under test, its corpus never read or written",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unfuzzed suites",
						oracle: {
							kind: "universal",
							name: "a differential: a suite another suite's fuzz run passes over explores as the same run under test does"
						},
						draw: drawn((source) => ({
							runs: source.draw(int(0, 120)),
							concurrency: source.draw(int(1, 4)),
							cases: source.draw(int(1, 1000))
						})),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					({ runs, concurrency, cases }) =>
						Effect.gen(function* () {
							const untouched: Corpus = {
								load: Effect.die("the corpus was read"),
								save: () => Effect.die("the corpus was written"),
								drop: () => Effect.die("the corpus was written")
							}
							const property = (drawnValues: ReadonlyArray<number>, c: Case<`${number} matched`>) =>
								Effect.sync(() => c.note(`${matchedOf(drawnValues)} matched`))
							const unfuzzed = { ...search("unfuzzed"), runs, concurrency }
							const passedOver = yield* explore(unfuzzed, property).pipe(
								Effect.provideServiceEffect(Run, fuzzRun(ctx, "lock", untouched, cases))
							)
							const underTest = yield* explore(unfuzzed, property).pipe(
								Effect.provideServiceEffect(
									Run,
									Effect.map(runOfTest(ctx), (run) =>
										Run.of({ ...run, replay: Option.none(), fuzz: Option.none() })
									)
								)
							)
							deepStrictEqual(passedOver, underTest)
						})
				)
			)
	)

	it.effect("reads a fuzz time as Go's -fuzztime does", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "fuzz times",
					oracle: {
						kind: "specification",
						name: "Go's -fuzztime grammar: a whole count of cases, milliseconds, seconds, minutes or hours"
					},
					box: "every count of 1 to 3 in each unit",
					generator: (source) =>
						[
							source.draw(int(1, 3)),
							source.draw(element(["x", "ms", "s", "m", "h"] as const))
						] as const,
					literal: Formatter.format,
					limit: 100,
					coverage: noCoverage,
					caseHang: Duration.minutes(1)
				},
				([count, unit]) =>
					Effect.sync(() =>
						deepStrictEqual(
							budgetOf(`${count}${unit}`),
							unit === "x"
								? { kind: "cases", cases: count }
								: { kind: "time", duration: UNITS[unit](count) }
						)
					)
			)
		)
	)
})
