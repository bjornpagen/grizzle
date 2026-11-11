import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { type Coverage, required } from "#features.ts"
import { array, type Gen, int } from "#gen.ts"
import { floorSeed, rotatingSeed } from "#random.ts"
import { notesOnly, type Sense, v8Coverage } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { runOfTest } from "#vitest/run.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

type Matched = `${0 | 1 | 2 | 3 | 4 | 5} matched`

const MATCHED: ReadonlyArray<Matched> = [
	"0 matched",
	"1 matched",
	"2 matched",
	"3 matched",
	"4 matched",
	"5 matched"
]

/** Six values of 0..31: drawn at random, they begin with all five magic values once in 33 million cases. */
const values: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** How many magic values a case begins with. */
const matchedOf = (drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < MAGIC.length && drawnValues[matched] === MAGIC[matched]) {
		matched += 1
	}
	return matched
}

/** The run of the test `ctx` runs, never replaying or fuzzing: the steered and unsteered searches draw from its seed. */
const runIn = (ctx: TestContext) =>
	Effect.map(runOfTest(ctx), (testRun) =>
		Run.of({ ...testRun, replay: Option.none(), fuzz: Option.none() })
	)

/** A search that must reach what its coverage requires, from six values of 0..31. */
const magicSearch = <F extends string>(
	suite: string,
	coverage: Coverage<F>,
	concurrency: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, F> => ({
	suite,
	draw: drawn(values),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Notes how many magic values the case begins with: each new count is a step a steered search climbs from. */
const noteMatched = (drawnValues: ReadonlyArray<number>, c: Case<Matched>) =>
	Effect.sync(() => c.note(Arr.getUnsafe(MATCHED, matchedOf(drawnValues))))

/**
 * Six values of 0..31 for a lock with five nested branches: drawn at random, they open it once in 33 million cases, so
 * a search that does not perceive the branches never opens it within its budget, whatever the run's seed.
 */
const lockValues: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** Opens only on all five magic values, one nested branch per value, and notes nothing on the way. */
const opens = (drawnValues: ReadonlyArray<number>): boolean => {
	if (drawnValues[0] === MAGIC[0]) {
		if (drawnValues[1] === MAGIC[1]) {
			if (drawnValues[2] === MAGIC[2]) {
				if (drawnValues[3] === MAGIC[3]) {
					if (drawnValues[4] === MAGIC[4]) {
						return true
					}
				}
			}
		}
	}
	return false
}

/** A search for the lock's opening, steered by `sense` for up to `cases` cases, one case at a time. */
const lockSearch = (
	suite: string,
	sense: Sense,
	cases: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, "opened"> => ({
	...magicSearch(suite, required<"opened">(["opened"], { cases, sense }), 1),
	draw: drawn(lockValues)
})

/** Notes only the opening. */
const noteOpened = (drawnValues: ReadonlyArray<number>, c: Case<"opened">) =>
	Effect.sync(() => {
		if (opens(drawnValues)) {
			c.note("opened")
		}
	})

/** Five magic values matched, the situation only a steered search reaches, with a steered budget of `cases`. */
const fiveMatched = (cases: number) => required<Matched>(["5 matched"], { cases, sense: notesOnly })

/** Orders witnesses' values lexicographically, so two runs' witnesses compare as multisets. */
const byValues = Arr.makeOrder(Order.Number)

describe("a steered search", () => {
	it.effect("climbs to a situation random search never reaches, one new note at a time", (ctx) =>
		Effect.gen(function* () {
			const unsteered = yield* Effect.flip(
				explore(magicSearch("unsteered", fiveMatched(0), 4), noteMatched)
			)
			strictEqual(unsteered._tag, "FeaturesUnreached")
			const steered = yield* explore(magicSearch("steered", fiveMatched(50_000), 4), noteMatched)
			strictEqual(steered.residual.cases, 100)
		}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)

	it.effect(
		"finds the same witnesses, floor and steered, however many run at once and whatever the run's seed",
		(ctx) =>
			Effect.gen(function* () {
				const processRun = yield* runIn(ctx)
				const seeds = [processRun.seed, rotatingSeed(processRun.seed, floorSeed("another run"))]
				const searches = yield* Effect.forEach(
					Arr.flatMap(seeds, (seed) =>
						Arr.map([1, 4, 16], (concurrency) => [seed, concurrency] as const)
					),
					([seed, concurrency]) =>
						Effect.suspend(() => {
							const witnesses: Array<ReadonlyArray<number>> = []
							return explore(
								magicSearch("steered at any concurrency", fiveMatched(50_000), concurrency),
								(drawnValues, c) =>
									Effect.andThen(
										Effect.sync(() => {
											if (Option.isSome(c.steering)) {
												witnesses.push(drawnValues)
											}
										}),
										noteMatched(drawnValues, c)
									)
							).pipe(
								Effect.map(
									(explored) => [explored.steered, Arr.sort(witnesses, byValues)] as const
								),
								Effect.provideService(Run, Run.of({ ...processRun, seed }))
							)
						})
				)
				const [first, ...rest] = searches
				for (const search of rest) {
					deepStrictEqual(search, first)
				}
			}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)

	it.effect(
		"climbs through branches it perceives in V8's block coverage, with no note on the way",
		(ctx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const sense = yield* v8Coverage(Str.endsWith("/steer.test.ts"))
					const blind = yield* Effect.flip(
						explore(lockSearch("blind", notesOnly, 1000), noteOpened)
					)
					strictEqual(blind._tag, "FeaturesUnreached")
					yield* explore(lockSearch("coverage", sense, 100_000), noteOpened)
				}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
			),
		0
	)
})
