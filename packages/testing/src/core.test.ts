/**
 * The engine under every search (random.ts, source.ts, tape.ts, replay.ts, enumerate.ts, gen.ts weighted), each held
 * to its specification: a range drawn whole and nothing outside it, from any seed; one stream from one seed; a case
 * replayed exactly from its values and through its replay token, the empty tape's included; a token's suite, steering
 * and values read back exactly, colons in the suite included; a replay that runs out finishing on simplest values and
 * saying so exactly then; weighted options in exact proportion however large the total; a uniform option and a
 * leaning magnitude from the same words; every case of a generator once, in its order, all of them counted; a stream's
 * cases from its seed alone.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), one a property in this order: between-hi-excluded,
 * case-seed-unmixed, replay-past-last-value, token-drops-last, replay-token-suite-colon, overrun-unmarked,
 * weighted-arm-off-by-one, biased-never-leans, enumeration-skips-values, case-seed-unmixed.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import { everyCase, everyValue, fraction, shareOf } from "#chance.fixtures.ts"
import { sizeOf } from "#enumerate.ts"
import { drawn, type Exploration, explore, type Oracle } from "#explore.ts"
import { type Coverage, noCoverage, required } from "#features.ts"
import {
	array,
	boolean,
	characterOf,
	constant,
	type Gen,
	int,
	oneOf,
	string,
	subarray,
	type Weight,
	type Weighted,
	weighted,
	element
} from "#gen.ts"
import { between, biased, caseSeed, floorSeed, rotatingSeed, wordsOf } from "#random.ts"
import { type Drawn, type ReplayCase, replayOf, replayTokenOf } from "#replay.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import {
	forcedChooser,
	type Generated,
	generate,
	prefixChooser,
	randomChooser,
	recorder,
	sample,
	simplestChooser
} from "#source.ts"
import { tokenOf, valuesFromToken } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

/** Weights a weighted choice draws from: from the least to the most a weight can be, so totals pass 256. */
const WEIGHTS: Arr.NonEmptyReadonlyArray<Weight> = [1, 2, 3, 50, 99]

/** A list known to be non-empty, as its type says; a generator of at least one value draws it. */
const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty))

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

/** A search over the seeds a word stream starts from, every one of them a valid seed. */
const searchOf = <A, F extends string>(
	suite: string,
	oracle: Oracle,
	generator: Gen<A>,
	coverage: Coverage<F>
): Exploration<A, A, F> => ({
	suite,
	oracle,
	draw: drawn(generator),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 40,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 40,
	caseHang: Duration.seconds(30)
})

const seedSearch = (suite: string, oracle: Oracle): Exploration<number, number, never> =>
	searchOf(suite, oracle, int(0, 0xffff_ffff), noCoverage)

describe("the word source", () => {
	it.effect("draws every value of a range, and nothing outside it, from any seed", (ctx) =>
		searched(
			ctx,
			explore(
				seedSearch("every value of a range", {
					kind: "specification",
					name: "between draws exactly the values of its range"
				}),
				(seed) =>
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
			explore(
				seedSearch("one stream per seed", {
					kind: "universal",
					name: "determinism: one seed, one stream"
				}),
				(seed) =>
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
	it.effect("replays its case exactly from its values", (ctx) =>
		searched(
			ctx,
			explore(
				seedSearch("tape replay", {
					kind: "universal",
					name: "round trip: a tape's values replay its case exactly"
				}),
				(seed) =>
					Effect.sync(() => {
						const original = fresh(composite, seed)
						const replay = generate(
							recorder(),
							composite,
							forcedChooser(original.tape.values, original.tape.length)
						)
						deepStrictEqual(replay, original)
					})
			)
		)
	)

	it.effect("carries its values through a replay token, the empty tape's included", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "tape/token",
					oracle: { kind: "universal", name: "valuesFromToken ∘ tokenOf = id" },
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
						oracle: { kind: "universal", name: "replayOf ∘ replayTokenOf = id" },
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

	it.effect(
		"finishes a replay that runs out on simplest values, and says so exactly when it ran out",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"replay runs out",
						{
							kind: "second-implementation",
							name: "the same prefix continued by the simplest chooser, as an enumeration continues it"
						},
						(source) => {
							const seed = source.draw(int(0, 0xffff_ffff))
							return { seed, kept: source.draw(int(0, fresh(composite, seed).tape.length)) }
						},
						required<"an empty prefix" | "a cut tape" | "the whole tape">(
							["an empty prefix", "a cut tape", "the whole tape"],
							{ cases: 100, sense: notesOnly }
						)
					),
					({ seed, kept }, c) =>
						Effect.sync(() => {
							const original = fresh(composite, seed)
							const whole = kept === original.tape.length
							c.note(kept === 0 ? "an empty prefix" : whole ? "the whole tape" : "a cut tape")
							const replay = generate(
								recorder(),
								composite,
								forcedChooser(original.tape.values, kept)
							)
							const continued = generate(
								recorder(),
								composite,
								prefixChooser(original.tape.values, kept, simplestChooser)
							)
							deepStrictEqual(
								{ value: replay.value, status: replay.tape.status },
								{ value: continued.value, status: whole ? "complete" : "overrun" }
							)
						})
				)
			)
	)
})

describe("a weighted choice", () => {
	it.effect(
		"draws each option exactly in proportion to its weight, however large the total",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"weighted shares",
						{
							kind: "specification",
							name: "each option's weight over the total, by exact enumeration"
						},
						array(element(WEIGHTS), { min: 1, max: 5 }),
						required<"a total past 256">(["a total past 256"], { cases: 100, sense: notesOnly })
					),
					(weights, c) =>
						Effect.sync(() => {
							const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
							if (total > 256) {
								c.note("a total past 256")
							}
							const cases = everyCase(
								weighted(
									nonEmpty(
										Arr.map(weights, (weight, at): Weighted<number> => [weight, constant(at)])
									)
								)
							)
							deepStrictEqual(
								Arr.map(weights, (_weight, at) => shareOf(cases, (drawnAt) => drawnAt === at)),
								Arr.map(weights, (weight) => fraction(BigInt(weight), BigInt(total)))
							)
						})
				)
			)
	)
})

describe("the random chooser", () => {
	it.effect(
		"draws an option uniformly and a magnitude leaning toward the ends, from the same words",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"chooser spreads",
						{ kind: "second-implementation", name: "the word source's own between and biased" },
						(source) => {
							const seed = source.draw(int(0, 0xffff_ffff))
							const lo = source.draw(int(-1000, 1000))
							return { seed, lo, hi: lo + source.draw(int(0, 100_000)) }
						},
						noCoverage
					),
					({ seed, lo, hi }) =>
						Effect.sync(() => {
							deepStrictEqual(
								[
									randomChooser(wordsOf(seed)).draw(lo, hi, 0, "uniform"),
									randomChooser(wordsOf(seed)).draw(lo, hi, 0, "leaning")
								],
								[between(wordsOf(seed), lo, hi), biased(wordsOf(seed), lo, hi)]
							)
						})
				)
			)
	)
})

/** A generator's shape, small enough to enumerate by hand: a range of whole numbers, a collection of a shape, or a pair. */
type Shape =
	| Readonly<{ kind: "int"; lo: number; hi: number }>
	| Readonly<{ kind: "array"; item: Shape; min: number; max: number }>
	| Readonly<{ kind: "pair"; first: Shape; second: Shape }>

/** A value of a shape. */
type Shaped = number | ReadonlyArray<Shaped>

/** A range of whole numbers within -3..3. */
const rangeShape: Gen<Readonly<{ kind: "int"; lo: number; hi: number }>> = (source) => {
	const lo = source.draw(int(-3, 3))
	return { kind: "int", lo, hi: source.draw(int(lo, 3)) }
}

/** A shape at most `depth` levels deep: at each level a range, a collection of up to two items, or a pair. */
const shapeOf = (depth: number): Gen<Shape> =>
	depth === 0
		? rangeShape
		: oneOf<Shape>([
				rangeShape,
				(source) => {
					const min = source.draw(int(0, 2))
					return {
						kind: "array",
						item: source.draw(shapeOf(depth - 1)),
						min,
						max: source.draw(int(min, 2))
					}
				},
				(source) => ({
					kind: "pair",
					first: source.draw(shapeOf(depth - 1)),
					second: source.draw(shapeOf(depth - 1))
				})
			])

/** The generator a shape describes. */
const generatorOf = (shape: Shape): Gen<Shaped> => {
	switch (shape.kind) {
		case "int":
			return int(shape.lo, shape.hi)
		case "array":
			return array(generatorOf(shape.item), { min: shape.min, max: shape.max })
		case "pair": {
			const first = generatorOf(shape.first)
			const second = generatorOf(shape.second)
			return (source) => [source.draw(first), source.draw(second)]
		}
	}
}

/** By distance from zero, the positive side first: int's order, as its specification states it. */
const byDistanceFromZero = Order.mapInput(
	Order.Number,
	(value: number) => Math.abs(value) * 2 + (value < 0 ? 1 : 0)
)

/** Every sequence of `length` values of `items`, the first position outermost. */
const sequences = (
	items: ReadonlyArray<Shaped>,
	length: number
): ReadonlyArray<ReadonlyArray<Shaped>> =>
	length === 0
		? [[]]
		: Arr.flatMap(items, (first) =>
				Arr.map(sequences(items, length - 1), (rest) => [first, ...rest])
			)

/**
 * Every value of a shape, in the order the library's specification gives: a range by distance from zero, the positive
 * side first; a collection by its length, shortest first, then its items, the first outermost; a pair with its first
 * value outermost.
 */
const enumerationOf = (shape: Shape): ReadonlyArray<Shaped> => {
	switch (shape.kind) {
		case "int":
			return Arr.sort(
				Array.from({ length: shape.hi - shape.lo + 1 }, (_, i) => shape.lo + i),
				byDistanceFromZero
			)
		case "array": {
			const items = enumerationOf(shape.item)
			return Arr.flatMap(
				Array.from({ length: shape.max - shape.min + 1 }, (_, i) => shape.min + i),
				(length) => sequences(items, length)
			)
		}
		case "pair": {
			const seconds = enumerationOf(shape.second)
			return Arr.flatMap(enumerationOf(shape.first), (first) =>
				Arr.map(seconds, (second) => [first, second])
			)
		}
	}
}

type EnumerationFeature =
	| "a range across zero"
	| "a range below zero"
	| "a collection that may be empty"
	| "a collection of collections"
	| "a pair"

describe("enumeration", () => {
	it.effect(
		"yields every case of a generator once, in its specified order, and counts them all",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"enumeration order",
						{
							kind: "second-implementation",
							name: "each shape's values listed from its specification: int's order, collections by length, the first decision outermost"
						},
						shapeOf(2),
						required<EnumerationFeature>(
							[
								"a range across zero",
								"a range below zero",
								"a collection that may be empty",
								"a collection of collections",
								"a pair"
							],
							{ cases: 400, sense: notesOnly }
						)
					),
					(shape, c) =>
						Effect.gen(function* () {
							const noteShape = (inner: Shape, nested: boolean): void => {
								switch (inner.kind) {
									case "int":
										if (inner.lo < 0 && inner.hi > 0) {
											c.note("a range across zero")
										}
										if (inner.hi < 0) {
											c.note("a range below zero")
										}
										return
									case "array":
										if (inner.min === 0) {
											c.note("a collection that may be empty")
										}
										if (nested) {
											c.note("a collection of collections")
										}
										noteShape(inner.item, true)
										return
									case "pair":
										c.note("a pair")
										noteShape(inner.first, false)
										noteShape(inner.second, false)
								}
							}
							noteShape(shape, false)
							const expected = enumerationOf(shape)
							const size = yield* sizeOf(generatorOf(shape))
							deepStrictEqual(
								{ values: everyValue(generatorOf(shape)), size },
								{ values: expected, size: expected.length }
							)
						})
				)
			)
	)
})

describe("sampling", () => {
	it.effect("draws a stream's cases from its seed alone", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"one sample per seed",
					{ kind: "specification", name: "a stream's cases, each regenerated from its own seed" },
					(source) => ({ seed: source.draw(int(0, 0xffff_ffff)), length: source.draw(int(0, 20)) }),
					noCoverage
				),
				({ seed, length }) =>
					Effect.sync(() => {
						const stream = rotatingSeed(seed, floorSeed("sampling"))
						const expected: Array<ReturnType<typeof composite>> = []
						for (let index = 0; index < length; index += 1) {
							expected.push(fresh(composite, caseSeed(stream, index)).value)
						}
						deepStrictEqual(sample(composite, stream, length), expected)
					})
			)
		)
	)
})
