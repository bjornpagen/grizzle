/**
 * The final catch renders each design 7.1 error once, in the format the run recorded (design 7.4): as text, the
 * error's message line, the capped Retry-After sentence, the retry hint after a request D-AD7 would retry, the request
 * id's line and the body; as JSON, one `{"error":{...}}` object, keys alphabetical, the hint a second sentence of the
 * message, the operation only for the classes that carry one. Every field is scrubbed of the run's recorded values and
 * sanitized, one-line fields folded; a defect prints one line and exits 70; each class keeps its exit code in either
 * format.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedFailings,
	expectedOf,
	FAILING_SITUATIONS,
	type FailingFeature,
	failingFeatures,
	renderedOf
} from "#test/runtime/error-rendering.fixtures.ts"

/**
 * A failing run prints exactly what design 7.4 says and keeps its exit. It replaces forty-two example cases
 * (output-error-json.test.ts's 32, output-request-id.test.ts's 4, output.test.ts's renderError and finalCatch exits);
 * its rotating stream is 42 drawn failures, its floor and steered phase reach each kind in each format by an aimed
 * failure.
 */
export const errorRendering = property.explore(aimedFailings, {
	needs: {},
	situations: FAILING_SITUATIONS satisfies ReadonlyArray<Reached<FailingFeature>>,
	check: (_, c: Case<FailingFeature>) => (failing) =>
		Effect.gen(function* () {
			c.noteAll(failingFeatures(failing))
			const rendered = yield* renderedOf(failing)
			assert.deepEqual(rendered, expectedOf(failing))
		}),
	oracle: {
		kind: "specification",
		name: "design 7.4's text and JSON forms of each error, scrubbed, sanitized, with its exit"
	},
	kept: [],
	budget: { runs: 42, steered: 42 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: '\treturn Arr.filter(Arr.dedupe(forms), (form) => form !== "")',
			replacement: '\treturn Arr.filter(Arr.dedupe(forms), (form) => form === "")',
			why: "Only empty forms are kept, so no recorded value is scrubbed from a rendered error; the property fails (CATCH's evidence, mutant 14294898a7)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "\tfor (let at = 1, matched = 0; at < form.length; at += 1) {",
			replacement: "\tfor (let at = 1, matched = 0; at < form.length; at += 0) {",
			why: "A form's prefix table is built one character short, so a recorded value is missed in a rendered error; the property fails (CATCH's evidence, mutant a936e48f04)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '\tconst json = rendering.format === "json"',
			replacement: '\tconst json = rendering.format !== "json"',
			why: "A run recorded as JSON renders text and one recorded as text renders JSON; the property fails (CATCH's evidence, mutant cbd6610b04)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original: '\t\t\t...(body === "" ? [] : [body])\n\t\t],\n\t\t"\\n"',
			replacement: '\t\t\t...(body === "" ? [] : [body]),\n\t\t\t...requestId\n\t\t],\n\t\t"\\n"',
			why: "The request id's line is printed again after the body; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/output.ts",
			original:
				"\treturn methodRetried && isExchangeFailure(error) ? Option.some(retryHint) : Option.none()",
			replacement: "\treturn isExchangeFailure(error) ? Option.some(retryHint) : Option.none()",
			why: "Every exchange failure carries the retry hint, after a POST too; the property fails."
		}
	]
})
