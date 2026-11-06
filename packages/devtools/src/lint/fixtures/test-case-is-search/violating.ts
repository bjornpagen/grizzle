import { describe, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { test } from "vitest"
import {
	caseOf,
	checkOne,
	ping,
	relayedScript,
	scripted,
	suites
} from "#lint/fixtures/test-case-is-search/support.ts"
import { element } from "#lint/fixtures/test-case-is-search/testing.ts"

describe("examples", () => {
	it.effect("checks one written input", () => checkOne(1)) // violation

	it("checks a plain example", () => { // violation
		Effect.runSync(checkOne(2))
	})

	it.live("checks a live example", () => Effect.void) // violation

	it.effect.skip("a skipped example is still one", () => Effect.void) // violation

	it.effect.each([1, 2])("an example table", (n) => checkOne(n)) // violation

	it.effect("follows a cycle that reaches nothing", () => ping(3)) // violation

	it.effect("names a generator and runs no search", () => Effect.sync(() => element([1, 2]))) // violation

	it.effect("hands a helper an example", () => caseOf(() => checkOne(4))) // violation

	it.effect("reads the registry's example", () => suites.example()) // violation

	test("vitest's own test", () => { // violation
		Effect.runSync(checkOne(5))
	})

	it.effect("runs a hand scenario in a scaffold's search", () => scripted(() => checkOne(6))) // violation

	it.effect("reaches a scaffold through a helper", () => relayedScript()) // violation
})

layer(Layer.empty)("a layer's cases", (it) => {
	it.effect("an example under a layer", () => Effect.void) // violation

	it("a plain example under a layer", () => { // violation
		Effect.runSync(Effect.void)
	})
})
