import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { SourceLoc } from "#compiler/core/loc.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { accepts } from "#test/support/fixtures/ir/scalar.ts"
import { checked } from "#test/types/batch/groups.ts"
import {
	regexSchemaRefusalCount,
	regexPattern,
	regexSchemaPatterns
} from "#test/types/regex/schema.ts"
import { jsAccepts } from "#test/unit/text/generators.ts"

layer(NodeServices.layer, { excludeTestServices: true })("the growing regex schema", (it) => {
	it("admits every generated pattern, each distinct, with sound members and outside values", () => {
		const keys = new Set<string>()
		for (let i = 0; i < regexSchemaPatterns; i++) {
			const p = regexPattern(i)
			const analyzed = succeeded(analyzeText(p.source, p.flags, SourceLoc("schema", [i])), p.source)
			keys.add(analyzed.key)
			assert.equal(jsAccepts(p.source, p.flags, p.member), true)
			assert.equal(accepts(analyzed, p.member), true)
			if (p.domain.kind === "wide") {
				assert.equal(p.host, "string")
			} else {
				assert.notEqual(p.host, "string")
				assert.equal(jsAccepts(p.source, p.flags, p.domain.outside), false)
				assert.equal(accepts(analyzed, p.domain.outside), false)
			}
		}
		assert.equal(keys.size, regexSchemaPatterns)
	})

	it.effect(
		`typechecks the ${regexSchemaPatterns}-pattern program exactly, keeping every refusal with the code it names`,
		() =>
			Effect.gen(function* () {
				const { expected, actual } = yield* checked("regex/schema")
				assert.equal(expected.length, regexSchemaRefusalCount(regexSchemaPatterns))
				assert.deepEqual(actual, expected)
			})
	)
})
