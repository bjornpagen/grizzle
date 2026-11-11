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
	Result,
	Schema,
	String as Str
} from "effect"
import { type Enumerated, enumerated, firstBranch } from "#enumerate.ts"
import { type Case, drawn, type Exploration, exhaust, explore } from "#explore.ts"
import { type Coverage, noCoverage, required } from "#features.ts"
import {
	alphabet,
	array,
	boolean,
	clone,
	constant,
	element,
	type Gen,
	int,
	map,
	production,
	proportional,
	shuffled,
	unicodeScalar,
	uniqueArray,
	UniqueKeysExhausted,
	uniqueKeys
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
import { matching, PatternRefused } from "#pattern.ts"
import { wordsOf } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink, shrink } from "#shrink.ts"
import { generate, type Generated, randomChooser, recorder, simplestChooser } from "#source.ts"
import { keep, OMISSIONS, type Swarm, swarm, swarmChoice, weightOf } from "#swarm.ts"
import { bigint, double, doubleOrSpecial, float, uuid } from "#values.ts"
import { searched } from "#vitest/searched.ts"

const SEEDS = Arr.range(0, 3999)

/** A case drawn fresh from one seed. */
const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(recorder(), generator, randomChooser(wordsOf(seed)))

/** One fresh case per seed, as a random search draws them. */
const draws = <A>(generator: Gen<A>): ReadonlyArray<A> =>
	Arr.map(SEEDS, (seed) => fresh(generator, seed).value)

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

/** The first seed's fresh case that the predicate holds for. */
const firstFailing = <A>(generator: Gen<A>, fails: (value: A) => boolean): Generated<A> =>
	Option.getOrThrow(
		Arr.findFirst(
			Arr.map(SEEDS, (seed) => fresh(generator, seed)),
			(generated) => fails(generated.value)
		)
	)

/** The values of `wanted` a random search never drew, compared as `Object.is` compares, so -0 is not 0. */
const neverDrawn = <A>(values: ReadonlyArray<A>, wanted: ReadonlyArray<A>): ReadonlyArray<A> =>
	Arr.filter(wanted, (value) => !Arr.some(values, (seen) => Object.is(seen, value)))

/** This suite's budget for a property over `generator`. */
const searchOf = <A, F extends string>(
	suite: string,
	generator: Gen<A>,
	coverage: Coverage<F>,
	runs: number
): Exploration<A, A, F> => ({
	suite,
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
					generator: smallBounds,
					literal: Formatter.format,
					limit: 100,
					coverage: noCoverage,
					caseHang: Duration.minutes(1)
				},
				([lo, hi]) =>
					Effect.sync(() =>
						deepStrictEqual(allCases(int(lo, hi)), Arr.sort(Arr.range(lo, hi), byDistanceFromZero))
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
		deepStrictEqual(allCases(bigint(-3n, 4n)), [0n, 1n, -1n, 2n, -2n, 3n, -3n, 4n])
	})

	it.effect("stay within their range, however wide", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf("bigint bounds", boundsOf(bigint(-(2n ** 100n), 2n ** 100n)), noCoverage, 200),
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
				searchOf("float bounds", boundsOf(float(-FLOAT_MAX, FLOAT_MAX)), noCoverage, 200),
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

	it.effect("shrink toward a whole number", () =>
		Effect.gen(function* () {
			const generator = double(-1e9, 1e9)
			const fails = (value: number) => value > 10.25
			const shrunk = yield* shrink(
				generator,
				firstFailing(generator, fails),
				(value) => Effect.succeed(fails(value)),
				completeShrink
			)
			strictEqual(shrunk.best.failure, 11)
		})
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
				searchOf("uuid form", element([1, 2, 3, 4, 5, 6, 7, 8] as const), noCoverage, 100),
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
		strictEqual(
			generate(recorder(), uuid(7), simplestChooser).value,
			"00000000-0000-7000-8000-000000000000"
		)
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

	it.effect(
		"construct a unique array: no key repeated, no case given up, its length drawn unless the keys run out first, a length past the keys refused, and a repair that walks keys alone however large each item's tail",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"unique array",
						(source) => {
							const keys = source.draw(int(1, 6))
							const min = source.draw(int(0, 7))
							return {
								keys,
								projected: source.draw(boolean),
								size: { min, max: source.draw(int(min, 7)) },
								seed: source.draw(int(0, 0xffff_ffff))
							}
						},
						required<
							| "a key repeated and moved"
							| "every key used"
							| "a key moved beside a huge tail"
							| "a length past the keys refused"
						>(
							[
								"a key repeated and moved",
								"every key used",
								"a key moved beside a huge tail",
								"a length past the keys refused"
							],
							{ cases: 200, sense: notesOnly }
						),
						200
					),
					({ keys, projected, size, seed }, c) =>
						Effect.sync(() => {
							const generator = projected
								? map(
										uniqueArray(
											int(0, keys - 1),
											(key) => (source) => [key, source.draw(int(0, 2 ** 32 - 1))] as const,
											size
										),
										(pairs) => Arr.map(pairs, ([key]) => key)
									)
								: uniqueKeys(int(0, keys - 1), size)
							const drawnCase = Result.try(() => fresh(generator, seed))
							if (size.min > keys) {
								c.note("a length past the keys refused")
								deepStrictEqual(
									Result.match(drawnCase, {
										onSuccess: () => Option.none(),
										onFailure: (thrown) =>
											Schema.is(UniqueKeysExhausted)(thrown)
												? Option.some({ held: thrown.held, needed: thrown.needed })
												: Option.none()
									}),
									Option.some({ held: keys, needed: size.min })
								)
								return
							}
							const { value: items, tape } = Result.getOrThrow(drawnCase)
							const lengthAt = size.min < size.max ? 1 : 0
							const length = size.min < size.max ? (tape.values[0] ?? 0) : size.min
							const perItem = projected ? 2 : 1
							const candidates =
								keys > 1
									? Array.from(
											{ length: Math.min(length, items.length) },
											(_, at) => tape.values[lengthAt + perItem * at] ?? 0
										)
									: []
							if (Arr.dedupe(candidates).length < candidates.length) {
								c.note(projected ? "a key moved beside a huge tail" : "a key repeated and moved")
							}
							if (items.length === keys) {
								c.note("every key used")
							}
							deepStrictEqual(
								{
									status: tape.status === "discarded" ? "discarded" : "kept",
									distinct: Arr.dedupe(items).length === items.length,
									length: items.length
								},
								{ status: "kept", distinct: true, length: Math.min(length, keys) }
							)
						})
				)
			)
	)

	it.effect("draw a non-empty alphabet of every subset with each kept letter", (ctx) =>
		Effect.gen(function* () {
			const letters = ["a", "b", "c"] as const
			const exhausted = yield* searched(
				ctx,
				exhaust(
					{
						suite: "alphabet",
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

	it("draw production's constant five times in six", () => {
		const inForce = Arr.filter(draws(production(64, [1, 2])), (value) => value === 64).length
		assertTrue(inForce > 3200 && inForce < 3470, `about 3333 of 4000 draws are 64, not ${inForce}`)
	})
})

const FEATURES = ["a", "b", "c", "d", "e", "f"] as const

type Letter = (typeof FEATURES)[number]

describe("an element", () => {
	it("is one of a mixed list's own literals, every one in order when enumerated", () => {
		const statuses: Gen<429 | 503 | "timeout"> = element([429, 503, "timeout"])
		deepStrictEqual(allCases(statuses), [429, 503, "timeout"])
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
	it("draws each option in proportion to its weight, and never one of weight zero", () => {
		const drawnLetters = draws(
			proportional([
				[0, constant("never")],
				[3, constant("often")],
				[1, constant("seldom")]
			])
		)
		deepStrictEqual(neverDrawn(drawnLetters, ["never"]), ["never"])
		const often = Arr.filter(drawnLetters, (letter) => letter === "often").length
		assertTrue(
			often > 2700 && often < 3300,
			`three in four draws are the option of weight 3, not ${often} of 4000`
		)
	})

	it("draws its floor, and records no decision, when no option or only one has weight", () => {
		const floor = generate(
			recorder(),
			proportional([
				[0, constant("floor")],
				[0, constant("other")]
			]),
			simplestChooser
		)
		deepStrictEqual([floor.value, floor.tape.length], ["floor", 0])
		const alone = generate(
			recorder(),
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
	it("switch off half of the features, across the omissions", () => {
		const off = Arr.reduce(
			draws(swarm(FEATURES)),
			0,
			(sum, drawnSwarm) =>
				sum + Arr.filter(FEATURES, (feature) => weightOf(drawnSwarm, feature) === 0).length
		)
		const share = off / (SEEDS.length * FEATURES.length)
		assertTrue(share > 0.47 && share < 0.53, `about half of the features are off, not ${share}`)
	})

	it("draw a swarm under each omission", () => {
		deepStrictEqual(
			Arr.dedupe(
				Arr.map(
					allCases((source) => source.choose(0, OMISSIONS.length - 1)),
					(index) => Arr.getUnsafe(OMISSIONS, index)
				)
			),
			["five-sixths", "half", "one-sixth"]
		)
	})

	it("keep a feature at a third, two thirds or every place, by its weight", () => {
		deepStrictEqual(
			[
				allCases(keep({ a: 1 }, "a")),
				allCases(keep({ a: 2 }, "a")),
				allCases(keep({ a: 3 }, "a")),
				allCases(keep({}, "a"))
			],
			[[false, false, true], [false, true, true], [true], [false]]
		)
	})

	it("choose among the features that are on by weight, and the floor when none is", () => {
		const someOn: Swarm<Letter> = { b: 1, c: 2 }
		const noneOn: Swarm<Letter> = {}
		deepStrictEqual(
			[allCases(swarmChoice(someOn, ["a", "b", "c"])), allCases(swarmChoice(noneOn, ["a", "b"]))],
			[["b", "c", "c"], ["a"]]
		)
	})
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

	it.effect("shrink toward the simplest live value", () =>
		Effect.gen(function* () {
			const shrunk = yield* shrink(
				boundaryValue,
				firstFailing(boundaryValue, (value) => value.kind === "wild"),
				() => Effect.succeed(true),
				completeShrink
			)
			deepStrictEqual(shrunk.best.failure, { kind: "live", value: 0 })
		})
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
		sites: (live) =>
			Arr.map(Arr.drop(live, 1), (item, at) => ({
				value: withItem(withItem(live, at, item), at + 1, Arr.getUnsafe(live, at)),
				refusal: "unsorted",
				at: `item ${at + 1}`
			}))
	},
	{ rule: "out of range", from: "wild", sites: () => [] }
]

describe("corrupted artifacts", () => {
	it("break every rule that has a site, and only those", () => {
		deepStrictEqual(
			Arr.dedupe(Arr.map(allCases(corrupted([1, 2, 3], CORRUPTIONS)), corruptedFeature)),
			["live", "wild negative", "stale unsorted"]
		)
	})

	it("draw an artifact no rule has a site in live, deciding nothing", () => {
		const generated = generate(recorder(), corrupted([], CORRUPTIONS), simplestChooser)
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
			explore(searchOf("matching", element(PATTERNS), noCoverage, 200), (pattern, c) =>
				Effect.sync(() => {
					const text = c.draw(matching(pattern))
					assertTrue(pattern.test(text), `${text} matches ${pattern.source}`)
				})
			)
		)
	)

	it("shrinks to its shortest string, each class at its first character", () => {
		strictEqual(
			generate(recorder(), matching(regex("^[A-Z][a-z]{1,8}$")), simplestChooser).value,
			"Aa"
		)
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
				searchOf("wide ints", boundsOf(int(-(2 ** 50), 2 ** 50)), noCoverage, 200),
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
