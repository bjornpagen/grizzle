import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { checkBound } from "#compiler/core/budget.ts"
import { sitedLoc } from "#compiler/core/loc.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"

/**
 * A rewrite pass's step bound (core/budget.ts checkBound): "Exceeding a compiler resource bound yields a source-located
 * error." A bound admits a value exactly up to its limit, and refuses one past it with ResourceBound at its own location,
 * naming the pass, its limit and the value it needed.
 *
 * One bound, at its own location.
 */
interface Bound {
	readonly limit: number
	readonly value: number
	readonly at: number
}

type BoundFeature = "a bound within its limit" | "a bound met exactly" | "a bound exceeded"

/**
 * A bound's location: a declaration at a call site, distinct per bound, so a refusal located at another bound is told
 * apart.
 */
const locOf = (at: number) =>
	sitedLoc("query q", ["workload", "q", "arms", at], {
		file: "/app/queries.ts",
		line: at + 1,
		column: 5
	})

const boundGen: Gen<Bound> = (source) => ({
	limit: source.draw(int(0, 6)),
	value: source.draw(int(0, 8)),
	at: source.draw(int(0, 63))
})

describe("checkBound", () => {
	it.effect(
		"admit a value up to its limit and refuse one past it with ResourceBound at the bound's location",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/core/budget",
						draw: drawn(array(boundGen, { min: 1, max: 24 })),
						literal: Formatter.format,
						coverage: required<BoundFeature>(
							["a bound within its limit", "a bound met exactly", "a bound exceeded"],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						/** Each case checks up to 24 bounds of limits 0 to 6 against values 0 to 8. */
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					(bounds, c) =>
						Effect.sync(() => {
							for (const bound of bounds) {
								const result = checkBound("demand", bound.limit, bound.value, locOf(bound.at))
								if (bound.value <= bound.limit) {
									succeeded(result)
									c.note(
										bound.value === bound.limit ? "a bound met exactly" : "a bound within its limit"
									)
								} else {
									const crossed = refused(result, "ResourceBound")
									assert.deepEqual(crossed.reason, {
										_tag: "ResourceBound",
										at: locOf(bound.at),
										bound: {
											kind: "rewriteSteps",
											rewrite: "demand",
											limit: bound.limit,
											needed: bound.value
										}
									})
									c.note("a bound exceeded")
								}
							}
						})
				)
			)
	)
})
