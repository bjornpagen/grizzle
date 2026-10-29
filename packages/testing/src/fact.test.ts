import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Effect, Option, Ref } from "effect"
import { awaitFact } from "#fact.ts"

describe("awaiting a fact", () => {
	it.effect("returns what a concurrent fiber made true, with no time passing", () =>
		Effect.gen(function* () {
			const steps = yield* Ref.make(0)
			yield* Effect.forkChild(
				Effect.repeat(
					Ref.update(steps, (step) => step + 1),
					{ times: 99 }
				)
			)
			const reached = yield* awaitFact(
				Effect.map(Ref.get(steps), (step) => (step >= 100 ? Option.some(step) : Option.none()))
			)
			strictEqual(reached, 100)
		})
	)
})
