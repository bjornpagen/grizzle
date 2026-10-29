import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noFeatures } from "@grizzle/testing/features"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { int8Max, int8Min } from "#compiler/scalar/values/integer.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, succeeded } from "#test/support/assert.ts"

describe("Money", () => {
	it.effect("round-trips its minor units through numeric", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/values/money-1",
					draw: drawn(bigint(int8Min, int8Max)),
					literal: Formatter.format,
					features: noFeatures,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					steering: { kind: "none" },
					caseHang: Duration.minutes(2)
				},
				(units) =>
					Effect.sync(() => {
						const money = Money.of(units)
						assert.equal(succeeded(Money.fromDecimal(money.toDecimal())).minorUnits, units)
					})
			)
		)
	)
})
