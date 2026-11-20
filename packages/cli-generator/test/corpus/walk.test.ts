/**
 * The corpus walker's outline (corpus/tools/walk.ts, design 8.3): over drawn 3.1 documents, every operation, parameter,
 * request media type, response key, security alternative and server is listed at the use site it is reached by, never
 * at the target of a `$ref` it passes through, sorted by pointer; each operation records the path-level parameters it
 * does not override by name and location, the security and servers it inherits from the levels above it, and whether
 * it is on the default server; and nothing of a webhook or a callback is listed.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	documentSpace,
	expectedOf,
	type Feature,
	featuresOf,
	walkedOf
} from "#test/corpus/walk.fixtures.ts"

/** A drawn document's outline is the one its sketch states. */
export const outlineWalk = property.explore(documentSpace, {
	needs: {},
	situations: [
		"a referenced parameter",
		"a referenced request body",
		"a referenced response",
		"a referenced path item",
		"a path-level parameter an operation overrides",
		"a header overridden in another case",
		"a path-level parameter an operation inherits",
		"an operation with its own security",
		"an operation with empty security",
		"an operation inheriting the root security",
		"an operation with its own servers",
		"an operation inheriting path item servers",
		"an operation inheriting the root servers",
		"an operation on the default server",
		"the same name in two locations",
		"a webhook or a callback"
	] satisfies ReadonlyArray<Reached<Feature>>,
	check: (_, k: Case<Feature>) => (sketch) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(sketch))
			const walked = yield* walkedOf(sketch)
			assert.deepEqual(walked, expectedOf(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "design 8.3's outline of the sketch the document is drawn from: each element at its use site, sorted by pointer"
	},
	kept: [],
	kills: [
		{
			file: "packages/generator/src/resolve/index.ts",
			original: '"pathItem",\n\t"requestBody",\n\t"response",',
			replacement: '"pathItem",\n\t"response",',
			why: "A request body is no kind a reference stands for, so a referenced body's media types are never reached; the property fails (TESTPOLICY2's census, mutant 1d0c253431)."
		},
		{
			file: "packages/generator/corpus/tools/walk.ts",
			original: "servers: itemServers ?? rootServers",
			replacement: "servers: itemServers",
			why: "An operation of a path item with no servers inherits none of the root's; the property fails."
		},
		{
			file: "packages/generator/corpus/tools/walk.ts",
			original: "? Str.toLowerCase(left.name) === Str.toLowerCase(right.name)",
			replacement: "? left.name === right.name",
			why: "A header an operation names in another case is taken for another parameter, so the path item's is inherited beside it; the property fails."
		},
		{
			file: "packages/generator/corpus/tools/walk.ts",
			original:
				'defaultServer: above.servers === undefined && Option.isNone(memberOf(node, "servers"))',
			replacement: 'defaultServer: Option.isNone(memberOf(node, "servers"))',
			why: "An operation with no servers of its own is on the default server though a level above it declares servers; the property fails."
		}
	]
})
