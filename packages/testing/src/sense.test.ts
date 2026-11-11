/**
 * Block coverage as a sense (sense.ts v8Coverage): a fresh sense perceives exactly what its own case did, whatever
 * senses read the file before it, every case running one block and skipping another. Oracle: universal, stated in the
 * search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/sense-v8-blind.patch (a trace of nothing) turns the property red.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order, String as Str } from "effect"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, boolean } from "#gen.ts"
import { notesOnly, v8Coverage } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** Takes its branch only when told to. */
const branch = (taken: boolean): number => {
	if (taken) {
		return 1
	}
	return 0
}

/** What a fresh sense, opened and closed around one case, perceives of this file while the case takes the branch or not. */
const perceivedOnce = (taken: boolean) =>
	Effect.scoped(
		Effect.gen(function* () {
			const sense = yield* v8Coverage(Str.endsWith("/sense.test.ts"))
			const [, trace] = yield* sense.perceive(Effect.sync(() => branch(taken)))
			return Arr.fromIterable(trace)
		})
	)

/** The distinct classes a trace holds, beside the zero of ranges it did not report. */
const classesOf = (trace: ReadonlyArray<number>) =>
	Arr.sort(Arr.dedupe(Arr.filter(trace, (traced) => traced !== 0)), Order.Number)

describe("a guided file's block coverage", () => {
	it.effect(
		"perceives in each fresh sense exactly what its own case did, whatever senses read the file before it",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "sense independence",
						oracle: {
							kind: "universal",
							name: "a trace is a function of its case alone, and every case runs one block and skips another"
						},
						draw: drawn(array(boolean, { min: 2, max: 5 })),
						literal: Formatter.format,
						coverage: required<
							"a skip after a take" | "a take after a skip" | "two skips in a row"
						>(["a skip after a take", "a take after a skip", "two skips in a row"], {
							cases: 40,
							sense: notesOnly
						}),
						kept: [],
						runs: 20,
						shrink: boundedShrink(20),
						concurrency: 1,
						steerEvery: 10,
						caseHang: Duration.seconds(30)
					},
					(takes, c) =>
						Effect.gen(function* () {
							Arr.forEach(Arr.zip(takes, Arr.drop(takes, 1)), ([before, after]) => {
								if (before && !after) {
									c.note("a skip after a take")
								}
								if (!before && after) {
									c.note("a take after a skip")
								}
								if (!before && !after) {
									c.note("two skips in a row")
								}
							})
							const traces = yield* Effect.forEach(takes, perceivedOnce)
							const firstOf = (taken: boolean) =>
								Arr.findFirst(traces, (_trace, at) => Arr.getUnsafe(takes, at) === taken)
							deepStrictEqual(
								{
									classes: Arr.map(traces, classesOf),
									traces: Arr.map(traces, (trace) => Option.some(trace))
								},
								{
									classes: Arr.map(traces, () => [1, 2]),
									traces: Arr.map(takes, (taken) => firstOf(taken))
								}
							)
						})
				)
			)
	)
})
