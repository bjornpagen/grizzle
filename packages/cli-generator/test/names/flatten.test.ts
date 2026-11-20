/**
 * Design 4.5's body flags and 6.3's multipart parts (names/flatten.ts): over request bodies drawn as schema trees
 * (scalars with every format and encoding the rules turn on, bare, union, multi-type, map and array schemas, objects
 * three deep, references into `$defs`, `allOf` merges, read-only and constant members), every codec and line, refused
 * fields and Encoding rules, flattenBody gives what a model written from its stated rules gives: a JSON or form body
 * `--body` and `--body-file` and its fields two names deep as dotted typed flags (scalar arrays repeating, everything
 * else one JSON flag), each naming the source pointer of the property that declares it; a multipart body one flag a
 * part (binary, password and base64-ruled parts files, an object part JSON, any other shape skipped); a binary or XML
 * body `--body-file` alone and any other codec both whole-body flags; a 3.0 read-only member nothing, a refused field
 * nothing, a required one-value member a body constant, a name folding to nothing a skip; and every field flag or its
 * boolean negation equal to a reserved name a clash, each list in its documented order.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	bodySpace,
	expectedOf,
	type Feature,
	featuresOf
} from "#test/names/flatten.fixtures.ts"

/**
 * A drawn body flattens as the model does. Its budget replaces 43 example cases: 43 independent cases, and up to 52
 * steered while one of its 26 situations is unreached, each reached by its own aimed arm.
 */
export const bodyFlags = property.explore(bodySpace, {
	needs: {},
	situations: [
		"a string flag",
		"an integer flag",
		"a number flag",
		"a boolean flag",
		"a repeated scalar flag",
		"a JSON flag",
		"a dotted flag two deep",
		"a field through a reference",
		"an allOf merged into fields",
		"a base64 file flag",
		"a file part",
		"a repeated file part",
		"a password part",
		"a part skipped as unsupported",
		"a name folding to nothing",
		"a reserved flag clash",
		"a negation clash",
		"a read-only member left out on 3.0",
		"a read-only member kept on 3.1 or 3.2",
		"a refused field",
		"a body constant",
		"a scalar-switch field",
		"a base64 rule's part",
		"a binary body",
		"an xml body",
		"a text body"
	],
	check: (_, k: Case<Feature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(featuresOf(c))
			const actual = yield* actualOf(c)
			assert.deepEqual(actual, expectedOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 4.5's body flags and 6.3's parts, by codec and line, from flattenBody's stated rules"
	},
	kept: [],
	budget: { runs: 43, steered: 52 },
	kills: [
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: "[...whole, ...flags]",
			replacement: "[...flags]",
			why: "A JSON or form body loses `--body` and `--body-file`; the property fails (CATCH's evidence, mutant e047a8c18b)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: "[...at.tokens, key]",
			replacement: "[...at.tokens]",
			why: "A field's wire pointer loses its own name, so every field points at its parent; the property fails (CATCH's evidence, mutant e1bf74d5d7)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: "Predicate.isObject(json) && !Arr.isArray(json)",
			replacement: "false",
			why: "No schema reads as an object, so a body has no field flags at all; the property fails (CATCH's evidence, mutant f1c7d054b9)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original:
				'if (codec === "binary") {\n\t\treturn Result.succeed({\n\t\t\tconstants: [],\n\t\t\tflags: [wholeBody("body-file")],\n\t\t\treserved: [],\n\t\t\tskipped: []\n\t\t})\n\t}',
			replacement: "{}",
			why: "A binary body is walked as fields with both whole-body flags, where only `--body-file` may send it; the property fails (CATCH's evidence, mutant e59bb5f52e)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: '["components", "schemas", key]',
			replacement: '["schemas", key]',
			why: "A component's fields name `/schemas/<name>` instead of `/components/schemas/<name>` as their source; the property fails (CATCH's evidence, mutant 6a77dbbcda)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original:
				'if (codec === "xml") {\n\t\treturn Result.succeed({\n\t\t\tconstants: [],\n\t\t\tflags: [wholeBody("body-file")],\n\t\t\treserved: [],\n\t\t\tskipped: []\n\t\t})\n\t}',
			replacement: "{}",
			why: "An XML body is walked as fields with both whole-body flags, where only `--body-file` may send it; the property fails (CATCH's evidence, mutant fdce466352)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: "ctx.readOnlyOmitted && isReadOnly(ctx, schema)",
			replacement: "ctx.readOnlyOmitted",
			why: "On 3.0 every member is left out as read-only, read-only or not; the property fails (CATCH's evidence, mutant d09451350f)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: "ctx.readOnlyOmitted && isReadOnly(ctx, schema)",
			replacement: "true",
			why: "Every member on every line is left out as read-only; the property fails (CATCH's evidence, mutant 80dafa7ddd)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: 'type === "string" && (schema.format === "binary" || hasIdentityEncoding(schema))',
			replacement: 'type === "string"',
			why: "Every string part of a multipart body is a file part; the property fails (CATCH's evidence, mutant cf831b2dd6)."
		},
		{
			file: "packages/cli-generator/src/names/flatten.ts",
			original: '\t\tschema.contentEncoding === "base64url" ||',
			replacement: '\t\tschema.contentEncoding !== "base64url" ||',
			why: "A base64url property stays text and every other contentEncoding makes a base64 file flag; the property fails (CATCH's evidence, mutant 0100a92670)."
		}
	]
})
