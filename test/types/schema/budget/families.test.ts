import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, String as Str } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	assertClean,
	assertLinear,
	measuredProgram,
	measuredSizes
} from "#test/types/batch/measured.ts"
import { familySizes, generateFamiliesSource } from "#test/types/schema/budget/families.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the family-scale schema", (it) => {
	it.effect(
		"typechecks 500, 1,000 and 2,000 families and as many folds, nested two deep and with trees, with no diagnostic, linear in types and instantiations",
		() =>
			Effect.gen(function* () {
				const sizes = yield* measuredSizes("test/types/schema", familySizes, generateFamiliesSource)
				for (const s of sizes) {
					assertClean(s, "the family-scale schema")
				}
				assertLinear("the families", sizes)
			})
	)

	it.effect("raises exactly the refusal its directive names at 2,000 families, disarmed", () =>
		Effect.gen(function* () {
			const families = Arr.lastNonEmpty(familySizes)
			const { measured, directives } = yield* measuredProgram(
				"test/types/schema",
				families,
				(entries) => generateFamiliesSource(families, entries),
				false
			)
			assert.deepEqual(measured.unattributed, [], "no diagnostic outside the program")
			assert.deepEqual(
				Arr.map(measured.errors, (e) => ({ line: e.line, code: e.code })),
				Arr.map(directives, (d) => ({ line: d.line, code: d.code })),
				"each directive's line raises its code, and no other line raises any"
			)
			for (const d of directives) {
				if (d.claim.kind === "refusal") {
					const printed = `Refusal<"${d.claim.refusal}">`
					assert.ok(
						Arr.some(measured.errors, (e) => e.line === d.line && Str.includes(printed)(e.text)),
						`line ${d.line} prints ${printed}`
					)
				}
			}
		})
	)
})
