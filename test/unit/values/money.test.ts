import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { completeShrink } from "@grizzle/testing/shrink"
import { bigint } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import { int8Max, int8Min } from "#compiler/core/limits.ts"
import { Money } from "#compiler/scalar/values/money.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

describe("Money", () => {
	it.effect("round-trips its minor units through numeric", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: { kind: "unstated" },
					suite: "unit/values/money-1",
					draw: drawn(bigint(int8Min.value, int8Max.value)),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 2000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
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
