/**
 * Tape mutation (mutate.ts): the same mutant from the same words, of a length its edits allow, replaying within every
 * decision's range. Oracle: stated in the search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/mutate-point-past-hi.patch (a point edit one past its decision's highest
 * value) turns the property red.
 */
import { describe, it } from "@effect/vitest"
import { assertTrue, deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { drawn, type Exploration, explore } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { array, boolean, element, type Gen, int, map, weighted } from "#gen.ts"
import { mutate } from "#mutate.ts"
import { wordsOf } from "#random.ts"
import { completeShrink } from "#shrink.ts"
import { generate, prefixChooser, randomChooser, recorder } from "#source.ts"
import type { Tape } from "#tape.ts"
import { searched } from "#vitest/searched.ts"

/** A generator with every structure a tape records: a dependent bound, collections, weighted arms and spans. */
const structured: Gen<unknown> = (source) => {
	const bound = source.draw(int(0, 6))
	return {
		items: source.draw(
			array(
				weighted([
					[1, int(0, bound)],
					[2, map(array(boolean, { min: 0, max: 3 }), (flags) => flags.length)]
				]),
				{ min: 0, max: 5 }
			)
		),
		label: source.draw(element(["a", "b", "c"]))
	}
}

/** A tape drawn fresh from a seed of `structured`. */
const tapeOf = (seed: number): Tape =>
	generate(recorder(), structured, randomChooser(wordsOf(seed))).tape

/** The lengths of a tape's spans of `label`. */
const spanLengths = (tape: Tape, label: string): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(tape.spanLabel.entries()), ([span, spanLabel]) =>
		spanLabel === label ? [(tape.spanEnd[span] ?? 0) - (tape.spanStart[span] ?? 0)] : []
	)

/**
 * The lengths a mutant of `seed` with `donor` may have, by the mutator's definition: its seed's, after point edits or
 * a span set simplest; any prefix of it, cut short; and its seed's less one span's decisions, the span deleted, plus
 * that span's again, repeated, or plus a span of the donor with the same label in its place.
 */
const lengthsOf = (seed: Tape, donor: Tape): ReadonlySet<number> => {
	const lengths = new Set<number>(Array.from({ length: seed.length + 1 }, (_, i) => i))
	for (const [span, label] of seed.spanLabel.entries()) {
		const own = (seed.spanEnd[span] ?? 0) - (seed.spanStart[span] ?? 0)
		lengths.add(seed.length - own)
		lengths.add(seed.length + own)
		for (const donated of spanLengths(donor, label)) {
			lengths.add(seed.length - own + donated)
		}
	}
	return lengths
}

const searchOf = <A>(suite: string, generator: Gen<A>): Exploration<A, A, never> => ({
	suite,
	oracle: { kind: "specification", name: "the mutator's edits and every decision's range" },
	draw: drawn(generator),
	literal: Formatter.format,
	coverage: noCoverage,
	kept: [],
	runs: 200,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

const seeds: Gen<Readonly<{ seed: number; donor: number; words: number }>> = (source) => ({
	seed: source.draw(int(0, 0xffff_ffff)),
	donor: source.draw(int(0, 0xffff_ffff)),
	words: source.draw(int(0, 0xffff_ffff))
})

describe("the tape mutator", () => {
	it.effect(
		"makes the same mutant from the same words, of a length its edits allow, that replays within every decision's range",
		(ctx) =>
			searched(
				ctx,
				explore(searchOf("tape mutator", seeds), ({ seed, donor, words }) =>
					Effect.sync(() => {
						const seedTape = tapeOf(seed)
						const donorTape = tapeOf(donor)
						const mutant = mutate(seedTape, Option.some(donorTape), wordsOf(words))
						const again = mutate(seedTape, Option.some(donorTape), wordsOf(words))
						deepStrictEqual(
							Arr.fromIterable(again.values.subarray(0, again.length)),
							Arr.fromIterable(mutant.values.subarray(0, mutant.length))
						)
						assertTrue(
							lengthsOf(seedTape, donorTape).has(mutant.length),
							`a mutant of ${mutant.length} decisions, of a seed of ${seedTape.length}`
						)
						const replayed = generate(
							recorder(),
							structured,
							prefixChooser(mutant.values, mutant.length, randomChooser(wordsOf(words)))
						).tape
						deepStrictEqual(
							{
								status: replayed.status !== "discarded",
								inRange: Arr.every(
									Arr.fromIterable(replayed.values.entries()),
									([at, value]) =>
										value >= (replayed.lo[at] ?? 0) && value <= (replayed.hi[at] ?? 0)
								)
							},
							{ status: true, inRange: true }
						)
					})
				)
			)
	)
})
