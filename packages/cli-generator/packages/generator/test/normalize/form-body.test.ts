/**
 * Form-urlencoded request bodies (design 6.3, 8.5), as normalizeBody builds their rules: one rule per declared property
 * in document order. Style fields apply on every line (3.0's rows say so) and are kept as given, a contentType beside
 * them ignored with a notice; without them the value takes the default contentType table's type (ENC-17 to ENC-26), and
 * an explicit contentType is kept only when it names that type. Style fields the query style table finds inapplicable
 * (explode where no value type fits, a delimited style over a primitive, deepObject over a non-object) and a deepObject
 * over a nested value without the author config's bracket switch are refused; a contentType that is no list of media
 * ranges is refused. A refused optional property is refused at field scope at its Encoding entry and the alternative
 * stays; a required one drops the alternative, reported at the media type. A 3.0 or 3.1 deepObject without explode true
 * is exploded with a notice; headers, nested encodings and 3.2's positional fields are multipart's and are ignored with
 * notices; an encoding key naming no property refuses the alternative before 3.2 and is ignored on 3.2.
 *
 * Oracle: design 6.3's form rules and default table, applied to the drawn body.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type FormFeature,
	formFeatures,
	formSpace
} from "#test/normalize/form-body.fixtures.ts"

/**
 * A form body's rules, refused fields and findings are what design 6.3 states. Its budget replaces the thirty-five
 * example cases of the suites' form rules it converts (form-body and the form cases of bodies), twice over.
 */
export const formEncoding = property.explore(formSpace, {
	needs: {},
	situations: [
		"default table string",
		"default table binary string",
		"default table scalar",
		"default table object",
		"default table null",
		"default table array",
		"default table untyped",
		"style fields kept",
		"contentType beside style ignored",
		"explicit contentType equal to the table",
		"explicit contentType refused on an optional property",
		"explicit contentType refused on a required property",
		"contentType that is no list refused",
		"explode not applicable",
		"delimited style over a primitive",
		"deepObject over a non-object",
		"deepObject nested refused",
		"deepObject nested under the bracket switch",
		"deepObject explode corrected",
		"multipart-only fields ignored",
		"unknown encoding key refused",
		"unknown encoding key ignored on 3.2",
		"positional fields ignored on 3.2",
		"3.0 rows"
	] satisfies ReadonlyArray<Reached<FormFeature>>,
	check: (_, c: Case<FormFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(formFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			deepStrictEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.3's form rules and default contentType table, applied to the drawn body"
	},
	kept: [],
	budget: { runs: 70, steered: 512 },
	kills: [
		{
			file: "packages/generator/src/resolve/index.ts",
			original: "\treturn { invalidBase: base === undefined, member }",
			replacement: "\treturn { invalidBase: base !== undefined, member }",
			why: "Every document with a base URI is read as having none, so resolution refuses every document; the property fails (CATCH's evidence, mutant 96109f34de)."
		},
		{
			file: "packages/generator/src/normalize/bodies.ts",
			original:
				"if (\n\t\tfallback !== undefined &&\n\t\t(typing.contentType.length !== 1 ||\n\t\t\tpipe(given, UndefinedOr.map(Str.toLowerCase)) !== fallback.type)\n\t) {\n\t\treturn {\n\t\t\tfindings: [...typing.findings, formContentTypeRefusal(input, fallback.type)],\n\t\t\trule: undefined\n\t\t}\n\t}",
			replacement: "{}",
			why: "An explicit contentType that differs from the default table's type is kept, so a form value is sent as a type it is not; the property fails (CATCH's evidence, mutant b9f0c78455)."
		},
		{
			file: "packages/generator/src/normalize/bodies.ts",
			original: "findings.push(contentTypeIgnored(input.actual))",
			replacement: "{}",
			why: "A contentType beside style fields is ignored without its notice; the property fails (CATCH's evidence, mutant ce61311706)."
		},
		{
			file: "packages/generator/src/normalize/bodies.ts",
			original: 'if (!declared.has(name) && line !== "3.2") {',
			replacement: "if (false) {",
			why: "An encoding key that names no property is never refused before 3.2; the property fails (CATCH's evidence, mutant ef5b8633bc)."
		},
		{
			file: "packages/generator/src/normalize/bodies.ts",
			original: '!declared.has(name) && line !== "3.2"',
			replacement: 'line !== "3.2"',
			why: "Every encoding key refuses its alternative before 3.2, even one naming a declared property; the property fails (CATCH's evidence, mutant a73e5c4cda)."
		}
	]
})
