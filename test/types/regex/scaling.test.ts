import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { assertClean, assertLinear, measuredSizes } from "#test/types/batch/measured.ts"
import { regexScaleSizes, regexScaleSource } from "#test/types/regex/scaling.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the regex-scale program", (it) => {
	it.effect(
		"typechecks 50, 100 and 200 patterns, cross products past the union limit among them, with no diagnostic, linear in types and instantiations",
		() =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes("test/types/regex", regexScaleSizes, regexScaleSource)
				for (const s of sizes) {
					assertClean(s, "regex patterns")
				}
				assertLinear("regex patterns", sizes)
			})
	)
})
