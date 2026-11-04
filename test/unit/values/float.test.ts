import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, type Gen, weighted } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { double } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { compareFloat, floatText, toReal } from "#compiler/scalar/values/float.ts"
import { assert, succeeded } from "#test/support/assert.ts"

/** Any double: finite ones, -0 and the subnormals among them, and now and then NaN or an infinity. */
const anyDouble: Gen<number> = weighted([
	[9, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])

/** The order a difference states: -1, 0 or 1, never -0. */
const signOf = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0)

describe("real normalization", () => {
	it.effect("produces canonical real values only", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/float-1",
					draw: drawn(anyDouble),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 5000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				(x) =>
					Effect.sync(() => {
						const real = toReal(x)
						if (!real.ok) {
							return
						}
						assert.ok(Object.is(Math.fround(real.value), real.value) && !Object.is(real.value, -0))
						assert.equal(Object.is(succeeded(toReal(real.value)), real.value), true)
					})
			)
		)
	)
})

describe("PostgreSQL's float order", () => {
	it.effect("is a total order whose equality is the identity text's", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const value: Gen<number> = weighted([
					[1, anyDouble],
					[1, element([-0, 0, Number.NaN])]
				])
				return yield* explore(
					{
						suite: "unit/values/float-2",
						draw: drawn(
							(source) => [source.draw(value), source.draw(value), source.draw(value)] as const
						),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 5000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.minutes(2)
					},
					([a, b, c]) =>
						Effect.sync(() => {
							assert.equal(compareFloat(a, b), signOf(-compareFloat(b, a)))
							assert.equal(compareFloat(a, b) === 0, floatText(a) === floatText(b))
							if (compareFloat(a, b) <= 0 && compareFloat(b, c) <= 0) {
								assert.ok(compareFloat(a, c) <= 0)
							}
						})
				)
			})
		)
	)
})
