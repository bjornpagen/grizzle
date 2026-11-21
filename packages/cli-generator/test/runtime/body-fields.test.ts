/**
 * A JSON request body is merged from `--body` or `--body-file` and the field flags as the merge model says, through
 * `mergeBody` and `structuredBody` alike. Without a field flag the operator's bytes are sent as given, once checked;
 * otherwise each field flag, in order, overrides the parsed body at its RFC 6901 pointer (a missing or non-object step
 * becomes a fresh object, `__proto__` an own key), a number keeps its text, a base64 field carries its whole file
 * padded in its alphabet, and a secret file's value, one trailing line end stripped, is recorded so every echo of it
 * scrubs to its placeholder. Stdin goes to the first `-` consumer only. Every refusal is a UsageError naming a flag,
 * never a value or a path, and both entry points refuse alike.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	comparable,
	expectedObserved,
	type MergeFeature,
	mergeArms,
	mergeFeatures,
	merges,
	observed,
	prototypeClean
} from "#test/runtime/body-fields.fixtures.ts"

/**
 * Both body entry points settle every drawn merge exactly as the model does. It replaces 32 example cases
 * (input-base64.test.ts, input-secret-file.test.ts's merge cases, input-structured-body.test.ts); its budget is that
 * count, 32 drawn merges, and up to 48 steered while a situation is unreached.
 */
export const bodyMerge = property.explore(
	aimed(merges, [
		["a file past one read chunk", mergeArms.large],
		["two stdin consumers refused", mergeArms.twoStdin],
		["a secret from stdin", mergeArms.secretStdin],
		["a secret's CRLF line end stripped", mergeArms.secretCrlf],
		["a secret not UTF-8 refused", mergeArms.secretNotUtf8],
		["__proto__ as an own key", mergeArms.proto],
		["a schema admits the merge", mergeArms.person],
		["a non-object body under fields refused", mergeArms.nonObject],
		["a field number refused", mergeArms.badNumber],
		["invalid JSON refused", mergeArms.invalidJson],
		["a number kept as its text", mergeArms.keptNumber],
		["a verbatim body", mergeArms.verbatim],
		["a file from stdin", mergeArms.fileStdin]
	]),
	{
		needs: { dir: Scratch.dir },
		situations: [
			"a verbatim body",
			"no input, optional",
			"no input, required",
			"a field over the body",
			"a nested pointer",
			"__proto__ as an own key",
			"a number kept as its text",
			"a base64 file",
			"a base64url file",
			"a file past one read chunk",
			"a file from stdin",
			"a secret from a file",
			"a secret from stdin",
			"a secret's line end stripped",
			"a secret's CRLF line end stripped",
			"two stdin consumers refused",
			"a missing file refused",
			"a secret not UTF-8 refused",
			"body and body-file refused",
			"invalid JSON refused",
			"a non-object body under fields refused",
			"a field number refused",
			"a schema refusal",
			"a schema admits the merge"
		] satisfies ReadonlyArray<Reached<MergeFeature>>,
		check:
			({ dir }, c: Case<MergeFeature>) =>
			(drawn) =>
				Effect.gen(function* () {
					c.noteAll(mergeFeatures(drawn))
					const root = yield* dir
					const merged = yield* observed(root, drawn, "merge")
					const structured = yield* observed(root, drawn, "structured")
					const expected = expectedObserved(drawn)
					assert.deepEqual(comparable(merged), expected)
					assert.deepEqual(comparable(structured), expected)
					assert.equal(prototypeClean(), true)
				}),
		oracle: {
			kind: "specification",
			name: "the merge model: source conflict and read, verbatim without fields, pointer overrides in order, schema check, one stdin claimant"
		},
		kept: [],
		budget: { runs: 32, steered: 48 },
		kills: [
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original:
					"Predicate.isObject(value) &&\n\t!Arr.isArray<Json>(value) &&\n\t!(value instanceof JsonNumber) &&\n\t!(value instanceof JsonNull)",
				replacement: "true",
				why: "Every field value is taken for an object, so a string field (a base64 file's text) is copied as an object of its characters; the property fails (CATCH's evidence, mutant 556104f119)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original:
					'mergeSources(options).pipe(\n\t\tEffect.map(({ merged }) => {\n\t\t\tif (merged._tag === "Empty") {\n\t\t\t\treturn HttpBody.empty\n\t\t\t}\n\n\t\t\treturn HttpBody.uint8Array(\n\t\t\t\tmerged._tag === "Verbatim" ? merged.bytes : encoder.encode(merged.text)\n\t\t\t)\n\t\t})\n\t)',
				replacement: "mergeSources(options)",
				why: "mergeBody hands on the merge's own record, not an HTTP body, so nothing is sent; the property fails (CATCH's evidence, mutant 452a583f98)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original:
					"Predicate.isObject(value) &&\n\t!Arr.isArray<Json>(value) &&\n\t!(value instanceof JsonNumber) &&\n\t!(value instanceof JsonNull)",
				replacement: "false",
				why: "No parsed body is an object, so every body under field flags is refused; the property fails (CATCH's evidence, mutant 8c23d4d1b3)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: "\t\t\tnode[Arr.lastNonEmpty(segments)] = value",
				replacement: "\t\t\tvoid value",
				why: "A field flag's value is never written at its pointer; the property fails (CATCH's evidence, mutant 78b2fd4272)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: "\t\t\tyield* assert(text)\n",
				replacement: "\t\t\t{}\n",
				why: "A body with no field flag is sent without being checked, so text that is not JSON or that its schema refuses goes out; the property fails (CATCH's evidence, mutant 8783f544cc)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: "\t\tconst text = jsonText(base)\n\n\t\tyield* assert(text)",
				replacement: "\t\tconst text = jsonText(base)",
				why: "A merged body is never checked against its schema, so a body the schema refuses is sent; the property fails."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: '\tpath === "-"\n\t\t? Effect.service(StdinClaim)',
				replacement: '\tpath !== "-"\n\t\t? Effect.service(StdinClaim)',
				why: "`-` is opened as a file and every path reads stdin; the property fails (CATCH's evidence, mutant fada6f4a7d)."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: 'const lineEnd: Readonly<RegExp> = regex("\\r?\\n$", "u")',
				replacement: 'const lineEnd: Readonly<RegExp> = regex("\\n$", "u")',
				why: "A secret file's CRLF line end leaves its CR in the value; the property fails."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/input.ts",
				original: 'encoding === "base64url" ? Base64Url.encodePadded(bytes) : Base64.encode(bytes)',
				replacement:
					'encoding === "base64url" ? Base64.encode(bytes) : Base64Url.encodePadded(bytes)',
				why: "A base64 field is written in the other alphabet; the property fails."
			},
			{
				file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
				original: 'const isSecret = (entry: ScrubEntry): entry is Secret => "kind" in entry',
				replacement: "const isSecret = (entry: ScrubEntry): entry is Secret => false",
				why: "A recorded secret is scrubbed as a credential with no scheme, so its echoes do not render its placeholder; the property fails (CATCH's evidence, mutant 5e59dc6a94)."
			}
		]
	}
)
