/**
 * A generated CLI asserts a JSON request body against its schema before any connection, and sends a body that passes
 * byte for byte as the operator gave it. The assertion follows the schema's keywords with the generator's documented
 * exceptions:
 *
 * - A keyword beside `$ref` is asserted together with the target's keywords (SCH-03): an integer from the target's
 *   `minimum` 1 to the sibling `maximum` 5 passes; below, above, or not an integer is refused.
 * - `additionalProperties: false` rejects an undeclared key at any depth, and a declared property keeps its type
 *   (SCH-13).
 * - `patternProperties` is not asserted (SCH-15): a pattern-matched key passes whatever its value, and an object closed
 *   by `additionalProperties: false` beside `patternProperties` is opened, so any key passes; its declared properties
 *   stay typed.
 *
 * One package with five JSON-body operations: a `$ref` with a sibling `maximum`, a closed object with a closed nested
 * object, an open patterned object, a closed patterned object, and an object with a closed patterned member. A
 * property draws a body for one of them, sometimes made to reach one situation, written compact or spaced, and gives
 * it by `--body`. Oracle: a reference check of the body against each schema's rules above; a passing body arrives as
 * one request carrying exactly the text given, and a failing one is exit 2 with no connection.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	caseFeatures,
	cases,
	done,
	expectedOf,
	type Feature,
	FEATURES,
	jsonFixture,
	jsonOf,
	type Outcome,
	receivedOf
} from "#test/generated/json-body-schemas.fixtures.ts"
import { runBin } from "#test/support/cli-package.ts"

/**
 * A body that passes its schema's asserted rules is sent byte for byte as given, and one that fails sends nothing. Its
 * budget is the count its suite stated before the conversion: 6 independent cases, and up to 24
 * steered while a situation is unreached.
 */
export const jsonBodySchemas = property.explore(cases, {
	needs: { fixture: jsonFixture, checkout: Checkout.dir },
	situations: FEATURES,
	check:
		({ fixture }, k: Case<Feature>) =>
		(c) =>
			Effect.gen(function* () {
				const { server, built, commands } = yield* fixture
				k.noteAll(caseFeatures(c))
				const observed = yield* server.observe(
					() => done,
					runBin(built, {
						args: Arr.flatten([
							commands[c.operation],
							["--base-url", server.origins["127.0.0.1"], "--body", jsonOf(c.body, c.spaced)]
						]),
						env: {},
						stdin: new Uint8Array(0)
					})
				)
				assert.deepEqual<Outcome>(
					{
						exitCode: observed.result.exitCode,
						connections: observed.connections.length,
						requests: Arr.map(observed.requests, receivedOf)
					},
					expectedOf(c),
					"a body that passes its schema is sent as given, and one that fails sends nothing"
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "a reference check of the body against each schema's rules"
	},
	kept: [],
	budget: { runs: 6, steered: 24 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/read.ts",
			original: '\t\t\t\t? [{ path: [name], refusal: { _tag: "AdditionalProperties" } }]',
			replacement: "\t\t\t\t? []",
			why: "A closed object's reader takes a member no property declares, so a body with an undeclared key at any depth is sent where SCH-13 refuses it; the property fails."
		},
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original:
				'\t\t\t} else if (keyword === "additionalProperties" && patterned && constrainsKeys(value)) {',
			replacement: "\t\t\t} else if (false) {",
			why: "An object closed beside `patternProperties` stays closed, so a pattern-matched key the schema leaves unasserted (SCH-15) is refused; the property fails."
		}
	]
})
