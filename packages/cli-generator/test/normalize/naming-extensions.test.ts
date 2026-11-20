/**
 * An operation's naming extensions (design 4.4, D-NAME4), as normalize reads them: a Forge and a Fern hint, each a
 * group (a dotted string split at `.`, or an array kept whole, no segment empty) and a method (a non-empty string), and
 * `x-forge-aliases`, an array of aliases each named by its own keys (a group and a method across its Forge and Fern
 * hints) or by its own `operationId`, never the operation's, an `x-forge-aliases` inside one unread. A key whose value
 * is no such shape is dropped with an EXT-01 naming-invalid notice at itself, an unnamed alias with alias-unnamed at
 * itself, and aliases with no usable one are treated as absent with a notice at the array; an operation whose every
 * naming value is unusable has no naming. The notices come in document order.
 *
 * Oracle: design 4.4's reading of naming extensions, applied to the drawn operation.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type NamingFeature,
	namingFeatures,
	namingSpace
} from "#test/normalize/naming-extensions.fixtures.ts"

/**
 * An operation's naming extensions read as design 4.4 states, with their notices. Its budget replaces the forty
 * example cases of the suite it converts (twenty a line, on two lines).
 */
export const namingExtensions = property.explore(namingSpace, {
	needs: {},
	situations: [
		"dotted group",
		"array group",
		"group of another shape",
		"group with an empty segment",
		"method alone",
		"group alone",
		"fern and forge together",
		"method of another shape",
		"usable alias by its own keys",
		"alias by its operationId alone",
		"unnamed alias",
		"alias that is no object",
		"aliases that are no array",
		"no usable alias",
		"nested aliases ignored",
		"operationId never inherited",
		"malformed value inside an alias",
		"no naming"
	] satisfies ReadonlyArray<Reached<NamingFeature>>,
	check: (_, c: Case<NamingFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(namingFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 4.4's reading of naming extensions, applied to the drawn operation"
	},
	kept: [],
	budget: { runs: 40, steered: 256 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/operations.ts",
			original: "\t\t(name) => ({ additional: false, name, token: Str.toUpperCase(name) })",
			replacement: "\t\t(name) => ({ additional: true, name, token: Str.toUpperCase(name) })",
			why: "Every fixed method is read as an additional operation, so the operation sits under additionalOperations and its naming notices point there; the property fails (CATCH's evidence, mutant 76dbee2000)."
		},
		{
			file: "packages/cli-generator/src/normalize/operations.ts",
			original: 'segment !== ""',
			replacement: "false",
			why: "Every group segment is read as empty, so no group is ever usable and every alias named by its group is unnamed; the property fails (CATCH's evidence, mutant 94a6bc32e9)."
		},
		{
			file: "packages/cli-generator/src/model/json-tree.ts",
			original: "Arr.isArray<Json>(value)",
			replacement: "false",
			why: "No JSON value is read as an array, so `x-forge-aliases` is never an array and an array group is never a group; the property fails (CATCH's evidence, mutant b0f3dbd970)."
		}
	]
})
