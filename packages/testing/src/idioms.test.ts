/**
 * The library's generators (gen.ts, values.ts, swarm.ts, lsw.ts, pattern.ts), each held to what its JSDoc promises,
 * every search stating its oracle: exact enumeration orders and spaces (an int's or a bigint's distance from zero, every
 * arrangement, subset, sorted list, tree and composition of a small box, each exactly once); ranges kept however wide;
 * doubles and floats within range, a whole failure shrinking to the least whole number, every special double reached;
 * UUIDs canonical, of their version and variant; a unique array distinct by construction; alphabets, twins, element
 * order and the scalar code points; exact shares by exact enumeration (production's five in six, proportional weights,
 * a swarm's omissions and presences, a swarm choice); live, stale and wild boundary values drawn, printed untouched and
 * handed as data where data; a corrupted value's live share and its rules' weights; and a pattern's strings matching
 * it.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants), each turning the property of its generator red:
 * int-order-sign-swapped, bigint-order-sign-swapped, int-wide-past-hi, double-past-max, float-past-max,
 * double-whole-shrink-lost, specials-without-negative-zero, uuid-variant-wrong, shuffled-repeats,
 * unique-array-unrepaired, alphabet-kept-last, clone-shares-object, production-four-in-five, element-reversed,
 * unicode-scalar-surrogates, proportional-zero-drawn, swarm-half-off, swarm-keep-at-weight-one-always,
 * ascending-repeats, parents-self, composition-past-total, lsw-proxy-touched (the lsw kinds and boundary data),
 * shrink-no-item-deletion (shrinking toward the simplest live value), corrupted-never-live, pattern-repeat-past-max.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Formatter,
	Option,
	Order,
	pipe,
	Record as Rec,
	Result,
	Schema,
	String as Str
} from "effect"
import { everyCase, everyValue, type Fraction, fraction, shareOf } from "#chance.fixtures.ts"
import { type Case, drawn, type Exploration, exhaust, explore, type Oracle } from "#explore.ts"
import { failureText } from "#failure.ts"
import { type Coverage, noCoverage, required } from "#features.ts"
import {
	alphabet,
	array,
	boolean,
	characterOf,
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
	string,
	subset,
	unicodeScalar,
	uniqueArray,
	type Weight,
	weighted
} from "#gen.ts"
import {
	type Corruption,
	corrupted,
	type DrawnFeature,
	drawnFeature,
	lsw,
	passed,
	WILD_KINDS,
	WILD_IS_DATA,
	WildTouched,
	wildOf
} from "#lsw.ts"
import { agree, exact, set, structuralHash } from "#oracle.ts"
import { matching, PatternRefused } from "#pattern.ts"
import { floorSeed, rotatingSeed, wordsOf } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink, shrink } from "#shrink.ts"
import {
	forcedChooser,
	type Generated,
	generate,
	prefixChooser,
	randomChooser,
	sample,
	simplestChooser
} from "#source.ts"
import {
	keep,
	type Presence,
	type Swarm,
	type SwarmWeight,
	swarm,
	swarmChoice,
	weightOf
} from "#swarm.ts"
import { bigint, double, doubleOrSpecial, float, uuid } from "#values.ts"
import { searched } from "#vitest/searched.ts"

/** A case drawn fresh from one seed. */
const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(generator, randomChooser(wordsOf(seed)))

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
})

describe("bigints", () => {
	it.effect("enumerate every range by distance from zero, the positive side first", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "bigint order",
					oracle: {
						kind: "specification",
						name: "bigint's order, int's: by distance from zero, the positive side first"
					},
					box: "every range of bigints within -5..5",
					generator: smallBounds,
					literal: Formatter.format,
					limit: 100,
					coverage: noCoverage,
					caseHang: Duration.minutes(1)
				},
				([lo, hi]) =>
					Effect.sync(() =>
						deepStrictEqual(
							everyValue(bigint(BigInt(lo), BigInt(hi))),
							Arr.map(Arr.sort(Arr.range(lo, hi), byDistanceFromZero), BigInt)
						)
					)
			)
		)
	)

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

/**
 * A generator whose values a random search must reach, the values code branches on: a range's ends, zero, -0 and the
 * special doubles, with the least chance per draw its documented rates give each of them.
 */
type Reaching = Readonly<{
	generator: Gen<unknown>
	values: ReadonlyArray<unknown>
	chance: number
}>

/** The kinds of generator the reach search draws. */
const REACHING_KINDS = ["int", "bigint", "double", "double or special"] as const

type ReachingKind = (typeof REACHING_KINDS)[number]

/**
 * The least chance a random search draws one of a wide decision's ends, or the value one step in from its high end: a
 * draw leans to an end one time in eight, to either end equally, at a distance whose bit width is uniform over the
 * range's own, so distance 0 has at least half of that width's chances and distance 1 a quarter.
 */
const leanedEnd = (span: number): number => 1 / (16 * (Math.floor(Math.log2(span + 1)) + 1))

/** What a reach case draws besides its kind: a range's width and side, a bigint's bit width, a double's bound. */
type ReachParameters = Readonly<{ width: number; side: number; bits: number; exponent: number }>

const reachParameters: Gen<ReachParameters> = (source) => ({
	width: source.draw(int(257, 2 ** 31 - 1)),
	side: source.draw(int(0, 2)),
	bits: source.draw(int(33, 70)),
	exponent: source.draw(int(0, 20))
})

/** A wide generator of each kind, and what it reaches, by the drawn parameters. */
const reaching = (
	kind: ReachingKind,
	{ width, side, bits, exponent }: ReachParameters
): Reaching => {
	switch (kind) {
		case "int": {
			const [lo, hi] = side === 0 ? [0, width] : side === 1 ? [-width, 0] : [-width, width]
			return {
				generator: int(lo, hi),
				values: Arr.dedupe([0, lo, hi]),
				chance: leanedEnd(hi - lo)
			}
		}
		case "bigint": {
			const lo = -(2n ** BigInt(bits))
			const hi = 2n ** BigInt(bits) - 1n
			return { generator: bigint(lo, hi), values: [lo, 0n, hi], chance: 1 / (8 * 2 * 33) }
		}
		case "double": {
			const bound = 2 ** exponent
			return {
				generator: double(-bound, bound),
				values: [-bound, -0, 0, bound],
				chance: Math.min(
					2 * bound + 1 <= 256 ? 1 / (4 * (2 * bound + 1)) : leanedEnd(2 * bound) / 4,
					(3 / 4) * (1 / 8) * (1 / 33) * (1 / 4)
				)
			}
		}
		case "double or special":
			return {
				generator: doubleOrSpecial(-1, 1),
				values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
				chance: 1 / (10 * 4)
			}
	}
}

/** How many draws make a miss of any one value less likely than e^-30, about 10^-13. */
const drawsFor = (chance: number): number => Math.ceil(30 / chance)

describe("a random search", () => {
	it.effect(
		"reaches the ends of a wide range, zero, -0 and every special double, from any seed",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"random reach",
						{
							kind: "specification",
							name: "each generator's documented rates: a value they give a chance of p per draw is missed by 30/p draws with probability below 10^-13"
						},
						(source) => ({
							kind: source.draw(element(REACHING_KINDS)),
							seed: source.draw(seeds),
							parameters: source.draw(reachParameters)
						}),
						required<ReachingKind>(REACHING_KINDS, { cases: 40, sense: notesOnly }),
						8
					),
					({ kind, seed, parameters }, c) =>
						Effect.sync(() => {
							c.note(kind)
							const { generator, values, chance } = reaching(kind, parameters)
							deepStrictEqual(
								neverDrawn(
									sample(
										generator,
										rotatingSeed(seed, floorSeed("random reach")),
										drawsFor(chance)
									),
									values
								),
								[]
							)
						})
				)
			)
	)
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
						deepStrictEqual(
							{
								version: pipe(value, Str.slice(14, 15)),
								simplest: generate(uuid(version), simplestChooser).value
							},
							{
								version: `${version}`,
								simplest: `00000000-0000-${version}000-8000-000000000000`
							}
						)
					})
			)
		)
	)
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

	it.effect(
		"construct a unique array: no key repeated, no case given up, its length drawn unless the keys run out first, and a length past the keys refused",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"unique array",
						{
							kind: "specification",
							name: "distinct keys by construction: the drawn length, or every key where fewer remain, never a discard"
						},
						(source) => {
							const keys = source.draw(int(1, 6))
							const min = source.draw(int(0, 7))
							return {
								keys,
								projected: source.draw(boolean),
								size: { min, max: source.draw(int(min, 7)) },
								seed: source.draw(seeds)
							}
						},
						required<
							| "a key repeated and moved"
							| "every key used"
							| "a key moved by a projection"
							| "a length past the keys refused"
						>(
							[
								"a key repeated and moved",
								"every key used",
								"a key moved by a projection",
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
											(source) => [source.draw(int(0, keys - 1)), source.draw(int(0, 2))] as const,
											([first]) => first,
											size
										),
										(pairs) => Arr.map(pairs, ([first]) => first)
									)
								: uniqueArray(int(0, keys - 1), (value) => value, size)
							const drawnCase = Result.try(() => fresh(generator, seed))
							if (size.min > keys) {
								c.note("a length past the keys refused")
								strictEqual(Result.isFailure(drawnCase), true)
								return
							}
							const { value: items, tape } = Result.getOrThrow(drawnCase)
							const lengthAt = size.min < size.max ? 1 : 0
							const length = size.min < size.max ? (tape.values[0] ?? 0) : size.min
							const perItem = projected ? 2 : 1
							const candidates =
								keys > 1
									? Arr.makeBy(
											Math.min(length, items.length),
											(at) => tape.values[lengthAt + perItem * at] ?? 0
										)
									: []
							if (Arr.dedupe(candidates).length < candidates.length) {
								c.note(projected ? "a key moved by a projection" : "a key repeated and moved")
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

	it.effect("make twins equal by structure that share no object", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"clone",
					{
						kind: "specification",
						name: "every twin equal to the first by structure, and no object of one reachable from another"
					},
					(source) => ({ count: source.draw(int(1, 4)), seed: source.draw(seeds) }),
					required<"one twin" | "several twins">(["one twin", "several twins"], {
						cases: 40,
						sense: notesOnly
					}),
					100
				),
				({ count, seed }, c) =>
					Effect.sync(() => {
						c.note(count === 1 ? "one twin" : "several twins")
						const twins = fresh(
							clone(
								array(
									map(array(int(0, 9), { min: 0, max: 3 }), (values) => ({ values })),
									{ min: 0, max: 4 }
								),
								count
							),
							seed
						).value
						const objectsOf = (
							twin: ReadonlyArray<Readonly<{ values: ReadonlyArray<number> }>>
						) => [twin, ...Arr.flatMap(twin, (item) => [item, item.values])]
						const owned = Arr.map(twins, (twin) => new Set<object>(objectsOf(twin)))
						deepStrictEqual(
							{
								twins,
								shared: Arr.some(owned, (objects, at) =>
									Arr.some(Arr.drop(owned, at + 1), (later) =>
										Arr.some(Arr.fromIterable(objects), (object) => later.has(object))
									)
								)
							},
							{ twins: Arr.makeBy(count, () => Arr.getUnsafe(twins, 0)), shared: false }
						)
					})
			)
		)
	)

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

/** A feature's weight in a swarm: off, or present at one to three thirds. */
const swarmWeightGen: Gen<SwarmWeight> = element([0, 1, 2, 3] as const)

/**
 * The chance a swarm turns off a feature other than its forced one, from the omissions' definition: five-sixths,
 * half and one-sixth, each drawn a third of the time, so 1/2.
 */
const OFF_RATE: Fraction = fraction(5n + 3n + 1n, 3n * 6n)

/** A literal a mixed list may hold: a small whole number or a short string. */
const mixedLiteral: Gen<number | string> = oneOf<number | string>([
	int(0, 999),
	string(characterOf(["a", "b", "z"]), { min: 0, max: 2 })
])

describe("an element", () => {
	it.effect("is one of its list's own literals, every place in order when enumerated", (ctx) =>
		searched(
			ctx,
			explore(
				searchOf(
					"element order",
					{ kind: "specification", name: "the list itself, each place once, in order" },
					(source) => ({
						first: source.draw(mixedLiteral),
						rest: source.draw(array(mixedLiteral, { min: 0, max: 5 }))
					}),
					required<"one literal" | "numbers and strings mixed" | "a literal repeated">(
						["one literal", "numbers and strings mixed", "a literal repeated"],
						{ cases: 200, sense: notesOnly }
					),
					200
				),
				({ first, rest }, c) =>
					Effect.sync(() => {
						const list = Arr.prepend(rest, first)
						if (list.length === 1) {
							c.note("one literal")
						}
						if (
							Arr.some(list, (item) => typeof item === "number") &&
							Arr.some(list, (item) => typeof item === "string")
						) {
							c.note("numbers and strings mixed")
						}
						if (Arr.dedupe(list).length < list.length) {
							c.note("a literal repeated")
						}
						deepStrictEqual(everyValue(element(list)), list)
					})
			)
		)
	)
})

/** The surrogate code points, which no scalar is, and the last scalar's index: the places unicodeScalar branches at. */
const SURROGATE_FIRST = 0xd8_00

const SURROGATE_COUNT = 0x8_00

const LAST_SCALAR_INDEX = 0x10_ff_ff - SURROGATE_COUNT

/** The indexes unicodeScalar's mapping turns at: the ends of the scalars below the surrogates and above them. */
const SCALAR_TURNS = [0, SURROGATE_FIRST - 1, SURROGATE_FIRST, LAST_SCALAR_INDEX] as const

describe("unicode scalars", () => {
	it.effect(
		"map every index of their decision onto a scalar, in order, skipping the surrogates and reaching the last plane",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"unicode scalars",
						{
							kind: "second-implementation",
							name: "index i is the scalar i below the surrogates and i + 0x800 above them"
						},
						oneOf([int(0, LAST_SCALAR_INDEX), element(SCALAR_TURNS)]),
						required<"below the surrogates" | "past the surrogates" | "beyond the basic plane">(
							["below the surrogates", "past the surrogates", "beyond the basic plane"],
							{ cases: 200, sense: notesOnly }
						),
						400
					),
					(index, c) =>
						Effect.sync(() => {
							const scalar = index < SURROGATE_FIRST ? index : index + SURROGATE_COUNT
							c.note(
								scalar < SURROGATE_FIRST
									? "below the surrogates"
									: scalar <= 0xff_ff
										? "past the surrogates"
										: "beyond the basic plane"
							)
							deepStrictEqual(
								generate(unicodeScalar, forcedChooser(Float64Array.of(index), 1)).value,
								String.fromCodePoint(scalar)
							)
						})
				)
			)
	)
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
						required<
							"a weight of zero" | "a total past 256" | "no weight at all" | "one weight alone"
						>(["a weight of zero", "a total past 256", "no weight at all", "one weight alone"], {
							cases: 200,
							sense: notesOnly
						}),
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
							const weighed = Arr.filter(weights, (weight) => weight > 0).length
							if (weighed === 1) {
								c.note("one weight alone")
							}
							const cases = everyCase(
								proportional(
									nonEmpty(Arr.map(weights, (weight, at) => [weight, constant(at)] as const))
								)
							)
							deepStrictEqual(
								{
									shares: Arr.map(weights, (_weight, at) =>
										shareOf(cases, (drawnAt) => drawnAt === at)
									),
									decides: Arr.map(cases, (drawnCase) => drawnCase.tape.length > 0)
								},
								{
									shares: Arr.map(weights, (weight, at): Fraction =>
										total === 0
											? fraction(at === 0 ? 1n : 0n, 1n)
											: fraction(BigInt(weight), BigInt(total))
									),
									decides: Arr.map(cases, () => weighed > 1)
								}
							)
						})
				)
			)
	)
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

	it.effect(
		"keep a feature at the third of its places its weight says, and choose among those on by weight, the floor when none is",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "swarm weights",
						oracle: {
							kind: "specification",
							name: "keep's share weight/3 and a choice's share weight/total among those on, by exact enumeration"
						},
						box: "every weight of 0 to 3 for each of a, b and c, against every choice among an alphabet of them",
						generator: (source) => ({
							weights: {
								a: source.draw(swarmWeightGen),
								b: source.draw(swarmWeightGen),
								c: source.draw(swarmWeightGen)
							},
							options: source.draw(alphabet<Letter>(["a", "b", "c"]))
						}),
						literal: Formatter.format,
						limit: 2000,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					({ weights, options }) =>
						Effect.sync(() => {
							const drawnSwarm: Swarm<Letter> = Rec.filter(
								weights,
								(weight): weight is Presence => weight > 0
							)
							const on = Arr.filter(options, (option) => weights[option] > 0)
							const total = Arr.reduce(on, 0, (sum, option) => sum + weights[option])
							const choices = everyCase(swarmChoice(drawnSwarm, options))
							deepStrictEqual(
								{
									kept: Arr.map(options, (feature) =>
										shareOf(everyCase(keep(drawnSwarm, feature)), (kept) => kept)
									),
									chosen: Arr.map(options, (option) =>
										shareOf(choices, (chosen) => chosen === option)
									),
									decides: Arr.map(choices, (choice) => choice.tape.length > 0)
								},
								{
									kept: Arr.map(options, (feature) => fraction(BigInt(weights[feature]), 3n)),
									chosen: Arr.map(options, (option, at) =>
										total === 0
											? fraction(at === 0 ? 1n : 0n, 1n)
											: fraction(BigInt(weights[option] > 0 ? weights[option] : 0), BigInt(total))
									),
									decides: Arr.map(choices, () => on.length > 1)
								}
							)
						})
				)
			)
	)
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
								set(structuralHash, exact)
							)
							yield* agree(
								[
									["nondecreasing", everyValue(nondecreasing(lo, hi, size))],
									[
										"model",
										width === 0 ? (size.min === 0 ? [[]] : []) : ascendingModel(lo, hi, size, 0)
									]
								],
								set(structuralHash, exact)
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
								set(structuralHash, exact)
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
							set(structuralHash, exact)
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
							set(structuralHash, exact)
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

	it.effect(
		"hand the boundary data of every kind but two, which refuse to have their properties read, each by its own kind",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "wild data",
						oracle: {
							kind: "second-implementation",
							name: "a walk of the value's own property descriptors, which runs none of its code"
						},
						box: "the simplest wild value of every kind",
						generator: map(element(WILD_KINDS), wildOf),
						literal: Formatter.format,
						limit: 32,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(wildValue) =>
						Effect.sync(() => {
							const handed = passed({ kind: "wild", wild: wildValue })
							const asData = Result.try(() => {
								const target = new Object(handed)
								return Arr.map(Reflect.ownKeys(target), (key): unknown => Reflect.get(target, key))
							})
							const thrown = Option.flatMap(Result.getFailure(asData), (failure) =>
								Schema.is(WildTouched)(failure) ? Option.some(failure) : Option.none()
							)
							const touched = Option.map(thrown, (failure) => failure.touch.kind)
							deepStrictEqual(
								{ data: WILD_IS_DATA[wildValue.kind], touched },
								{
									data: isData(handed),
									touched: isData(handed) ? Option.none() : Option.some(wildValue.kind)
								}
							)
							deepStrictEqual(
								Option.map(thrown, (failure) => {
									const report = failureText(Cause.die(failure))
									return {
										said: failure.message !== "",
										data: Str.includes(Formatter.format(failure.touch))(report),
										message: Str.includes(failure.message)(report)
									}
								}),
								Option.map(thrown, () => ({ said: true, data: true, message: true }))
							)
						})
				)
			)
	)
})

/**
 * Whether a value is data, judged without running any of its code: a primitive, or an object whose own properties are
 * all data properties holding data, read through their descriptors. A proxy that refuses every operation refuses this
 * reading too, and is no data.
 */
const isData = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return true
	}
	const descriptors = Result.try(() =>
		Arr.map(Reflect.ownKeys(value), (key) => Reflect.getOwnPropertyDescriptor(value, key))
	)
	return (
		Result.isSuccess(descriptors) &&
		Arr.every(
			descriptors.success,
			(descriptor) => descriptor !== undefined && "value" in descriptor && isData(descriptor.value)
		)
	)
}

type Rule = "negative" | "unsorted" | "out of range"

/** `list` with the item at `at` made `item`. */
const withItem = (list: ReadonlyArray<number>, at: number, item: number) =>
	Arr.map(list, (current, index) => (index === at ? item : current))

/**
 * Ways to break an ascending list of naturals, at the drawn weights: negate one item, swap two neighbours, or a rule no
 * list can break, which has no site in any list.
 */
const corruptionsOf = (
	weights: Readonly<Record<Rule, Weight>>
): Arr.NonEmptyReadonlyArray<Corruption<ReadonlyArray<number>, Rule, Rule>> => [
	{
		rule: "negative",
		from: "wild",
		weight: weights.negative,
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
		weight: weights.unsorted,
		sites: (live) =>
			Arr.map(Arr.drop(live, 1), (item, at) => ({
				value: withItem(withItem(live, at, item), at + 1, Arr.getUnsafe(live, at)),
				refusal: "unsorted",
				at: `item ${at + 1}`
			}))
	},
	{ rule: "out of range", from: "wild", weight: weights["out of range"], sites: () => [] }
]

/** How many sites each rule has in a list of `length` items: one per item, one per neighbouring pair, and none. */
const sitesIn = (rule: Rule, length: number): number => {
	switch (rule) {
		case "negative":
			return length
		case "unsorted":
			return Math.max(0, length - 1)
		case "out of range":
			return 0
	}
}

const RULES = ["negative", "unsorted", "out of range"] as const satisfies ReadonlyArray<Rule>

/** The weights a corruption is drawn at: one, a few and many times another's. */
const RULE_WEIGHTS = [1, 2, 3, 5, 9] as const satisfies ReadonlyArray<Weight>

const ruleWeight: Gen<Weight> = element(RULE_WEIGHTS)

describe("corrupted artifacts", () => {
	it.effect(
		"draw the live artifact one time in six, each rule with a site by its weight among those, each of its sites equally, and an artifact no rule has a site in live without a decision",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"corrupted shares",
						{
							kind: "specification",
							name: "corrupted's rates: 1/6 live, then each applicable rule by weight, each site equally, by exact enumeration"
						},
						(source) => ({
							live: source.draw(increasing(0, 9, { min: 0, max: 4 })),
							weights: {
								negative: source.draw(ruleWeight),
								unsorted: source.draw(ruleWeight),
								"out of range": source.draw(ruleWeight)
							}
						}),
						required<"no rule has a site" | "one rule has a site" | "two rules have sites">(
							["no rule has a site", "one rule has a site", "two rules have sites"],
							{ cases: 100, sense: notesOnly }
						),
						100
					),
					({ live, weights }, c) =>
						Effect.sync(() => {
							const applicable = Arr.filter(RULES, (rule) => sitesIn(rule, live.length) > 0)
							c.note(
								applicable.length === 0
									? "no rule has a site"
									: applicable.length === 1
										? "one rule has a site"
										: "two rules have sites"
							)
							const total = Arr.reduce(applicable, 0, (sum, rule) => sum + weights[rule])
							const cases = everyCase(corrupted(live, corruptionsOf(weights)))
							const siteShare = (rule: Rule, at: number): Fraction =>
								Arr.contains(applicable, rule) && at < sitesIn(rule, live.length)
									? fraction(
											5n * BigInt(weights[rule]),
											6n * BigInt(total) * BigInt(sitesIn(rule, live.length))
										)
									: fraction(0n, 1n)
							const siteOf = (rule: Rule, at: number) => `item ${rule === "unsorted" ? at + 1 : at}`
							deepStrictEqual(
								{
									live: shareOf(cases, (drawnCase) => drawnCase.kind === "live"),
									sites: Arr.map(RULES, (rule) =>
										Arr.map(Arr.range(0, 4), (at) =>
											shareOf(
												cases,
												(drawnCase) =>
													drawnCase.kind !== "live" &&
													drawnCase.rule === rule &&
													drawnCase.at === siteOf(rule, at)
											)
										)
									),
									decides: Arr.some(cases, (drawnCase) => drawnCase.tape.length > 0)
								},
								{
									live: applicable.length === 0 ? fraction(1n, 1n) : fraction(1n, 6n),
									sites: Arr.map(RULES, (rule) =>
										Arr.map(Arr.range(0, 4), (at) => siteShare(rule, at))
									),
									decides: applicable.length > 0
								}
							)
						})
				)
			)
	)
})

/** The shapes of pattern a suite draws names and literals from. */
const PATTERNS = [
	regex("^[A-Z][a-z]{1,8}$"),
	regex("^[a-z0-9]{1,6}(?:[_-][a-z0-9]{1,6}){0,3}$"),
	regex("^[0-9]{13}$|^[0-9]{15}$"),
	regex("^\\d\\.\\d$"),
	regex("^[a-zé]{28,36}$"),
	regex("^[^a-z]{2}$"),
	regex("^a?b{0,2}c$"),
	regex("^[\t\n\r -\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]{0,8}$", "u"),
	regex.as("^\\x41\\u0042[\\u{1F600}-\\u{1F64F}]{1,2}$", "u")
] as const

/** A class as written: whether it is negated, and its items, each a character or a range from its low end to its high,
 * drawn from one window of letters or one of astral characters, so no item writes `]`, `\`, `^` or `-`. */
type WrittenClass = Readonly<{
	negated: boolean
	items: ReadonlyArray<readonly [low: number, high: number]>
}>

const classItem: Gen<readonly [low: number, high: number]> = (source) => {
	const [lo, hi] = source.draw(
		element([
			[0x61, 0x66],
			[0x1f600, 0x1f605]
		] as const)
	)
	const first = source.draw(int(lo, hi))
	const second = source.draw(int(lo, hi))
	return first <= second ? [first, second] : [second, first]
}

const writtenClass: Gen<WrittenClass> = (source) => ({
	negated: source.draw(element([false, true])),
	items: source.draw(array(classItem, { min: 1, max: 4 }))
})

/** A class as its pattern writes it, brackets and all. */
const classBody = (written: WrittenClass): string =>
	`[${written.negated ? "^" : ""}${Arr.join(
		Arr.map(written.items, ([low, high]) =>
			low === high
				? String.fromCodePoint(low)
				: `${String.fromCodePoint(low)}-${String.fromCodePoint(high)}`
		),
		""
	)}]`

/** The source of a class's one-character pattern. */
const classSource = (written: WrittenClass): string => `^${classBody(written)}$`

/** The class written out: each member at the place it is first written, or, negated, the printable characters it
 * leaves, in order. */
const writtenOut = (written: WrittenClass): ReadonlyArray<string> => {
	const members = Arr.dedupe(Arr.flatMap(written.items, ([low, high]) => Arr.range(low, high)))
	const points = written.negated
		? Arr.filter(Arr.range(0x20, 0x7e), (point) => !Arr.contains(members, point))
		: members
	return Arr.map(points, (point) => String.fromCodePoint(point))
}

/**
 * The constructs generation cannot honour, each one `matching` refuses rather than guess at: a repetition without a
 * bound, a backreference, a word boundary and a Unicode property.
 */
const UNHONOURED = ["a+", "a*", "a{2,}", "(a)\\1", "\\bx", "\\p{L}"] as const

/** One piece of a drawn pattern: a class repeated within bounds, a letter, an optional letter, or a construct refused. */
type PatternPiece =
	| Readonly<{ kind: "class"; written: WrittenClass; min: number; max: number }>
	| Readonly<{ kind: "literal"; letter: string }>
	| Readonly<{ kind: "option"; letter: string }>
	| Readonly<{ kind: "unhonoured"; construct: (typeof UNHONOURED)[number] }>

const patternPiece: Gen<PatternPiece> = weighted<PatternPiece>([
	[
		3,
		(source) => {
			const min = source.draw(int(0, 2))
			return {
				kind: "class",
				written: source.draw(writtenClass),
				min,
				max: source.draw(int(min, 3))
			}
		}
	],
	[2, map(characterOf(["q", "r"]), (letter) => ({ kind: "literal", letter }))],
	[1, map(characterOf(["x", "y"]), (letter) => ({ kind: "option", letter }))],
	[1, map(element(UNHONOURED), (construct) => ({ kind: "unhonoured", construct }))]
])

/** A piece as the pattern writes it. */
const pieceSource = (piece: PatternPiece): string => {
	switch (piece.kind) {
		case "class":
			return `${classBody(piece.written)}{${piece.min},${piece.max}}`
		case "literal":
			return piece.letter
		case "option":
			return `${piece.letter}?`
		case "unhonoured":
			return piece.construct
	}
}

/** The shortest string a piece matches, by the grammar: a class's first member at its least repetition, and no option. */
const shortestOf = (piece: PatternPiece): string => {
	switch (piece.kind) {
		case "class":
			return Str.repeat(piece.min)(Arr.getUnsafe(writtenOut(piece.written), 0))
		case "literal":
			return piece.letter
		case "option":
		case "unhonoured":
			return ""
	}
}

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

	it.effect(
		"draws each member of a class by its index, where the class written out holds it",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"pattern classes",
						{
							kind: "second-implementation",
							name: "the class written out, each member at the place it is first written"
						},
						writtenClass,
						noCoverage,
						200
					),
					(written) =>
						Effect.sync(() => {
							const pattern = regex.as(classSource(written), "u")
							const expected = writtenOut(written)
							const byIndex = Arr.map(
								Arr.range(0, expected.length - 1),
								(index) =>
									generate(matching(pattern), forcedChooser(Float64Array.of(index), 1)).value
							)
							deepStrictEqual(byIndex, expected)
							assertTrue(
								Arr.every(byIndex, (text) => pattern.test(text)),
								classSource(written)
							)
						})
				)
			)
	)

	it.effect(
		"generates from what it can honour, shortest first, each class at its first member, and refuses every pattern holding what it cannot",
		(ctx) =>
			searched(
				ctx,
				explore(
					searchOf(
						"pattern pieces",
						{
							kind: "specification",
							name: "matching's grammar: bounded classes, literals and options shrink to their minimum, each class at the member it writes first; an unbounded repetition, a backreference, a boundary or a property is refused"
						},
						array(patternPiece, { min: 1, max: 3 }),
						required<"refused" | "generated" | "a negated class" | "an option">(
							["refused", "generated", "a negated class", "an option"],
							{ cases: 200, sense: notesOnly }
						),
						200
					),
					(pieces, c) =>
						Effect.sync(() => {
							const source = `^${Arr.join(Arr.map(pieces, pieceSource), "")}$`
							const unhonoured = Arr.some(pieces, (piece) => piece.kind === "unhonoured")
							c.note(unhonoured ? "refused" : "generated")
							if (Arr.some(pieces, (piece) => piece.kind === "class" && piece.written.negated)) {
								c.note("a negated class")
							}
							if (Arr.some(pieces, (piece) => piece.kind === "option")) {
								c.note("an option")
							}
							const pattern = regex.as(source, "u")
							const generated = Result.try(() => generate(matching(pattern), simplestChooser).value)
							deepStrictEqual(
								{
									refused:
										Result.isFailure(generated) && Schema.is(PatternRefused)(generated.failure),
									shortest: Result.getSuccess(generated)
								},
								{
									refused: unhonoured,
									shortest: unhonoured
										? Option.none()
										: Option.some(Arr.join(Arr.map(pieces, shortestOf), ""))
								}
							)
						})
				)
			)
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
