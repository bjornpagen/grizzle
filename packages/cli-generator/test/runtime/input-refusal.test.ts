/**
 * A body the schema refuses is refused naming where it fails and what the schema expects there, worded by the JSON
 * Schema keyword it breaks, and never quoting the body's own value: `--body: the request body does not match its schema
 * at <RFC 6901 pointer>: <expectation>`.
 *
 * The schema is one object of every JSON type, a nested object whose one member's name holds both characters a pointer
 * escapes, and an array; both objects are closed, as the domain module writes `additionalProperties: false`, a plain
 * Struct the body is checked against with every excess property refused. A property draws a valid body, then plants
 * exactly one fault: a required member left out, a value of another JSON type, or a member no property declares, aimed
 * while a feature is pending at one that is. The oracle is the plant: the message names the planted
 * place's pointer, and `(required)`, the JSON type the schema expects there, or `(additionalProperties)`, and quotes no
 * planted value.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	FEATURES,
	faultFeatures,
	faults,
	plantedAt,
	quotesAValue,
	type RefusalFeature,
	refusalOf
} from "#test/runtime/input-refusal.fixtures.ts"

/**
 * A refused body names where it fails and the keyword it breaks, and none of its values. Its budget is the count its
 * suite stated before the conversion: 40 independent cases, and up to 40 steered while a situation is unreached.
 */
export const bodyRefusal = property.explore(faults, {
	needs: {},
	situations: FEATURES satisfies ReadonlyArray<Reached<RefusalFeature>>,
	check: (_, c: Case<RefusalFeature>) => (fault) =>
		Effect.gen(function* () {
			const items = c.draw(int(1, 3))
			const { path, expectation, pointer } = plantedAt(fault)
			c.noteAll(faultFeatures(fault, path))
			const refused = yield* refusalOf(fault, items)
			assert.deepEqual(
				{ message: refused.message, quotesAValue: quotesAValue(refused.message) },
				{
					message: `--body: the request body does not match its schema at ${pointer}: ${expectation}`,
					quotesAValue: false
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the planted fault's RFC 6901 pointer and the keyword it breaks, and no planted value in the message"
	},
	kept: [],
	budget: { runs: 40, steered: 40 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: 'const closedObjects = { onExcessProperty: "error" } as const',
			replacement: 'const closedObjects = { onExcessProperty: "ignore" } as const',
			why: "A body is checked with excess properties ignored, so a member no property declares passes; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original:
				'\t\t\tcase "MissingKey":\n\t\t\t\treturn "a required member is missing (required)"',
			replacement: '\t\t\tcase "MissingKey":\n\t\t\t\treturn "a required member is missing"',
			why: "A missing member's message no longer names the keyword it breaks; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
			original: "\t\t\t\tJsonPointer.escapeToken(",
			replacement: "\t\t\t\t(",
			why: "The refusal's pointer leaves `/` and `~` in a member's name unescaped, so a name holding them points elsewhere; the property fails."
		}
	]
})
