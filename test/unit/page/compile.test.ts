import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage } from "@grizzle/testing/features"
import { element, int } from "@grizzle/testing/gen"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Duration, Effect, Formatter } from "effect"
import { refused } from "#test/support/assert.ts"
import { testCompile } from "#test/support/compile.ts"
import { compiledPageResult, flagged } from "#test/unit/page/fixtures.ts"

describe("the page compiler", () => {
	it.effect("refuses a bounded heterogeneous union, whatever its bound and order", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/page/bounded-union",
					draw: drawn((source) => ({
						take: source.draw(int(1, 50)),
						direction: source.draw(element(["asc" as const, "desc" as const]))
					})),
					literal: Formatter.format,
					coverage: noCoverage,
					kept: [],
					runs: 30,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang: Duration.minutes(2)
				},
				({ take, direction }) =>
					Effect.sync(() => {
						refused(
							compiledPageResult(flagged.take(take).orderBy(["id", direction]), testCompile),
							"UnsupportedOperation"
						)
					})
			)
		)
	)
})
