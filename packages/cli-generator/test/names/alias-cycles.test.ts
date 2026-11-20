/**
 * Alias cycles in a request body (DOC-23): a body schema that reaches a cycle of references returning to a schema
 * without descending into the instance is refused at the cycle, once per schema on it, and planned as an opaque body,
 * never a defect; the same chain left open still resolves to its object. The space is every chain of one to four
 * component schemas, each link a bare `$ref` or a one-member `allOf`, `anyOf` or `oneOf`, either closed back onto its
 * first schema or ended in an object of one required string, reached by the request body directly or through one
 * property. Each case runs the pipeline in process: resolve, normalize and the names plan.
 *
 * Oracle (specification: DOC-23 and design 4.5's body flags): a closed chain gives one DOC-23/alias-cycle refusal at
 * each of its links and no field flag below the cycle, so a direct body has only `--body` and `--body-file`, and a
 * property reaching it is one JSON flag; an open chain gives no DOC-23, and where every link is `$ref` or `allOf` the
 * object's `name` is a string flag (`name`, or `inner.name` through the property), while an `anyOf` or `oneOf` link
 * leaves the body opaque as any union does.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	chainSpace,
	type ChainFeature,
	expectedOf,
	featuresOf,
	plannedOf
} from "#test/names/alias-cycles.fixtures.ts"

/** A body reaching a closed chain is refused at the cycle and planned opaque; an open chain still resolves. */
export const aliasCycles = property.exhaust(chainSpace, {
	box: "every chain of one to four schemas, each link a $ref or a one-member allOf, anyOf or oneOf, closed or ended in an object, reached directly or through a property",
	needs: {},
	situations: [
		"a cycle of one schema",
		"a cycle of two schemas",
		"a cycle of three or more",
		"a cycle through allOf",
		"a cycle through anyOf",
		"a cycle through oneOf",
		"an open chain that resolves",
		"an open chain through a union",
		"a body pointing straight into a cycle",
		"a body reaching a cycle through a property"
	],
	check: (_, k: Case<ChainFeature>) => (chain) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(chain))
			const planned = yield* plannedOf(chain)
			assert.deepEqual(planned, expectedOf(chain))
		}),
	oracle: {
		kind: "specification",
		name: "DOC-23 at every link of a closed chain and an opaque body; an open chain's object flattened"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: '[\n\t\t\tkey,\n\t\t\t{ schema, site: below(site, "properties", key) }\n\t\t]',
			replacement: "[key]",
			why: "A flattened property loses its schema and site, so a body reaching an open chain through a property plans no inner flag; the property fails (CATCH's evidence, mutant f6b2b66721)."
		},
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original: "\t\tdefinitions: acyclic.definitions,",
			replacement: "\t\tdefinitions: converted.definitions,",
			why: "The stored schemas keep the alias cycles breakAliasCycles found, so a body reaching one is a defect in the names plan instead of a DOC-23 refusal; the property fails (the plant its suite's header named: normalizeSchemas acyclic -> converted)."
		}
	]
})
