/**
 * Awaiting a fact (fact.ts awaitFact): the value returned holds the fact and lies within what concurrent fibers made
 * true, waiting on no timer. Oracle: the specification, stated in the search.
 *
 * Plant: ~/.cache/grizzle-release/BR07/plants/fact-returns-early.patch (the fact read twice at most) turns the property
 * red.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Duration, Effect, Formatter, Option, Ref } from "effect"
import { drawn, explore } from "#explore.ts"
import { awaitFact } from "#fact.ts"
import { required } from "#features.ts"
import { int } from "#gen.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/**
 * A fact a concurrent fiber makes true: `fibers` fibers each count up `steps` times, and the wait asks for a count of at
 * least `threshold`, at most what they reach together.
 */
type Counting = Readonly<{ fibers: number; steps: number; threshold: number }>

describe("awaiting a fact", () => {
	it.effect(
		"returns a value the fact holds of, within what concurrent fibers made true, waiting on no timer",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "awaited fact",
						oracle: {
							kind: "specification",
							name: "the value returned holds the fact and lies within what the fibers counted, the clock unmoved"
						},
						draw: drawn((source): Counting => {
							const fibers = source.draw(int(1, 3))
							const steps = source.draw(int(0, 100))
							return { fibers, steps, threshold: source.draw(int(0, fibers * steps)) }
						}),
						literal: Formatter.format,
						coverage: required<"true from the start" | "true only at the end" | "several fibers">(
							["true from the start", "true only at the end", "several fibers"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: boundedShrink(100),
						concurrency: 1,
						steerEvery: 25,
						caseHang: Duration.seconds(30)
					},
					({ fibers, steps, threshold }, c) =>
						Effect.gen(function* () {
							const total = fibers * steps
							if (threshold === 0) {
								c.note("true from the start")
							}
							if (threshold === total && total > 0) {
								c.note("true only at the end")
							}
							if (fibers > 1) {
								c.note("several fibers")
							}
							const count = yield* Ref.make(0)
							const countUp = Effect.gen(function* () {
								for (let step = 0; step < steps; step += 1) {
									yield* Ref.update(count, (n) => n + 1)
								}
							})
							for (let fiber = 0; fiber < fibers; fiber += 1) {
								yield* Effect.forkChild(countUp)
							}
							const reached = yield* awaitFact(
								Effect.map(Ref.get(count), (n) => (n >= threshold ? Option.some(n) : Option.none()))
							)
							deepStrictEqual(
								{ holds: reached >= threshold, within: reached <= total },
								{ holds: true, within: true }
							)
						})
				)
			)
	)
})
