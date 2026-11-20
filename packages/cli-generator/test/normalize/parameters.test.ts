/**
 * Parameter Objects, as normalizeParameter decides them and the operation assembly reads them (design 6.1, 6.2): the
 * style table's row for every location, style, explode and allowReserved a line defines, its defaults taken from the
 * line's text and never a schema's; cookies by style form (or 3.2's cookie), an explode false cookie refused for good
 * on 3.2 and a form cookie over an array or object always (PRM-34); deepObject over an object only, its explode a later
 * line's correction, a nested value refused unless the author config's bracket switch sends it, and a scalar branch
 * sent only under the scalar switch, each switch's notice beside the value; explode where no value type fits and a
 * delimited style over a primitive refused; allowReserved and allowEmptyValue honored where the line gives them a
 * meaning and ignored with a notice elsewhere; a 3.0 schema-serialized header noticed for percent-encoding; Accept,
 * Content-Type and Authorization headers ignored, a Cookie header refused, a name with control characters and a cookie
 * name that is no token refused; content parameters by one concrete media type with a schema, a querystring by
 * content alone; help text made safe; a reference's use site the diagnostics' site and its target their related site;
 * a refused required parameter raising its operation; and a parameter the earlier stages should have stopped failing
 * with its reason.
 *
 * Oracle: design 6.1's style table and parameter rules, applied to the drawn parameter.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type ParameterFeature,
	parameterFeatures,
	parameterSpace
} from "#test/normalize/parameters.fixtures.ts"

/**
 * A parameter normalizes, and raises its operation, as design 6.1 states. Its budget replaces the one hundred example
 * cases of the three suites it converts (parameters, cookie-querystring and deep-object-nested).
 */
export const parameterRules = property.explore(parameterSpace, {
	needs: {},
	situations: [
		"location default style",
		"path style row",
		"query style row",
		"header style row",
		"cookie form",
		"cookie style on 3.2",
		"cookie explode false refused for good",
		"cookie form over an array or object",
		"deepObject built",
		"deepObject explode corrected",
		"deepObject nested refused",
		"deepObject nested under the bracket switch",
		"deepObject over a non-object",
		"deepObject scalars under the scalar switch",
		"deepObject under both switches",
		"explode not applicable",
		"delimited style over a primitive",
		"delimited style over an array or object",
		"style the location does not define",
		"allowReserved honored",
		"3.2 path allowReserved honored",
		"allowReserved ignored",
		"allowEmptyValue honored",
		"allowEmptyValue ignored",
		"3.0 header percent-encoding",
		"ignored header",
		"Cookie header refused",
		"invalid name",
		"invalid cookie name",
		"content parameter",
		"content media type not concrete",
		"content without schema",
		"querystring content",
		"querystring with schema fields",
		"referenced parameter",
		"help text sanitized",
		"required parameter refused raises its operation",
		"unreadable parameter",
		"object-valued parameter"
	] satisfies ReadonlyArray<Reached<ParameterFeature>>,
	check: (_, c: Case<ParameterFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(parameterFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.1's style table and parameter rules, applied to the drawn parameter"
	},
	kept: [],
	budget: { runs: 100, steered: 512 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: '["deepObject", "form", "pipeDelimited", "spaceDelimited"]',
			replacement: '["deepObject", "form", "spaceDelimited"]',
			why: "pipeDelimited is no longer a query style, so a pipeDelimited query parameter is refused as a style its location does not define; the property fails (CATCH's evidence, mutant 19265ad0f3)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: '!Str.startsWith("#")(fragment)',
			replacement: 'Str.startsWith("#")(fragment)',
			why: "A `$ref` fragment is read as no pointer exactly when it is one, so a parameter's reference to a component is never followed; the property fails (CATCH's evidence, mutant 40bb5e087c)."
		},
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original:
				"if (Arr.isArray<Json>(current)) {\n\t\treturn Result.fromOption(\n\t\t\tarrayIndex.test(token) ? Arr.get(current, Number(token)) : Option.none(),\n\t\t\t() => new PointerIndexOutOfRange({ pointer, token })\n\t\t)\n\t}",
			replacement: "{}",
			why: "A pointer into an array names no node, so the parameter at /parameters/0 is never read; the property fails (CATCH's evidence, mutant 41318bc6f6)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: "types.length > 0 && !compound(types)",
			replacement: "types.length > 0",
			why: "A schema of object or array type counts as primitive, so a delimited style over an array or object is refused; the property fails (CATCH's evidence, mutant 4eeb6553b7)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is MediaType => mediaTypePattern.test(text)",
			replacement: "text is MediaType => true",
			why: "MediaType checks no pattern, so a content key that is no concrete media type passes where PRM-15 refuses it; the property fails (CATCH's evidence, mutant 679dac1427, on the predicate)."
		},
		{
			file: "packages/cli-generator/src/model/brands.ts",
			original: "text is WireName => wireNamePattern.test(text)",
			replacement: "text is WireName => true",
			why: "WireName checks no pattern, so a name with control characters passes where PRM-02 refuses it; the property fails (CATCH's evidence, mutant 679dac1427, on the predicate)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: "\tconst both = node.schema !== undefined && node.content !== undefined",
			replacement: "\tconst both = node.schema !== undefined && node.content === undefined",
			why: "A parameter with a schema and no content is read as carrying both, so every schema parameter is unreadable; the property fails (CATCH's evidence, mutant 7ededcb814)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\treturn { invalidBase: base === undefined, member }",
			replacement: "\treturn { invalidBase: base !== undefined, member }",
			why: "Every document with a base URI is read as having none, so resolution refuses every document; the property fails (CATCH's evidence, mutant 96109f34de)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: '\t\tcover === "strict" ? traits : { ...traits, nonObject: false }',
			replacement: '\t\tcover !== "strict" ? traits : { ...traits, nonObject: false }',
			why: "The strict deepObject rule ignores a schema that admits non-objects, and the scalar switch's covered ones are held to it, so a deepObject over a scalar is built and one under the switch refused; the property fails (CATCH's evidence, mutant a9cd859b82)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: "node.allowReserved === true && !honored",
			replacement: "node.allowReserved === true",
			why: "allowReserved is noticed as ignored even where the line honors it, so a query parameter's allowReserved draws a notice; the property fails (CATCH's evidence, mutant b8d6872fd5)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: 'node.in === "path" || (node.in === "cookie" && style === "form")',
			replacement: '(node.in === "cookie" && style === "form")',
			why: "A 3.2 path parameter's allowReserved is no longer honored, so it is ignored with a notice and its row loses allowReserved; the property fails (CATCH's evidence, mutant c7b307f46b)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: 'node.in === "querystring" && usesSchemaFields(node)',
			replacement: 'node.in === "querystring"',
			why: "A querystring parameter is refused for schema fields it does not use, so every querystring is refused; the property fails (CATCH's evidence, mutant caf77fe059)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: '\tconst honored = node.in === "query" && node.allowEmptyValue === true\n',
			replacement: '\tconst honored = node.in === "query"\n',
			why: "allowEmptyValue is read as honored on every query parameter, so a query parameter without it records PRM-08; the property fails (CATCH's evidence, mutant d1964e8add)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "\tfor (let index = items.length - 1; index >= 0; index -= 1) {",
			replacement: "\tfor (let index = items.length - 2; index >= 0; index -= 1) {",
			why: "The resolver's walk skips the last item it found, so the last reference of a document is never resolved; the property fails (CATCH's evidence, mutant e0e00ecee2)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: 'name === "object" || (walk.arrays && name === "array")',
			replacement: 'name === "object"',
			why: "An array no longer counts as admitting only objects or arrays for deepObject, so a deepObject over an array is refused as a non-object instead of as nested; the property fails (CATCH's evidence, mutant e6e5fd5cd5)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original: "known !== undefined && known !== member",
			replacement: "known !== member",
			why: "Resolution takes a member it already holds for a new one, so the document set is refused; the property fails (CATCH's evidence, mutant 7f03f8445e)."
		},
		{
			file: "packages/cli-generator/src/normalize/schemas.ts",
			original: "\t\t\tif (reference !== undefined) {",
			replacement: "\t\t\tif (reference === undefined) {",
			why: "A schema's references are rewritten only where there is none, so a parameter's `$ref` schema cannot be imported; the property fails (CATCH's evidence, mutant 8aa3a696a9)."
		},
		{
			file: "packages/cli-generator/src/resolve/index.ts",
			original:
				"[\n\t\t\t\t...Arr.sort(retried, byOrder),\n\t\t\t\t...Arr.map(found, (site, index) => ({ order: offset + index, site }))\n\t\t\t]",
			replacement: "[...Arr.sort(retried, byOrder)]",
			why: "The resolver drops the sites it finds on each pass, so no reference of the document is ever resolved; the property fails (CATCH's evidence, mutant fcbd429ef9)."
		},
		{
			file: "packages/cli-generator/src/normalize/operations.ts",
			original: "policy.listed > 0 && policy.policy.alternatives.length === 0",
			replacement: "policy.policy.alternatives.length === 0",
			why: "An operation that lists no security alternative is refused as having none satisfiable, so every operation without security is removed; the property fails (CATCH's evidence, mutant 12881cea9d)."
		},
		{
			file: "packages/cli-generator/src/normalize/parameters.ts",
			original: '\tif (location === "cookie") {',
			replacement: '\tif (location !== "cookie") {',
			why: "A cookie parameter is decided by the query and path rules and every other location by the cookie rules; the property fails (CATCH's evidence, mutant accd8a54b7)."
		}
	]
})
