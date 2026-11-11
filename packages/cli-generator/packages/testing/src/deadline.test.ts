import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, String as Str } from "effect"
import {
	type DeadlineReached,
	drawn,
	type Exploration,
	explore,
	noDeadline,
	PRINT_MARGIN_MILLIS,
	type PropertyFalsified,
	Run,
	type SearchFailure
} from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { array, int } from "#gen.ts"
import { floorSeed, rotatingSeed } from "#random.ts"
import { type ReplayCase, replayTokenOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { forcedChooser, generate, recorder, sample } from "#source.ts"
import { runOfProcess } from "#vitest/run.ts"
import { searched } from "#vitest/searched.ts"

/** The values a cut search draws: wide, so its shrink has far to go. */
const values = int(0, 2 ** 20)

/**
 * The timeout of a test whose deadline cuts its search: twice the print margin, so the search has as long to work as its
 * report has to print. Before the cut it runs at most ten cases and four candidates of a property that does no work,
 * less than one report, which the margin is measured to cover.
 *
 * @limitKind derived
 * @owner the choice-stream testing library's own suite
 * @unit milliseconds
 * @scope the Vitest timeout of each test here whose search its deadline cuts
 * @derivation PRINT_MARGIN_MILLIS for the report, and as long again for the work before the cut
 */
const CUT_TIMEOUT = 2 * PRINT_MARGIN_MILLIS

/** A search of `values` that shrinks until it is done, running `concurrency` cases at once in windows of `steerEvery`. */
const cutSearch = (
	suite: string,
	concurrency: number,
	steerEvery: number
): Exploration<number, number, never> => ({
	suite,
	draw: drawn(values),
	literal: String,
	coverage: noCoverage,
	kept: [],
	runs: 40,
	shrink: completeShrink,
	concurrency,
	steerEvery,
	caseHang: Duration.minutes(1)
})

/** The run's draw of a count of 1 to 4 for `suite`: new every run, the same in every process of one, never a fixed seed. */
const countOfRun = (suite: string) =>
	Effect.map(runOfProcess, (run) =>
		Arr.getUnsafe(sample(int(1, 4), rotatingSeed(run.seed, floorSeed(suite)), 1), 0)
	)

/** The value a replay token's case draws. */
const valueOf = (replayed: ReplayCase): number =>
	generate(
		recorder(),
		values,
		forcedChooser(Float64Array.from(replayed.values), replayed.values.length)
	).value

const falsifiedOf = (failure: SearchFailure): Option.Option<PropertyFalsified> =>
	failure._tag === "PropertyFalsified" ? Option.some(failure) : Option.none()

const reachedOf = (failure: SearchFailure): Option.Option<DeadlineReached> =>
	failure._tag === "DeadlineReached" ? Option.some(failure) : Option.none()

/** Which of `lines` a report prints, the replay line of its case included. */
const printed = (
	suite: string,
	failure: PropertyFalsified | DeadlineReached,
	lines: ReadonlyArray<string>
) =>
	Arr.map(
		[
			...lines,
			...Option.match(failure.replay, {
				onNone: () => ["replay it alone"],
				onSome: (replayed) => [`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayed)}'`]
			})
		],
		(line) => Str.includes(line)(failure.message)
	)

/** The items a search given time draws. */
const items = array(int(0, 1000), { min: 0, max: 8 })

/** A search of `items` that shrinks until it is done. */
const timedSearch: Exploration<ReadonlyArray<number>, ReadonlyArray<number>, never> = {
	suite: "the search given time",
	draw: drawn(items),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: 40,
	shrink: completeShrink,
	concurrency: 4,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
}

/** A failure of the search given time, as two runs of it compare: where its case was drawn, how far it was shrunk, and
 * the items its token's case draws. */
type Shrunk = Readonly<{
	phase: PropertyFalsified["phase"]
	shrink: PropertyFalsified["shrink"]
	items: Option.Option<ReadonlyArray<number>>
}>

const shrunkOf = (falsified: PropertyFalsified): Shrunk => ({
	phase: falsified.phase,
	shrink: falsified.shrink,
	items: Option.map(
		falsified.replay,
		(replayed) =>
			generate(
				recorder(),
				items,
				forcedChooser(Float64Array.from(replayed.values), replayed.values.length)
			).value
	)
})

describe("a search under its test's deadline", () => {
	it.effect(
		"reports the smallest failing case its shrink reached when the deadline cuts the shrink short",
		(ctx) =>
			Effect.gen(function* () {
				const suite = "a shrink its deadline cuts"
				const patience = yield* countOfRun(suite)
				const failures: Array<number> = []
				let candidates = 0
				const failed = yield* Effect.flip(
					searched(
						ctx,
						explore(cutSearch(suite, 1, 1), (value) =>
							Effect.suspend(() => {
								if (Arr.isReadonlyArrayNonEmpty(failures)) {
									candidates += 1
									if (candidates === patience) {
										return Effect.never
									}
								}
								if (value === 0) {
									return Effect.void
								}
								failures.push(value)
								return Effect.die("falsified")
							})
						)
					)
				)
				strictEqual(failed._tag, "PropertyFalsified", failed.message)
				const smallest = yield* Option.match(Arr.last(failures), {
					onNone: () => Effect.die("the property never failed"),
					onSome: Effect.succeed
				})
				deepStrictEqual(
					Option.map(falsifiedOf(failed), (falsified) => ({
						shrink: falsified.shrink,
						value: Option.map(falsified.replay, valueOf),
						printed: printed(suite, falsified, [
							`counterexample: ${smallest}`,
							"cut short by its test's deadline",
							`keep it: { note: "…", sketch: ${smallest}`
						])
					})),
					Option.some({
						shrink: "deadline",
						value: Option.some(smallest),
						printed: [true, true, true, true]
					})
				)
			}),
		CUT_TIMEOUT
	)

	it.effect(
		"reports the case in flight when the deadline cuts the search short before any case failed",
		(ctx) =>
			Effect.gen(function* () {
				const suite = "a search its deadline cuts"
				const hangsAt = yield* countOfRun(suite)
				const seen: Array<number> = []
				const failed = yield* Effect.flip(
					searched(
						ctx,
						explore(cutSearch(suite, 1, 16), (value) =>
							Effect.suspend(() => {
								seen.push(value)
								return seen.length === hangsAt ? Effect.never : Effect.void
							})
						)
					)
				)
				strictEqual(failed._tag, "DeadlineReached", failed.message)
				const inFlight = yield* Option.match(Arr.get(seen, hangsAt - 1), {
					onNone: () => Effect.die("the property never hung"),
					onSome: Effect.succeed
				})
				deepStrictEqual(
					Option.map(reachedOf(failed), (reached) => ({
						value: Option.map(reached.replay, valueOf),
						ran: seen.length,
						printed: printed(suite, reached, [`the case in flight: ${inFlight}`])
					})),
					Option.some({ value: Option.some(inFlight), ran: hangsAt, printed: [true, true] })
				)
			}),
		CUT_TIMEOUT
	)

	it.effect(
		"reports a case that failed before the deadline, though a lower case of its window was still in flight",
		(ctx) =>
			Effect.gen(function* () {
				const suite = "a failure behind a cut"
				const floor = sample(values, floorSeed(suite), 2)
				const failed = yield* Effect.flip(
					searched(
						ctx,
						explore(cutSearch(suite, 4, 16), (value) => {
							if (Option.contains(Arr.get(floor, 0), value)) {
								return Effect.never
							}
							return Option.contains(Arr.get(floor, 1), value)
								? Effect.die("falsified")
								: Effect.void
						})
					)
				)
				strictEqual(failed._tag, "PropertyFalsified", failed.message)
				deepStrictEqual(
					Option.map(falsifiedOf(failed), (falsified) => ({
						phase: falsified.phase,
						shrink: falsified.shrink,
						value: Option.map(falsified.replay, valueOf)
					})),
					Option.some({ phase: "floor", shrink: "deadline", value: Arr.get(floor, 1) })
				)
			}),
		CUT_TIMEOUT
	)

	it.effect(
		"shrinks a failure to its smallest case when the deadline leaves the time, as it would with no deadline",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "a deadline with time to spare",
						draw: drawn(int(1, 1000)),
						literal: Formatter.format,
						coverage: required<"falsified" | "held">(["falsified"], {
							cases: 20,
							sense: notesOnly
						}),
						kept: [],
						runs: 20,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					(threshold, c) =>
						Effect.gen(function* () {
							const run = yield* Run
							const inner = explore(timedSearch, (drawnItems) =>
								Arr.some(drawnItems, (item) => item >= threshold)
									? Effect.die("falsified")
									: Effect.void
							).pipe(
								Effect.as(Option.none()),
								Effect.catchTag("PropertyFalsified", (falsified) =>
									Effect.succeedSome(shrunkOf(falsified))
								)
							)
							const bounded = yield* inner
							const unbounded = yield* Effect.provideService(
								inner,
								Run,
								Run.of({ ...run, deadline: noDeadline })
							)
							c.note(Option.isSome(bounded) ? "falsified" : "held")
							deepStrictEqual(bounded, unbounded)
							deepStrictEqual(
								Option.map(bounded, (shrunk): Omit<Shrunk, "phase"> => ({
									shrink: shrunk.shrink,
									items: shrunk.items
								})),
								Option.map(bounded, (): Omit<Shrunk, "phase"> => ({
									shrink: "minimal",
									items: Option.some([threshold])
								}))
							)
						})
				)
			)
	)
})
