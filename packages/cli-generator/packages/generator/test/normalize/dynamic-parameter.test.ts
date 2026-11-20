/**
 * A parameter whose schema reaches a dynamic or recursive keyword (`$dynamicRef`, `$recursiveRef`, or a `$ref` to a
 * `$dynamicAnchor` or `$recursiveAnchor` holder) cannot be checked, so normalizeParameter refuses it, never sending it
 * unchecked: in place, in a subschema or through a chain of references, for a schema or a content entry's schema, on
 * every location, keeping its required mark so a required one raises its operation. A plain schema is built.
 *
 * Oracle: design 6.1's rule for schemas the generator cannot check, applied to the drawn parameter.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	type DynamicFeature,
	dynamicFeatures,
	dynamicSpace,
	expectedOf
} from "#test/normalize/dynamic-parameter.fixtures.ts"

/**
 * A parameter reaching a dynamic keyword is refused keeping its required mark; one that reaches none is built. Its
 * budget replaces the eleven example cases of the suite it converts, twice over.
 */
export const dynamicParameter = property.explore(dynamicSpace, {
	needs: {},
	situations: [
		"nowhere",
		"$dynamicRef in place",
		"$recursiveRef in place",
		"$dynamicRef in a subschema",
		"a $ref to a $dynamicAnchor holder",
		"a $ref to a $recursiveAnchor holder",
		"a $ref chain to a $dynamicAnchor holder",
		"content-entry schema",
		"path parameter",
		"header parameter",
		"required parameter refused",
		"optional parameter refused"
	] satisfies ReadonlyArray<Reached<DynamicFeature>>,
	check: (_, c: Case<DynamicFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(dynamicFeatures(sketch))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expectedOf(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "a schema the generator cannot check refuses its parameter, keeping required"
	},
	kept: [],
	budget: { runs: 22, steered: 128 },
	kills: [
		{
			file: "packages/generator/src/resolve/index.ts",
			original: '[method, "operation", "one"]',
			replacement: '["operation", "one"]',
			why: "An operation's members are no longer walked, so a parameter's `$ref` to an anchor holder is never followed and the parameter is built unchecked; the property fails (CATCH's evidence, mutant 945327cbc8)."
		},
		{
			file: "packages/generator/src/resolve/index.ts",
			original: "\treturn { invalidBase: base === undefined, member }",
			replacement: "\treturn { invalidBase: base !== undefined, member }",
			why: "Every document with a base URI is read as having none, so resolution refuses every document; the property fails (CATCH's evidence, mutant 96109f34de)."
		}
	]
})
