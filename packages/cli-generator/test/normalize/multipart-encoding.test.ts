/**
 * multipart/form-data parts (design 6.3, 8.5), as normalizeBody builds their rules: each declared property in document
 * order is a part typed by its Encoding Object's contentType (a comma-separated list of media ranges; one that is no
 * such list refused) or by the default table; an object typed as XML is refused (XML-01). A 3.0 `format: byte` part
 * and a 3.1 or 3.2 `contentEncoding: base64` one (or their array's items) are sent base64, an identity encoding raw,
 * any other refused (ENC-37, ENC-38); a declared Content-Transfer-Encoding header whose schema rules out base64 is a
 * conflict (ENC-39). Part headers are typed as header parameters, a Content-Type entry ignored, the headers the writer
 * owns noticed, a name that is no token refused. Style fields apply from 3.1 on (3.0 ignores them with a notice): form
 * with explode is sent as name and value pairs, any other style refused at field scope for an optional part and for
 * the whole alternative for a required one (ENC-40). An encoding key naming no property is refused before 3.2 and
 * ignored on 3.2, and a schema-valued additionalProperties map is refused while the declared parts stay (SCH-13).
 *
 * Oracle: design 6.3's multipart rules and default table, applied to the drawn body.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type MultipartFeature,
	multipartFeatures,
	multipartSpace,
	positionalActual,
	positionalExpected,
	type PositionalFeature,
	positionalFeatures,
	positionalSpace,
	keywordActual,
	keywordExpected,
	keywordSpace
} from "#test/normalize/multipart-encoding.fixtures.ts"
import { digestService } from "#test/support/digest.ts"

/**
 * A multipart body's part rules, refused fields and findings are what design 6.3 states. Its budget replaces the
 * thirty-five example cases of the suites' multipart rules it converts (multipart-encoding and the multipart cases of
 * bodies), twice over.
 */
export const multipartEncoding = property.explore(multipartSpace, {
	needs: {},
	situations: [
		"3.0 format byte sent base64",
		"3.1 contentEncoding base64",
		"identity contentEncoding sent raw",
		"unsupported contentEncoding refused",
		"array of base64 items",
		"comma-separated contentType",
		"contentType that is no list refused",
		"object part typed as XML refused",
		"typed part header",
		"Content-Type header ignored",
		"writer-owned header",
		"header name no token refused",
		"transfer header admits base64",
		"transfer header conflict refused",
		"form pairs style",
		"unsupported part style refused at field scope",
		"unsupported part style drops the alternative",
		"3.0 multipart style ignored",
		"unknown encoding key",
		"additionalProperties map refused",
		"part typed through a reference or allOf",
		"type list read without null or as disagreeing"
	] satisfies ReadonlyArray<Reached<MultipartFeature>>,
	check: (_, c: Case<MultipartFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(multipartFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.3's multipart part rules and default table, applied to the drawn body"
	},
	kept: [],
	budget: { runs: 70, steered: 512 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "values === undefined || Arr.some(values, isBase64)",
			replacement: "Arr.some(values, isBase64)",
			why: "A Content-Transfer-Encoding schema with no enum or const is read as ruling out base64, so a base64 part with a plain transfer header is refused; the property fails (CATCH's evidence, mutant 060fb7b78f)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original:
				'schema !== undefined &&\n\t\tbase === "multipart/form-data" &&\n\t\t(yield* isArrayBody(ctx.walk, schema, members))',
			replacement: 'schema !== undefined && base === "multipart/form-data"',
			why: "Every multipart/form-data body with a schema is refused as an array body; the property fails (CATCH's evidence, mutant 965d604df9)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "\t\t...(styled === undefined || pairs ? [] : [unsupportedPartStyle(input)])",
			replacement: "\t\t...(styled !== undefined || pairs ? [] : [unsupportedPartStyle(input)])",
			why: "The part-style check is inverted, so a form part with explode is refused and an unsupported style is sent; the property fails (CATCH's evidence, mutant d5d54e3ff8)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: '["const", "enum"]',
			replacement: '["enum"]',
			why: "A Content-Transfer-Encoding schema's const is no longer read, so a const that rules out base64 conflicts with nothing; the property fails (CATCH's evidence, mutant e322d75dc6)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "if (keys.refused) {\n\t\treturn refusedParts([...extra, ...keys.findings])\n\t}",
			replacement: "{}",
			why: "An encoding key naming no part no longer refuses a multipart body before 3.2; the property fails (CATCH's evidence, mutant 7cc87ed432)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "\t\treturn { drops: false, findings, refusedFields: [] }",
			replacement: "\t\treturn { drops: true, findings, refusedFields: [] }",
			why: "A multipart body whose parts refuse no style drops its alternative all the same; the property fails (CATCH's evidence, mutant a53dfceb8b)."
		}
	]
})

/**
 * A 3.2 body read by position, and a form-data part nesting one level, get the rules design 6.3 states: multipart/mixed
 * gives every prefixItems position a rule (its prefixEncoding entry, else the default table) and items or itemSchema an
 * item rule, closed items none; multipart/related gives only its declared entries; an encoding beside prefixEncoding or
 * itemEncoding refuses the alternative (MED-13). A nesting part's rules follow by name, then by position, then its
 * item rule (ENC-07 to ENC-09); a second level is refused (ENC-16), and so is a nested part declaring base64. Its budget
 * replaces the twelve example cases of the suites' positional and nested rules it converts (bodies and
 * multipart-encoding), twice over.
 */
export const positionalEncoding = property.explore(positionalSpace, {
	needs: {},
	situations: [
		"prefixItems positions by the default table",
		"explicit position contentType",
		"item rule by the default table",
		"item rule from itemSchema",
		"closed items give no item rule",
		"multipart/related positions only as declared",
		"encoding beside positional fields refused",
		"nested by name",
		"nested by position",
		"nested item rule",
		"second nested level refused",
		"nested base64 part refused",
		"nesting part sent base64"
	] satisfies ReadonlyArray<Reached<PositionalFeature>>,
	check: (_, c: Case<PositionalFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = positionalExpected(sketch)
			c.noteAll(positionalFeatures(sketch, expected))
			const actual = yield* positionalActual(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.3's positional and nested encoding rules, applied to the drawn 3.2 body"
	},
	kept: [],
	budget: { runs: 24, steered: 256 },
	kills: [
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "!defaulted",
			replacement: "defaulted",
			why: "A multipart/mixed body's item rule is made only when nothing defaults it, so items and itemSchema give no item rule and an absent one does; the property fails (CATCH's evidence, mutant ff04237b83)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "input.depth === 0 || found.encoding === undefined",
			replacement: "found.encoding === undefined",
			why: "A nested part's base64 transfer encoding is accepted, so the part is sent unencoded where nothing can carry the encoding; the property fails (CATCH's evidence, mutant 47c486a7d2)."
		},
		{
			file: "packages/cli-generator/src/normalize/bodies.ts",
			original: "input.depth === 1 && (nests || node.itemEncoding !== undefined)",
			replacement: "(nests || node.itemEncoding !== undefined)",
			why: "Nesting is refused at every depth, so a form-data part nesting its first level is refused as too deep; the property fails (CATCH's evidence, mutant 0f8cd859c7)."
		}
	]
})

/**
 * A 3.1 keyword in a 3.0 multipart part schema stays refused by 3.0 schema validation (ENC-41): one VAL-02 refusal at
 * document scope, located at the keyword itself, the deepest place the validator's errors share, whether it sits on the
 * part or on a member of it. Its budget replaces the one example case of the suite it converts, on each placement.
 */
export const threeZeroPartKeyword = property.exhaust(finite(keywordSpace), {
	box: "the keyword on the part or on a member of an object part, under either part name, with or without a sibling part",
	needs: { digest: digestService },
	situations: [],
	check: (resources) => (sketch) =>
		Effect.gen(function* () {
			const digest = yield* resources.digest
			const actual = yield* keywordActual(sketch, digest)
			assert.deepEqual<ReturnType<typeof keywordExpected>>(actual, keywordExpected(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "3.0 schema validation, located at the deepest place its errors share"
	},
	kept: [],
	kills: [
		{
			file: "packages/cli-generator/src/model/pointer.ts",
			original: "pointer === ancestor || Str.startsWith(",
			replacement: "pointer === ancestor || false && Str.startsWith(",
			why: "A pointer is within another only when equal to it, so validation errors are not grouped under their deepest location and the refusal lands elsewhere; the property fails (CATCH's evidence, mutant 9ab9320360)."
		}
	]
})
