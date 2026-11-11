import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Effect, Order, String as Str } from "effect"
import { v8Coverage } from "#sense.ts"

/** Takes its branch only when told to. */
const branch = (taken: boolean): number => {
	if (taken) {
		return 1
	}
	return 0
}

/** What a fresh sense, opened and closed around one case, perceives of this file while the case skips the branch. */
const perceivedOnce = Effect.scoped(
	Effect.gen(function* () {
		const sense = yield* v8Coverage(Str.endsWith("/sense.test.ts"))
		const [, trace] = yield* sense.perceive(Effect.sync(() => branch(false)))
		return Arr.fromIterable(trace)
	})
)

/** The distinct classes a trace holds, beside the zero of ranges it did not report. */
const classesOf = (trace: ReadonlyArray<number>) =>
	Arr.sort(Arr.dedupe(Arr.filter(trace, (traced) => traced !== 0)), Order.Number)

describe("a guided file's block coverage", () => {
	it.effect(
		"outlives each sense that reads it, so a later sense still perceives a branch not taken",
		() =>
			Effect.gen(function* () {
				const first = yield* perceivedOnce
				const second = yield* perceivedOnce
				deepStrictEqual({ classes: classesOf(first), second }, { classes: [1, 2], second: first })
			})
	)
})
