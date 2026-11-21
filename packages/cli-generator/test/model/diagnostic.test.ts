/**
 * The model's Diagnostic (design 8.1). A diagnostic of every scope and severity, each
 * optional field present or not, reads as a Diagnostic (isDiagnostic), is what the factory builds from its fields
 * without a row, its members in the model's order, and reads as a refusal and a document refusal exactly as its severity and scope say;
 * a code naming another row, a malformed code, an unknown scope, a pointer that is no RFC 6901 text and a position
 * below one are each refused. Diagnostics sort by their document's place in the set (any other last), then design
 * 3.7's pointer order, then code, whatever order they arrive in, and the sort is a fixed point.
 */
import { assert } from "@bjornpagen/testing/assert"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type CodecFeature,
	codecAnswerOf,
	codecFeaturesOf,
	diagnosticSpace,
	expectedCodecOf,
	expectedSortOf,
	type OrderFeature,
	orderFeaturesOf,
	sortedOf,
	sortSpace
} from "#test/model/diagnostic.fixtures.ts"

/**
 * A drawn diagnostic round-trips and is what the factory builds, or is refused for its planted fault. Its budget replaces
 * 12 example cases: 12 independent cases, and up to 32 steered while one of its 16 situations is unreached, each reached
 * by its own aimed arm.
 */
export const diagnosticCodec = property.explore(diagnosticSpace, {
	needs: {},
	situations: [
		"a code naming another row refused",
		"a malformed code refused",
		"an unknown scope refused",
		"a pointer that is no RFC 6901 text refused",
		"a position below one refused",
		"a document refusal",
		"a document notice",
		"a operation refusal",
		"a operation notice",
		"a element refusal",
		"a element notice",
		"a field refusal",
		"a field notice",
		"a diagnostic of every optional field",
		"a diagnostic of no optional field",
		"a row whose prefix holds a digit"
	],
	check: (_, k: Case<CodecFeature>) => (sketch) =>
		Effect.gen(function* () {
			k.noteAll(codecFeaturesOf(sketch))
			const actual = yield* codecAnswerOf(sketch)
			assert.deepEqual(actual, expectedCodecOf(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the encoded fields back in declared order, the factory's diagnostic, the predicates by severity and scope"
	},
	kept: [],
	budget: { runs: 12, steered: 32 },
	kills: [
		{
			file: "packages/cli-generator/src/model/diagnostic.ts",
			original: '(row) => row === value["row"]',
			replacement: '(row) => row !== value["row"]',
			why: "A diagnostic reads as one only when its code names another row than its row field, so every sound diagnostic is refused; the property fails (CATCH's evidence, mutant 327a1669df, on the reader)."
		},
		{
			file: "packages/cli-generator/src/model/diagnostic.ts",
			original: '\tOption.exists(rowOfCode(value["code"]), (row) => row === value["row"]) &&\n',
			replacement: "",
			why: "isDiagnostic never checks a row against its code, so a diagnostic whose code names another row reads as one; the property fails (CATCH's evidence, mutant 8ab3c2d689, on the reader)."
		},
		{
			file: "packages/cli-generator/src/model/diagnostic.ts",
			original: 'diagnostic.scope === "document"',
			replacement: "false",
			why: "isDocumentRefusal never answers true, so a document-scope refusal reads as an element's; the property fails (CATCH's evidence, mutant 6d016061c9)."
		}
	]
})

/**
 * A drawn list of diagnostics sorts as the model orders it, whatever its arrival order, and sorting again changes
 * nothing. Its budget replaces 2 example cases: 2 independent cases, and up to 8 steered while one of its 4 situations
 * is unreached, each reached by its own aimed arm.
 */
export const diagnosticOrder = property.explore(sortSpace, {
	needs: {},
	situations: [
		"two pointers differing in an array index",
		"a document outside the set",
		"two diagnostics at one place told apart by code",
		"a pointer and its own descendant"
	],
	check: (_, k: Case<OrderFeature>) => (c) =>
		Effect.gen(function* () {
			k.noteAll(orderFeaturesOf(c))
			const actual = yield* sortedOf(c)
			assert.deepEqual(actual, expectedSortOf(c))
		}),
	oracle: {
		kind: "second-implementation",
		name: "design 3.7's order: document place, then pointer token by token with array indices by number, then code"
	},
	kept: [],
	budget: { runs: 2, steered: 8 },
	kills: [
		{
			file: "packages/cli-generator/src/model/diagnostic.ts",
			original: "\t\treturn index === -1 ? documents.length : index",
			replacement: "\t\treturn index !== -1 ? documents.length : index",
			why: "A document outside the set sorts first instead of last; the property fails (CATCH's evidence, mutant 9a5102f2c9)."
		}
	]
})
