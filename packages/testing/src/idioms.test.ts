import { describe, it } from "@effect/vitest"
import { assertSome, assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import {
	Array as Arr,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Schema,
	String as Str
} from "effect"
import { everyCase, everyValue, type Fraction, fraction, shareOf } from "#chance.fixtures.ts"
import { type Case, drawn, type Exploration, exhaust, explore, type Oracle } from "#explore.ts"
import { type Coverage, noCoverage, required } from "#features.ts"
import {
	alphabet,
	array,
	clone,
	composition,
	constant,
	element,
	type Gen,
	increasing,
	int,
	map,
	nondecreasing,
	oneOf,
	parents,
	production,
	proportional,
	shuffled,
	subset,
	unicodeScalar,
	uniqueArray
} from "#gen.ts"
import {
	type Corruption,
	corrupted,
	corruptedFeature,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	WILD_KINDS,
	WildTouched,
	wildOf
} from "#lsw.ts"
import { agree, exact, multiset } from "#oracle.ts"
import { matching, PatternRefused } from "#pattern.ts"
import { wordsOf } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink, shrink } from "#shrink.ts"
import { type Generated, generate, prefixChooser, randomChooser, simplestChooser } from "#source.ts"
import { keep, type Swarm, type SwarmWeight, swarm, swarmChoice, weightOf } from "#swarm.ts"
import { bigint, double, doubleOrSpecial, float, uuid } from "#values.ts"
import { searched } from "#vitest/searched.ts"

const SEEDS = Arr.range(0, 3999)

/** A case drawn fresh from one seed. */
const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(generator, randomChooser(wordsOf(seed)))

/** One fresh case per seed, as a random search draws them. */
const draws = <A>(generator: Gen<A>): ReadonlyArray<A> =>
	Arr.map(SEEDS, (seed) => fresh(generator, seed).value)

/** A list known to be non-empty, as its type says; a generator of at least one value draws it. */
const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty))

/** A search over the seed a fresh case is drawn from: any seed of the word source. */
const seeds: Gen<number> = int(0, 0xffff_ffff)

/** The values of `wanted` a random search never drew, compared as `Object.is` compares, so -0 is not 0. */
const neverDrawn = <A>(values: ReadonlyArray<A>, wanted: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.filter(wanted, (value) => !Arr.some(values, (seen) => Object.is(seen, value)))

/** This suite's budget for a property over `generator`. */
const searchOf = <A, F extends string>(
	suite: string,
	oracle: Oracle,
	generator: Gen<A>,
	coverage: Coverage<F>,
	runs: number
): Exploration<A, A, F> => ({
	suite,
	oracle,
	draw: drawn(generator),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Two draws of `generator` as a range: the lesser first. */
const boundsOf =
	<A extends number | bigint>(generator: Gen<A>): Gen<readonly [lo: A, hi: A]> =>
	(source) => {
		const first = source.draw(generator)
		const second = source.draw(generator)
		return first <= second ? [first, second] : [second, first]
	}

/** Every whole number from -5 to 5 as a range's low end, with every high end from there to 5. */
const smallBounds: Gen<readonly [lo: number, hi: number]> = (source) => {
	const lo = source.draw(int(-5, 5))
	return [lo, source.draw(int(lo, 5))]
}

const byDistanceFromZero = Order.mapInput(
	Order.Number,
	(value: number) => Math.abs(value) * 2 + (value < 0 ? 1 : 0)
)

const FLOAT_MAX = 3.402_823_466_385_288_6e38

describe("whole numbers", () => {
	it.effect("enumerate every range by distance from zero, the positive side first", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "int order",
					oracle: {
						kind: "specification",
						name: "int's order: by distance from zero, the positive side first"
					},
					box: "every range of whole numbers within -5..5",
					generator: smallBounds,
					literal: Formatter.format,
					limit: 100,
					coverage: noCoverage,
					caseHang: Duration.minutes(1)
				},
				([lo, hi]) =>
					Effect.sync(() =>
						deepStrictEqual(
							everyValue(int(lo, hi)),
							Arr.sort(Arr.range(lo, hi), byDistanceFromZero)
						)
					)
			)
		)
	)

	it("reach zero and both ends of a wide range in a random search", () => {
		deepStrictEqual(neverDrawn(draws(int(-1_000_000, 1_000_000)), [-1_000_000, 0, 1_000_000]), [])
	})
})

describe("bigints", () => {
	it("enumerate a narrow range by distance from zero", () => {
		deepStrictEqual(everyValue(bigint(-3n, 4n)), [0n, 1n, -1n, 2n, -2n, 3n, -3n, 4n])
	})

	it.effect("stay within their range, however wide", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"bigint bounds",
					{ kind: "specification", name: "lo ≤ value ≤ hi, as bigint states" },
					boundsOf(bigint(-(2n ** 100n), 2n ** 100n)),
					noCoverage,
					200
				),
				([lo, hi], c) =>
					Effect.sync(() => {
						const value = c.draw(bigint(lo, hi))
						assertTrue(lo <= value && value <= hi, `${value} lies within ${lo}..${hi}`)
					})
			)
		)
	)

	it("reach zero and both ends of the 64-bit range in a random search", () => {
		deepStrictEqual(
			neverDrawn(draws(bigint(-(2n ** 63n), 2n ** 63n - 1n)), [-(2n ** 63n), 0n, 2n ** 63n - 1n]),
			[]
		)
	})
})

describe("floating-point numbers", () => {
	it.effect("are finite doubles within their range", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"double bounds",
					{ kind: "specification", name: "a finite double within its range, as double states" },
					boundsOf(double(-Number.MAX_VALUE, Number.MAX_VALUE)),
					noCoverage,
					200
				),
				([min, max], c) =>
					Effect.sync(() => {
						const value = c.draw(double(min, max))
						assertTrue(
							Number.isFinite(value) && min <= value && value <= max,
							`${value} is finite and lies within ${min}..${max}`
						)
					})
			)
		)
	)

	it.effect("are 32-bit floats within their range", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"float bounds",
					{ kind: "specification", name: "a 32-bit float within its range, as float states" },
					boundsOf(float(-FLOAT_MAX, FLOAT_MAX)),
					noCoverage,
					200
				),
				([min, max], c) =>
					Effect.sync(() => {
						const value = c.draw(float(min, max))
						strictEqual(Math.fround(value), value, `${value} is a 32-bit float`)
						assertTrue(min <= value && value <= max, `${value} lies within ${min}..${max}`)
					})
			)
		)
	)

	it("reach -0, zero and both ends of their range in a random search", () => {
		deepStrictEqual(neverDrawn(draws(double(-1, 1)), [-1, -0, 0, 1]), [])
	})

	it.effect(
		"shrink a failing double drawn whole to the least whole number that still fails",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"double shrink",
						{
							kind: "specification",
							name: "the least whole number that still fails, as wholeOr states"
						},
						seeds,
						noCoverage,
						40
					),
					(seed, c) =>
						Effect.gen(function* () {
							const generator = double(-1e9, 1e9)
							const fails = (value: number) => Math.abs(value) > 10.25
							const wholeArm = Float64Array.of(0)
							const failing = generate(
								generator,
								prefixChooser(wholeArm, wholeArm.length, randomChooser(wordsOf(seed)))
							)
							yield* c.assume(fails(failing.value))
							const shrunk = yield* shrink(
								generator,
								failing,
								(value) => Effect.succeed(fails(value)),
								completeShrink
							)
							strictEqual(shrunk.best.failure, 11)
						})
				)
			)
	)
})

const CANONICAL_UUID = regex(
	"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

describe("doubles with special values", () => {
	it("draws finite doubles in range most often, and every special value now and then", () => {
		const drawnDoubles = draws(doubleOrSpecial(-1, 1))
		deepStrictEqual(
			neverDrawn(drawnDoubles, [
				Number.NaN,
				Number.POSITIVE_INFINITY,
				Number.NEGATIVE_INFINITY,
				-0
			]),
			[]
		)
		const finite = Arr.filter(
			drawnDoubles,
			(value) => Number.isFinite(value) && !Object.is(value, -0)
		)
		assertTrue(
			Arr.every(finite, (value) => value >= -1 && value <= 1),
			"every finite draw lies in its range"
		)
		assertTrue(finite.length > 3400, `nine draws in ten are finite, not ${finite.length} of 4000`)
	})
})

describe("uuids", () => {
	it.effect("are canonical, of their version, with RFC 9562's variant", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"uuid form",
					{ kind: "specification", name: "RFC 9562's canonical form, version and variant" },
					element([1, 2, 3, 4, 5, 6, 7, 8] as const),
					noCoverage,
					100
				),
				(version, c) =>
					Effect.sync(() => {
						const value = c.draw(uuid(version))
						assertTrue(CANONICAL_UUID.test(value), `${value} is a canonical UUID`)
						strictEqual(pipe(value, Str.slice(14, 15)), `${version}`)
					})
			)
		)
	)

	it("shrink a version 7 UUID to the epoch's", () => {
		strictEqual(generate(uuid(7), simplestChooser).value, "00000000-0000-7000-8000-000000000000")
	})
})

describe("collections", () => {
	it.effect("shuffle without repeating, every arrangement once", (ctx) =>
		Effect.gen(function* () {
			const values = [0, 1, 2, 3]
			const exhausted = yield* searched(
				ctx,
				exhaust(
					{
						suite: "shuffled",
						oracle: {
							kind: "specification",
							name: "each value at most once, and every arrangement of each size"
						},
						box: "every arrangement of 0 to 4 of 0, 1, 2 and 3",
						generator: shuffled(values, { min: 0, max: 4 }),
						literal: Formatter.format,
						limit: 100,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(picked) =>
						Effect.sync(() => {
							deepStrictEqual(Arr.dedupe(picked), picked)
							deepStrictEqual(Arr.difference(picked, values), [])
						})
				)
			)
			strictEqual(exhausted.cases, 1 + 4 + 12 + 24 + 24)
		})
	)

	it.effect("never repeat a key in a unique array", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"unique array",
					{ kind: "specification", name: "no two items share a key" },
					uniqueArray(int(0, 5), (value) => value, { min: 0, max: 6 }, 40),
					noCoverage,
					200
				),
				(items) => Effect.sync(() => deepStrictEqual(Arr.dedupe(items), items))
			)
		)
	)

	it("give a case up when no new key is left", () => {
		strictEqual(
			fresh(
				uniqueArray(int(0, 1), (value) => value, { min: 3, max: 3 }, 5),
				1
			).tape.status,
			"discarded"
		)
	})

	it.effect("draw a non-empty alphabet of every subset with each kept letter", (ctx) =>
		Effect.gen(function* () {
			const letters = ["a", "b", "c"] as const
			const exhausted = yield* searched(
				ctx,
				exhaust(
					{
						suite: "alphabet",
						oracle: {
							kind: "specification",
							name: "a non-empty subset whose kept letter comes first"
						},
						box: "every alphabet of a, b and c",
						generator: alphabet(letters),
						literal: Formatter.format,
						limit: 100,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(drawnLetters) =>
						Effect.sync(() => {
							deepStrictEqual(Arr.dedupe(drawnLetters), drawnLetters)
							deepStrictEqual(Arr.difference(drawnLetters, letters), [])
						})
				)
			)
			strictEqual(exhausted.cases, 3 * 4)
		})
	)

	it("make twins equal by structure that share no object", () => {
		const [first, second] = fresh(
			clone(
				array(
					map(int(0, 9), (value) => ({ value })),
					{ min: 1, max: 4 }
				),
				2
			),
			3
		).value
		deepStrictEqual(first, second)
		assertTrue(first !== second, "the twins are different arrays")
	})

	it.effect(
		"draw production's constant five times in six exactly, and each small value an equal share of the rest",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"production share",
						{
							kind: "specification",
							name: "production's constant five times in six, by exact enumeration"
						},
						alphabet([1, 2, 3, 4, 5, 6, 7, 8]),
						noCoverage,
						60
					),
					(small) =>
						Effect.sync(() => {
							const cases = everyCase(production(64, small))
							deepStrictEqual(
								[
									shareOf(cases, (value) => value === 64),
									...Arr.map(small, (value) => shareOf(cases, (drawnValue) => drawnValue === value))
								],
								[fraction(5n, 6n), ...Arr.map(small, () => fraction(1n, 6n * BigInt(small.length)))]
							)
						})
				)
			)
	)
})

type Letter = "a" | "b" | "c"

/**
 * The chance a swarm turns off a feature other than its forced one, from the omissions' definition: five-sixths,
 * half and one-sixth, each drawn a third of the time, so 1/2.
 */
const OFF_RATE: Fraction = fraction(5n + 3n + 1n, 3n * 6n)

describe("an element", () => {
	it("is one of a mixed list's own literals, every one in order when enumerated", () => {
		const statuses: Gen<429 | 503 | "timeout"> = element([429, 503, "timeout"])
		deepStrictEqual(everyValue(statuses), [429, 503, "timeout"])
	})
})

describe("unicode scalars", () => {
	it("draws every plane and never a surrogate", () => {
		const points = Arr.map(draws(unicodeScalar), (character) =>
			Option.getOrThrow(Str.codePointAt(0)(character))
		)
		deepStrictEqual(
			Arr.filter(points, (point) => point >= 0xd800 && point <= 0xdfff),
			[],
			"no draw is a lone surrogate"
		)
		assertTrue(
			Arr.some(points, (point) => point > 0xffff),
			"some draws lie beyond the basic plane"
		)
		assertTrue(
			Arr.some(points, (point) => point > 0xdfff && point <= 0xffff),
			"some draws lie past the surrogates"
		)
	})
})

describe("computed weights", () => {
	it.effect(
		"draws each option exactly in proportion to its weight, however large the total, never one of weight zero, and the floor when none has weight",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"proportional shares",
						{
							kind: "specification",
							name: "each option's weight over the total, by exact enumeration"
						},
						array(oneOf([constant(0), int(1, 9), int(1, 300)]), { min: 1, max: 4 }),
						required<"a weight of zero" | "a total past 256" | "no weight at all">(
							["a weight of zero", "a total past 256", "no weight at all"],
							{ cases: 200, sense: notesOnly }
						),
						200
					),
					(weights, c) =>
						Effect.sync(() => {
							const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
							if (Arr.some(weights, (weight) => weight === 0)) {
								c.note("a weight of zero")
							}
							if (total > 256) {
								c.note("a total past 256")
							}
							if (total === 0) {
								c.note("no weight at all")
							}
							const cases = everyCase(
								proportional(
									nonEmpty(Arr.map(weights, (weight, at) => [weight, constant(at)] as const))
								)
							)
							deepStrictEqual(
								Arr.map(weights, (_weight, at) => shareOf(cases, (drawnAt) => drawnAt === at)),
								Arr.map(weights, (weight, at): Fraction =>
									total === 0
										? fraction(at === 0 ? 1n : 0n, 1n)
										: fraction(BigInt(weight), BigInt(total))
								)
							)
						})
				)
			)
	)

	it("draws its floor, and records no decision, when no option or only one has weight", () => {
		const floor = generate(
			proportional([
				[0, constant("floor")],
				[0, constant("other")]
			]),
			simplestChooser
		)
		deepStrictEqual([floor.value, floor.tape.length], ["floor", 0])
		const alone = generate(
			proportional([
				[0, constant("off")],
				[5, constant("alone")]
			]),
			simplestChooser
		)
		deepStrictEqual([alone.value, alone.tape.length], ["alone", 0])
	})
})

describe("swarms", () => {
	it.effect(
		"never turn every feature off, and turn each other one off at its omission's rate exactly, every presence equally often, in boxes of up to 3 features",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "swarm distribution",
						oracle: {
							kind: "specification",
							name: "the omissions' rates and the forced feature, by exact enumeration"
						},
						box: "every swarm of every alphabet of a, b and c",
						generator: alphabet<Letter>(["a", "b", "c"]),
						literal: Formatter.format,
						limit: 20,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(features) =>
						Effect.sync(() => {
							const cases = everyCase(swarm(features))
							const k = BigInt(features.length)
							const offAt = (feature: Letter) =>
								shareOf(cases, (drawnSwarm) => weightOf(drawnSwarm, feature) === 0)
							const presenceAt = (feature: Letter, presence: SwarmWeight) =>
								shareOf(cases, (drawnSwarm) => weightOf(drawnSwarm, feature) === presence)
							deepStrictEqual(
								{
									allOff: shareOf(cases, (drawnSwarm) =>
										Arr.every(features, (feature) => weightOf(drawnSwarm, feature) === 0)
									),
									off: Arr.map(features, offAt),
									presences: Arr.map(features, (feature) =>
										Arr.map([1, 2, 3] as const, (presence) => presenceAt(feature, presence))
									)
								},
								{
									allOff: fraction(0n, 1n),
									off: Arr.map(features, () => fraction((k - 1n) * OFF_RATE[0], k * OFF_RATE[1])),
									presences: Arr.map(features, () =>
										Arr.map([1, 2, 3] as const, () =>
											fraction(k * OFF_RATE[1] - (k - 1n) * OFF_RATE[0], 3n * k * OFF_RATE[1])
										)
									)
								}
							)
						})
				)
			)
	)

	it("keep a feature at a third, two thirds or every place, by its weight", () => {
		deepStrictEqual(
			[
				everyValue(keep({ a: 1 }, "a")),
				everyValue(keep({ a: 2 }, "a")),
				everyValue(keep({ a: 3 }, "a")),
				everyValue(keep({}, "a"))
			],
			[[false, false, true], [false, true, true], [true], [false]]
		)
	})

	it("choose among the features that are on by weight, and the floor when none is", () => {
		const someOn: Swarm<Letter> = { b: 1, c: 2 }
		const noneOn: Swarm<Letter> = {}
		deepStrictEqual(
			[
				everyValue(swarmChoice(someOn, ["a", "b", "c"])),
				everyValue(swarmChoice(noneOn, ["a", "b"]))
			],
			[["b", "c", "c"], ["a"]]
		)
	})
})

/** Every strictly increasing or nondecreasing sequence of whole numbers of `lo..hi` of a length within `size`. */
const ascendingModel = (
	lo: number,
	hi: number,
	size: Readonly<{ min: number; max: number }>,
	step: 0 | 1
): ReadonlyArray<ReadonlyArray<number>> => {
	const grown: Array<ReadonlyArray<number>> = []
	const grow = (prefix: ReadonlyArray<number>, from: number): void => {
		if (prefix.length >= size.min) {
			grown.push(prefix)
		}
		if (prefix.length < size.max) {
			for (let value = from; value <= hi; value += 1) {
				grow([...prefix, value], value + step)
			}
		}
	}
	grow([], lo)
	return grown
}

/** Every array whose entry `i` is a number from 0 to `i`: the parent of node `i + 1` among the nodes before it. */
const treesModel = (nodes: number): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.reduce(
		Arr.filter(Arr.range(1, Math.max(1, nodes - 1)), (node) => node < nodes),
		[[]],
		(trees: ReadonlyArray<ReadonlyArray<number>>, node) =>
			Arr.flatMap(trees, (tree) =>
				Arr.map(Arr.range(0, node - 1), (parent) => Arr.append(tree, parent))
			)
	)

/** Every way `total` items fall into `parts` places, each a count of none or more. */
const compositionsModel = (total: number, parts: number): ReadonlyArray<ReadonlyArray<number>> =>
	parts === 0
		? total === 0
			? [[]]
			: []
		: parts === 1
			? [[total]]
			: Arr.flatMap(Arr.range(0, total), (first) =>
					Arr.map(compositionsModel(total - first, parts - 1), (rest) => [first, ...rest])
				)

/** Whether a parent array is a tree: every node reaches the root by its parents in fewer steps than there are nodes. */
const isTree = (parent: ReadonlyArray<number>): boolean =>
	Arr.every(parent, (first, index) => {
		let node = first
		for (let step = 0; step <= parent.length && node !== 0; step += 1) {
			if (node > index) {
				return false
			}
			node = Arr.getUnsafe(parent, node - 1)
		}
		return node === 0
	})

/** A box of ranges and sizes: a low end of -2 to 1, a width of up to 4, and every size within it. */
const rangeBox: Gen<
	Readonly<{ lo: number; hi: number; size: Readonly<{ min: number; max: number }> }>
> = (source) => {
	const lo = source.draw(int(-2, 1))
	const width = source.draw(int(0, 4))
	const max = source.draw(int(0, width))
	return { lo, hi: lo + width - 1, size: { min: source.draw(int(0, max)), max } }
}

describe("constructive collections", () => {
	it.effect(
		"draw every sorted list, sorted set and subset in a box of ranges up to 4 wide exactly once, and nothing else",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "sorted collections",
						box: "every range of width up to 4 from -2..1, and every size within it",
						oracle: { kind: "second-implementation", name: "each space built by naive recursion" },
						generator: rangeBox,
						literal: Formatter.format,
						limit: 200,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					({ lo, hi, size }) =>
						Effect.gen(function* () {
							const width = hi - lo + 1
							const strict = { min: Math.min(size.min, width), max: Math.min(size.max, width) }
							yield* agree(
								[
									["increasing", everyValue(increasing(lo, hi, strict))],
									["model", ascendingModel(lo, hi, strict, 1)]
								],
								multiset(exact)
							)
							yield* agree(
								[
									["nondecreasing", everyValue(nondecreasing(lo, hi, size))],
									[
										"model",
										width === 0 ? (size.min === 0 ? [[]] : []) : ascendingModel(lo, hi, size, 0)
									]
								],
								multiset(exact)
							)
							const values = Arr.map(Arr.range(lo, Math.max(lo, hi)), (value) => `v${value}`).slice(
								0,
								width
							)
							yield* agree(
								[
									["subset", everyValue(subset(values, strict))],
									[
										"model",
										Arr.map(ascendingModel(0, width - 1, strict, 1), (at) =>
											Arr.map(at, (index) => Arr.getUnsafe(values, index))
										)
									]
								],
								multiset(exact)
							)
						})
				)
			)
	)

	it.effect("draw every rooted tree of up to 5 nodes exactly once, each one acyclic", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "trees",
					box: "every tree of 1 to 5 nodes",
					oracle: {
						kind: "second-implementation",
						name: "every parent array built by naive recursion"
					},
					generator: int(1, 5),
					literal: Formatter.format,
					limit: 10,
					coverage: noCoverage,
					caseHang: Duration.minutes(1)
				},
				(nodes) =>
					Effect.gen(function* () {
						const trees = everyValue(parents({ min: nodes, max: nodes }))
						assertTrue(Arr.every(trees, isTree), "every drawn parent array is a tree")
						yield* agree(
							[
								["parents", trees],
								["model", treesModel(nodes)]
							],
							multiset(exact)
						)
					})
			)
		)
	)

	it.effect(
		"draw every way up to 4 items fall into up to 3 places exactly once, each summing to its total",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "compositions",
						box: "every total of 0 to 4 into 1 to 3 places",
						oracle: {
							kind: "second-implementation",
							name: "every composition built by naive recursion"
						},
						generator: (source) => ({
							total: source.draw(int(0, 4)),
							parts: source.draw(int(1, 3))
						}),
						literal: Formatter.format,
						limit: 20,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					({ total, parts }) =>
						agree(
							[
								["composition", everyValue(composition(total, parts))],
								["model", compositionsModel(total, parts)]
							],
							multiset(exact)
						)
				)
			)
	)
})

const DRAWN_FEATURES: Arr.NonEmptyReadonlyArray<DrawnFeature<"closed scope">> = [
	"live",
	"stale closed scope",
	...Arr.map(WILD_KINDS, (kind): DrawnFeature<"closed scope"> => `wild ${kind}`)
]

const boundaryValue = lsw({
	live: int(0, 9),
	stale: Option.some(map(int(0, 9), (value) => ({ value, from: "closed scope" as const }))),
	wild: WILD_KINDS
})

describe("live, stale and wild values", () => {
	it.effect("draw every kind, and print without touching a hostile value", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"lsw kinds",
					{
						kind: "specification",
						name: "every kind of live, stale and wild value drawn, none touched in printing"
					},
					boundaryValue,
					required(DRAWN_FEATURES, { cases: 600, sense: notesOnly }),
					600
				),
				(value, c: Case<DrawnFeature<"closed scope">>) =>
					Effect.sync(() => {
						Formatter.format(value)
						c.note(drawnFeature(value))
					})
			)
		)
	)

	it.effect("shrink any case toward the simplest live value", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"lsw shrink",
					{ kind: "specification", name: "the simplest live value, as lsw orders its arms" },
					seeds,
					noCoverage,
					40
				),
				(seed) =>
					Effect.gen(function* () {
						const shrunk = yield* shrink(
							boundaryValue,
							fresh(boundaryValue, seed),
							() => Effect.succeed(true),
							completeShrink
						)
						deepStrictEqual(shrunk.best.failure, { kind: "live", value: 0 })
					})
			)
		)
	)

	it.effect("hand the boundary a proxy that refuses every operation", () =>
		Effect.gen(function* () {
			const hostile = passed({ kind: "wild", wild: wildOf("proxy") })
			const refused = yield* Effect.flip(
				Effect.try({
					try: () => String(hostile),
					catch: (thrown) => Option.liftPredicate(thrown, Schema.is(WildTouched))
				})
			)
			assertSome(refused, WildTouched.make({ kind: "proxy" }))
		})
	)

	it.effect("hand the boundary an object whose property throws when read", () =>
		Effect.gen(function* () {
			const hostile = passed({ kind: "wild", wild: wildOf("throwing-getter") })
			const refused = yield* Effect.flip(
				Effect.try({
					try: (): void => {
						structuredClone(hostile)
					},
					catch: (thrown) => Option.liftPredicate(thrown, Schema.is(WildTouched))
				})
			)
			assertSome(refused, WildTouched.make({ kind: "throwing-getter" }))
		})
	)
})

type Rule = "negative" | "unsorted" | "out of range"

/** `list` with the item at `at` made `item`. */
const withItem = (list: ReadonlyArray<number>, at: number, item: number) =>
	Arr.map(list, (current, index) => (index === at ? item : current))

/** Ways to break an ascending list of naturals: negate one item, swap two neighbours, or a rule no list can break. */
const CORRUPTIONS: Arr.NonEmptyReadonlyArray<Corruption<ReadonlyArray<number>, Rule, Rule>> = [
	{
		rule: "negative",
		from: "wild",
		weight: 3,
		sites: (live) =>
			Arr.map(live, (item, at) => ({
				value: withItem(live, at, -item - 1),
				refusal: "negative",
				at: `item ${at}`
			}))
	},
	{
		rule: "unsorted",
		from: "stale",
		weight: 1,
		sites: (live) =>
			Arr.map(Arr.drop(live, 1), (item, at) => ({
				value: withItem(withItem(live, at, item), at + 1, Arr.getUnsafe(live, at)),
				refusal: "unsorted",
				at: `item ${at + 1}`
			}))
	},
	{ rule: "out of range", from: "wild", weight: 5, sites: () => [] }
]

describe("corrupted artifacts", () => {
	it("break every rule that has a site, and only those", () => {
		deepStrictEqual(
			Arr.dedupe(Arr.map(everyValue(corrupted([1, 2, 3], CORRUPTIONS)), corruptedFeature)),
			["live", "wild negative", "stale unsorted"]
		)
	})

	it("draw the live artifact one time in six, each rule with a site by its weight, and each of its sites equally", () => {
		const cases = everyCase(corrupted([1, 2, 3], CORRUPTIONS))
		deepStrictEqual(
			[
				shareOf(cases, (drawnCase) => drawnCase.kind === "live"),
				shareOf(cases, (drawnCase) => corruptedFeature(drawnCase) === "wild negative"),
				shareOf(cases, (drawnCase) => corruptedFeature(drawnCase) === "stale unsorted"),
				shareOf(
					cases,
					(drawnCase) =>
						drawnCase.kind !== "live" && drawnCase.rule === "negative" && drawnCase.at === "item 0"
				)
			],
			[
				fraction(1n, 6n),
				fraction(5n * 3n, 6n * 4n),
				fraction(5n, 6n * 4n),
				fraction(5n * 3n, 6n * 4n * 3n)
			]
		)
	})

	it("draw an artifact no rule has a site in live, deciding nothing", () => {
		const generated = generate(corrupted([], CORRUPTIONS), simplestChooser)
		deepStrictEqual([generated.value, generated.tape.length], [{ kind: "live", value: [] }, 0])
	})
})

/** The shapes of pattern a suite draws names and literals from. */
const PATTERNS = [
	regex("^[A-Z][a-z]{1,8}$"),
	regex("^[a-z0-9]{1,6}(?:[_-][a-z0-9]{1,6}){0,3}$"),
	regex("^[0-9]{13}$|^[0-9]{15}$"),
	regex("^\\d\\.\\d$"),
	regex("^[a-zé]{28,36}$"),
	regex("^[^a-z]{2}$"),
	regex("^a?b{0,2}c$")
] as const

describe("a pattern", () => {
	it.effect("generates only strings it matches", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"matching",
					{ kind: "universal", name: "the pattern's own RegExp accepts every string it generates" },
					element(PATTERNS),
					noCoverage,
					200
				),
				(pattern, c) =>
					Effect.sync(() => {
						const text = c.draw(matching(pattern))
						assertTrue(pattern.test(text), `${text} matches ${pattern.source}`)
					})
			)
		)
	)

	it("shrinks to its shortest string, each class at its first character", () => {
		strictEqual(generate(matching(regex("^[A-Z][a-z]{1,8}$")), simplestChooser).value, "Aa")
	})

	it.effect("refuses a repetition without a bound, and what generation cannot honour", () =>
		Effect.gen(function* () {
			const refusals = yield* Effect.forEach(
				[regex("^a+$"), regex("^(a)\\1$"), regex("^\\bx$")],
				(pattern) =>
					Effect.flip(
						Effect.try({
							try: () => matching(pattern),
							catch: (thrown) => Option.liftPredicate(thrown, Schema.is(PatternRefused))
						})
					)
			)
			deepStrictEqual(Arr.map(refusals, Option.isSome), [true, true, true])
		})
	)
})

describe("a wide whole number", () => {
	it.effect("stays within a range wider than 2^32", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"wide ints",
					{ kind: "specification", name: "lo ≤ value ≤ hi, as int states" },
					boundsOf(int(-(2 ** 50), 2 ** 50)),
					noCoverage,
					200
				),
				([lo, hi], c) =>
					Effect.sync(() => {
						const value = c.draw(int(lo, hi))
						assertTrue(
							lo <= value && value <= hi && Number.isInteger(value),
							`${value} lies within ${lo}..${hi}`
						)
					})
			)
		)
	)
})
