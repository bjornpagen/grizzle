/**
 * A Responses Object, as normalizeResponses builds its cases (design 2.2, 6.6, 7.3): each member in the order the
 * parsed object lists it is an explicit code, a range `1XX` to `5XX` or `default`; a three-digit code outside 100 to
 * 599 and a name outside the grammar are refused at element scope, and an `x-` member is skipped. A case keeps its use
 * site as origin, follows a `$ref` to its target (a 3.1 use-site description overriding the target's), makes its help
 * text safe, records its headers by name with their marks read through a `$ref` (a Content-Type header ignored with a
 * notice, a name that is no token refused, a 3.0 schema-serialized header noticed for its percent-encoding) and its
 * media alternatives with the codec their media type selects, a schema keyed by its component name or its canonical
 * pointer and a 3.2 item schema apart (a key that is no media type refused, encoding and a 3.2 description ignored
 * with a notice). Findings follow member order, a case's alternatives before its headers; cases match explicit codes,
 * then ranges, then default, and media types are looked up exact keys first, then type ranges, then the full range.
 *
 * Oracle: design 6.6's key grammar, codec table and orders, applied to the drawn Responses Object.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type ResponsesFeature,
	responsesFeatures,
	responsesSpace
} from "#test/normalize/responses.fixtures.ts"

/**
 * A Responses Object normalizes to the cases, findings and orders design 6.6 states. Its budget replaces the
 * twenty-five example cases of the suite it converts, twice over.
 */
export const responsesRules = property.explore(responsesSpace, {
	needs: {},
	situations: [
		"explicit code",
		"range",
		"default",
		"code out of range",
		"key outside the grammar",
		"extension key skipped",
		"referenced response",
		"use-site description",
		"unsafe description",
		"Content-Type header ignored",
		"header name no token",
		"header marks through a reference",
		"3.0 header percent-encoding notice",
		"content-based header",
		"media key no media type",
		"encoding ignored",
		"media description ignored",
		"component schema",
		"inline schema",
		"item schema",
		"media range dispatched after exact keys",
		"no responses"
	] satisfies ReadonlyArray<Reached<ResponsesFeature>>,
	check: (_, c: Case<ResponsesFeature>) => (sketch) =>
		Effect.gen(function* () {
			const expected = expectedOf(sketch)
			c.noteAll(responsesFeatures(sketch, expected))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "design 6.6's response key grammar, codec table and orders, applied to the drawn Responses Object"
	},
	kept: [],
	budget: { runs: 50, steered: 256 },
	kills: [
		{
			file: "packages/generator/src/resolve/index.ts",
			original: "\t\t\tif (known !== undefined && known !== member) {",
			replacement: "\t\t\tif (known !== undefined && known === member) {",
			why: "Resolution takes a member it already holds for a new one, so the document set is refused; the property fails (CATCH's evidence, mutant 503dbfe0f1)."
		},
		{
			file: "packages/generator/src/normalize/responses.ts",
			original:
				"[...alternatives.flatMap((alternative) => alternative.findings), ...headers.findings]",
			replacement: "[...headers.findings]",
			why: "A response's media alternatives raise no finding, so an invalid content key, a 3.0 encoding and a 3.2 description pass unreported; the property fails (CATCH's evidence, mutant 10241650d3)."
		},
		{
			file: "packages/generator/src/resolve/index.ts",
			original: "\tfor (let index = items.length - 1; index >= 0; index -= 1) {",
			replacement: "\tfor (let index = items.length - 1; index >= 0; index -= 0) {",
			why: "The resolver's walk never steps past its last item, so resolving a document with any reference to walk does not end within the case deadline; the property fails (CATCH's evidence, mutant 041212ab52)."
		}
	]
})
