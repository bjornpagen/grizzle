import { Array as Arr, Duration, Effect, Formatter, Option } from "effect"
import { describe, it } from "vitest"
import { count } from "#enumerate.ts"
import { drawn, explore, noDeadline, Run } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { array, boolean, type Gen, int, weighted } from "#gen.ts"
import { wordsOf } from "#random.ts"
import { boundedShrink, completeShrink, shrink } from "#shrink.ts"
import { forcedChooser, generate, randomChooser, recorder } from "#source.ts"

/** A generator shaped like a real suite's: a dependent bound, a collection and weighted branches. */
const composite: Gen<unknown> = (source) => {
	const bound = source.draw(int(0, 8))
	return {
		bound,
		items: source.draw(
			array(
				weighted([
					[1, int(0, bound)],
					[3, int(10, 2000)]
				]),
				{ min: 0, max: 16 }
			)
		),
		flag: source.draw(boolean)
	}
}

/** The recorder every case of the benchmarks is drawn on, as a search holds one for all its cases. */
const recorded = recorder()

const sampled = generate(recorded, composite, randomChooser(wordsOf(99)))

const run = Run.of({
	seed: 7,
	source: "environment",
	replay: Option.none(),
	fuzz: Option.none(),
	deadline: noDeadline
})

/** An exploration of 125 cases of `composite` whose property costs what `property` costs. */
const explored = (concurrency: number, property: () => Effect.Effect<void>) =>
	Effect.runPromise(
		explore(
			{
				suite: "bench",
				draw: drawn(composite),
				literal: Formatter.format,
				coverage: noCoverage,
				kept: [],
				runs: 100,
				shrink: boundedShrink(500),
				concurrency,
				steerEvery: 64,
				caseHang: Duration.minutes(1)
			},
			property
		).pipe(Effect.provideService(Run, run))
	)

describe("the engine", () => {
	it("generates, replays, enumerates and shrinks", ({ bench }) =>
		bench.compare(
			bench("generate a case from a fresh stream", () => {
				generate(recorded, composite, randomChooser(wordsOf(1)))
			}),
			bench("replay a case from its tape", () => {
				generate(recorded, composite, forcedChooser(sampled.tape.values, sampled.tape.length))
			}),
			bench("enumerate 1111 cases", () => {
				count(array(int(0, 9), { min: 0, max: 3 }), 2000)
			}),
			bench("shrink a failing collection to its threshold", () => {
				const items = array(int(0, 1000), { min: 0, max: 10 })
				const failing = generate(
					recorded,
					items,
					forcedChooser(Float64Array.of(6, 3, 900, 12, 700, 5, 800), 7)
				)
				return Effect.runPromise(
					shrink(
						items,
						failing,
						(values) => Effect.succeed(Arr.some(values, (value) => value >= 500)),
						completeShrink
					)
				)
			})
		))

	it("costs a fraction of the code it runs", ({ bench }) =>
		bench.compare(
			bench("explore 125 cases, the property does nothing", () => explored(1, () => Effect.void)),
			bench("explore 125 cases, 16 at once, the property does nothing", () =>
				explored(16, () => Effect.void)),
			bench("explore 125 cases, the property waits a microtask", () =>
				explored(1, () => Effect.promise(() => Promise.resolve())))
		))
})
