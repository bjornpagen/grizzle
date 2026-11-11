import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, String as Str } from "effect"
import { drawn, explore } from "#explore.ts"
import { noCoverage } from "#features.ts"
import { int } from "#gen.ts"
import { boundedShrink } from "#shrink.ts"
import { HARDENED_FLAGS } from "#vitest/config.ts"
import { searched } from "#vitest/searched.ts"

describe("the Vitest adapter", () => {
	it.effect("runs a search on the run global setup chose", (ctx) =>
		Effect.gen(function* () {
			const explored = yield* searched(
				ctx,
				explore(
					{
						suite: "adapter",
						draw: drawn(int(0, 9)),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 100,
						shrink: boundedShrink(500),
						concurrency: 8,
						steerEvery: 16,
						caseHang: Duration.minutes(1)
					},
					() => Effect.void
				)
			)
			strictEqual(explored.kind, "explored")
		})
	)

	it("runs every test process under the hardened flags, with no __proto__ accessor", () => {
		deepStrictEqual(
			Arr.filter(HARDENED_FLAGS, (flag) => !Arr.contains(process.execArgv, flag)),
			[]
		)
		strictEqual(Object.getOwnPropertyDescriptor(Object.prototype, "__proto__"), undefined)
	})

	it("loads modules natively, untouched by a transform", () => {
		strictEqual(typeof import.meta.resolve, "function")
		strictEqual(Str.endsWith("adapter.test.ts")(import.meta.filename), true)
	})
})
