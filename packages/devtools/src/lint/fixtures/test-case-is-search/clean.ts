import { describe, it, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import {
	caseOf,
	even,
	heldSearch,
	relayed,
	searchedSuite,
	suites
} from "#lint/fixtures/test-case-is-search/support.ts"
import * as Testing from "#lint/fixtures/test-case-is-search/testing.ts"
import { explore, integer, interleave } from "#lint/fixtures/test-case-is-search/testing.ts"

const local = () => explore({ suite: "local", draw: integer(0, 9) }, () => Effect.void)

describe("searches", () => {
	it.effect("explores directly", () =>
		explore({ suite: "direct", draw: integer(0, 9) }, () => Effect.void)
	)

	it.effect("exhausts through a namespace", () =>
		Testing.exhaust({ suite: "namespace", generator: integer(0, 3) }, () => Effect.void)
	)

	it.effect("interleaves", () => interleave("pct"))

	it.effect("runs a helper of another module", () => searchedSuite("helper"))

	it.effect("runs a constant that holds a search", () => heldSearch)

	it.effect("runs a search two helpers away", () => relayed())

	it.effect("runs a search through a cycle", () => even(4))

	it.effect("runs a local helper handed as its body", local)

	it.effect("hands a helper its search", () => caseOf(() => searchedSuite("handed")))

	it.effect("reads the registry's search", () => suites.searched())

	it("a plain case searches too", () => {
		Effect.runSync(searchedSuite("plain"))
	})

	describe("a suite is no case", () => {
		it.effect("searches inside", () => searchedSuite("inner"))
	})
})

layer(Layer.empty)("a layer's searches", (it) => {
	it.effect("searches under a layer", () => searchedSuite("layered"))

	it.layer(Layer.empty)("a nested layer is no case", (it) => {
		it.effect("searches under it", () => searchedSuite("nested"))
	})
})

Effect.runSync(Effect.void)
