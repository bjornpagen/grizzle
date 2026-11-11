import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import { count, type Enumerated, enumerated, firstBranch } from "#enumerate.ts"
import { drawn, type Exploration, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import {
	array,
	boolean,
	characterOf,
	constant,
	filter,
	type Gen,
	int,
	oneOf,
	string,
	subarray,
	weighted
} from "#gen.ts"
import { between, floorSeed, rotatingSeed, wordsOf } from "#random.ts"
import { type Drawn, type ReplayCase, replayOf, replayTokenOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink, shrink } from "#shrink.ts"
import {
	forcedChooser,
	generate,
	type Generated,
	randomChooser,
	recorder,
	sample
} from "#source.ts"
import { tokenOf, valuesFromToken } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

const SEEDS = Arr.range(0, 199)

/** A case drawn fresh from one seed. */
const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(recorder(), generator, randomChooser(wordsOf(seed)))

/** A generator with every structure the engine records: a dependent bound, a collection and weighted branches. */
const composite = (source: Parameters<Gen<unknown>>[0]) => {
	const bound = source.draw(int(0, 4))
	return {
		bound,
		items: source.draw(
			array(
				weighted([
					[1, int(0, bound)],
					[3, int(10, 20)]
				]),
				{ min: 0, max: bound }
			)
		),
		flag: source.draw(boolean)
	}
}

/** Every case of a bounded generator, in enumeration order. */
const allCases = <A>(generator: Gen<A>): ReadonlyArray<A> => {
	const recorded = recorder()
	const cases: Array<A> = []
	let step: Enumerated<A> = enumerated(recorded, generator, firstBranch)
	cases.push(step.generated.value)
	while (Option.isSome(step.next)) {
		step = enumerated(recorded, generator, step.next.value)
		cases.push(step.generated.value)
	}
	return cases
}

/**
 * A suite label, colons and all, and a case to replay in it: unsteered, or steered with nothing pending or with some
 * of twenty requirements pending, and values of either sign.
 */
const replayTokens: Gen<readonly [string, ReplayCase]> = (source) => {
	const suite = source.draw(string(characterOf(["a", ":", " ", "/", "-", "."]), { min: 1, max: 6 }))
	const drawnUnder: Drawn = source.draw(boolean)
		? {
				kind: "steered",
				pending: source.draw(oneOf([constant([]), subarray(Arr.range(0, 19))]))
			}
		: { kind: "unsteered" }
	const values = source.draw(array(oneOf([int(-1000, -1), int(0, 2 ** 52)]), { min: 0, max: 6 }))
	return [suite, { drawn: drawnUnder, values }]
}

/** The first seed whose fresh case the predicate holds for. */
const firstFailing = <A>(generator: Gen<A>, fails: (value: A) => boolean): Generated<A> =>
	Option.getOrThrow(
		Arr.findFirst(
			Arr.map(SEEDS, (seed) => fresh(generator, seed)),
			(generated) => fails(generated.value)
		)
	)

/** A search over the seeds a word stream starts from, every one of them a valid seed. */
const seedSearch = (suite: string): Exploration<number, number, never> => ({
	suite,
	draw: drawn(int(0, 0xffff_ffff)),
	literal: String,
	coverage: noCoverage,
	kept: [],
	runs: 40,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 40,
	caseHang: Duration.seconds(30)
})

describe("the word source", () => {
	it.effect("draws every value of a range, and nothing outside it, from any seed", (ctx) =>
		searched(
			ctx,
			explore(seedSearch("every value of a range"), (seed) =>
				Effect.sync(() => {
					const words = wordsOf(seed)
					const draws = Arr.makeBy(2000, () => between(words, 3, 7))
					deepStrictEqual(Arr.dedupe(Arr.sort(draws, Order.Number)), [3, 4, 5, 6, 7])
				})
			)
		)
	)

	it.effect("draws the same stream from the same seed", (ctx) =>
		searched(
			ctx,
			explore(seedSearch("one stream per seed"), (seed) =>
				Effect.sync(() => {
					const first = wordsOf(seed)
					const second = wordsOf(seed)
					deepStrictEqual(
						Arr.makeBy(64, () => first.next()),
						Arr.makeBy(64, () => second.next())
					)
				})
			)
		)
	)
})

describe("a tape", () => {
	it("replays its case exactly from its values", () => {
		for (const seed of SEEDS) {
			const original = fresh(composite, seed)
			const replay = generate(
				recorder(),
				composite,
				forcedChooser(original.tape.values, original.tape.length)
			)
			deepStrictEqual(replay, original)
		}
	})

	it.effect("carries its values through a replay token, the empty tape's included", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "tape/token",
					draw: drawn(array(int(0, 2 ** 52), { min: 0, max: 8 })),
					literal: Formatter.format,
					coverage: required<"an empty tape" | "one value" | "several values">(
						["an empty tape", "one value", "several values"],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: { kind: "bounded", candidates: 100 },
					concurrency: 1,
					steerEvery: 300,
					caseHang: Duration.seconds(10)
				},
				(values, c) =>
					Effect.sync(() => {
						c.note(
							values.length === 0
								? "an empty tape"
								: values.length === 1
									? "one value"
									: "several values"
						)
						const tape = Float64Array.from(values)
						deepStrictEqual(Arr.fromIterable(valuesFromToken(tokenOf(tape, tape.length))), values)
					})
			)
		)
	)

	it.effect(
		"names a case's suite, steering and values in its replay token, and reads them back exactly",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "replay/token",
						draw: drawn(replayTokens),
						literal: Formatter.format,
						coverage: required<
							| "unsteered"
							| "steered, nothing pending"
							| "steered, past the first digit"
							| "a colon in the suite"
							| "a negative value"
							| "an empty tape"
						>(
							[
								"unsteered",
								"steered, nothing pending",
								"steered, past the first digit",
								"a colon in the suite",
								"a negative value",
								"an empty tape"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: { kind: "bounded", candidates: 100 },
						concurrency: 1,
						steerEvery: 300,
						caseHang: Duration.seconds(10)
					},
					([suite, replayed], c) =>
						Effect.gen(function* () {
							switch (replayed.drawn.kind) {
								case "unsteered":
									c.note("unsteered")
									break
								case "steered":
									if (!Arr.isReadonlyArrayNonEmpty(replayed.drawn.pending)) {
										c.note("steered, nothing pending")
									}
									if (Arr.some(replayed.drawn.pending, (place) => place >= 4)) {
										c.note("steered, past the first digit")
									}
									break
							}
							if (Str.includes(":")(suite)) {
								c.note("a colon in the suite")
							}
							if (Arr.some(replayed.values, (value) => value < 0)) {
								c.note("a negative value")
							}
							if (!Arr.isReadonlyArrayNonEmpty(replayed.values)) {
								c.note("an empty tape")
							}
							const replay = yield* replayOf(replayTokenOf(suite, replayed))
							deepStrictEqual(replay, { suite, replayed })
						})
				)
			)
	)

	it("finishes a replay that runs out on simplest values, and says so", () => {
		const replay = generate(recorder(), composite, forcedChooser(new Float64Array(0), 0))
		strictEqual(replay.tape.status, "overrun")
		deepStrictEqual(replay.value, { bound: 0, items: [], flag: false })
	})
})

describe("a weighted choice", () => {
	it("draws options in proportion to their weights", () => {
		const skewed = weighted([
			[1, constant("rare")],
			[3, constant("common")]
		])
		const rare = Arr.filter(
			Arr.range(0, 3999),
			(seed) => fresh(skewed, seed).value === "rare"
		).length
		assertTrue(rare > 850 && rare < 1150, `about a quarter of 4000 draws are rare, not ${rare}`)
	})
})

describe("enumeration", () => {
	it("yields every case once, smallest first, the first decision outermost", () => {
		deepStrictEqual(
			allCases((source) => [source.draw(int(0, 2)), source.draw(int(0, 1))]),
			[
				[0, 0],
				[0, 1],
				[1, 0],
				[1, 1],
				[2, 0],
				[2, 1]
			]
		)
	})

	it("yields every length of a collection with every item", () => {
		deepStrictEqual(allCases(array(boolean, { min: 0, max: 2 })), [
			[],
			[false],
			[true],
			[false, false],
			[false, true],
			[true, false],
			[true, true]
		])
	})

	it("refuses a space larger than its limit before any property runs", () => {
		deepStrictEqual(count(array(int(0, 9), { min: 0, max: 3 }), 100), {
			kind: "beyond",
			limit: 100
		})
		deepStrictEqual(count(array(int(0, 9), { min: 0, max: 3 }), 1111), {
			kind: "within",
			cases: 1111
		})
	})

	it("does not count a case a filter discarded", () => {
		deepStrictEqual(
			count(
				filter(int(0, 9), (n) => n % 2 === 0, 1),
				100
			),
			{ kind: "within", cases: 5 }
		)
	})
})

describe("shrinking", () => {
	it.effect("shrinks a failing item to its threshold", () =>
		Effect.gen(function* () {
			const items = array(int(0, 1000), { min: 0, max: 10 })
			const fails = (values: ReadonlyArray<number>) => Arr.some(values, (value) => value >= 500)
			const shrunk = yield* shrink(
				items,
				firstFailing(items, fails),
				(values) => Effect.succeed(fails(values)),
				{
					kind: "complete"
				}
			)
			deepStrictEqual(shrunk.best.failure, [500])
			strictEqual(shrunk.ended, "minimal")
		})
	)

	it.effect("shrinks nested collections to the fewest decisions", () =>
		Effect.gen(function* () {
			const nested = array(array(int(0, 9), { min: 0, max: 4 }), { min: 0, max: 4 })
			const fails = (lists: ReadonlyArray<ReadonlyArray<number>>) => Arr.flatten(lists).length >= 3
			const shrunk = yield* shrink(
				nested,
				firstFailing(nested, fails),
				(lists) => Effect.succeed(fails(lists)),
				{
					kind: "complete"
				}
			)
			deepStrictEqual(shrunk.best.failure, [[0, 0, 0]])
		})
	)

	it.effect("moves a weighted choice to its first option", () =>
		Effect.gen(function* () {
			const branches = weighted([
				[1, constant("first")],
				[1, constant("second")],
				[1, constant("third")]
			])
			const failing = firstFailing(branches, (value) => value === "third")
			const shrunk = yield* shrink(branches, failing, () => Effect.succeed(true), {
				kind: "complete"
			})
			strictEqual(shrunk.best.failure, "first")
		})
	)

	it.effect("stops when its budget is spent, and says so", () =>
		Effect.gen(function* () {
			const items = array(int(0, 1000), { min: 0, max: 10 })
			const failing = firstFailing(items, (values) => values.length > 3)
			const shrunk = yield* shrink(items, failing, () => Effect.succeed(true), {
				kind: "bounded",
				candidates: 0
			})
			deepStrictEqual(shrunk, {
				best: { tape: failing.tape, failure: failing.value },
				candidates: 0,
				ended: "budget"
			})
		})
	)

	it.effect("shrinks the same failure to the same case every time", () =>
		Effect.gen(function* () {
			const items = array(int(0, 1000), { min: 0, max: 10 })
			const fails = (values: ReadonlyArray<number>) =>
				Arr.reduce(values, 0, (sum, value) => sum + value) > 1500
			const failing = firstFailing(items, fails)
			const check = (values: ReadonlyArray<number>) => Effect.succeed(fails(values))
			const first = yield* shrink(items, failing, check, { kind: "complete" })
			const second = yield* shrink(items, failing, check, { kind: "complete" })
			deepStrictEqual(first.best, second.best)
		})
	)
})

describe("sampling", () => {
	it.effect("draws a stream's cases from its seed alone", (ctx) =>
		searched(
			ctx,
			explore(seedSearch("one sample per seed"), (seed) =>
				Effect.sync(() => {
					const stream = rotatingSeed(seed, floorSeed("sampling"))
					deepStrictEqual(sample(composite, stream, 20), sample(composite, stream, 20))
				})
			)
		)
	)
})
