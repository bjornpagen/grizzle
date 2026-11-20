/**
 * Every recorded value leaves the runtime's output as its placeholder, in every form a server echoes it in (design 7.5,
 * audit F1, F2, M F1, S2, HB1, the review of bd3128a): a credential as sent, a basic credential's token and password
 * alone, a query key URL-, request-target- and form-encoded, and a secret file's text with and without its line end,
 * each of those encoded, JSON-escaped and ASCII-escaped in either hex case. Each path that prints a server's text
 * replaces the form with `<redacted:<label>>` between the text around it: the scrub, the scrub around a strip (which is
 * the same again on its own result, a placeholder being opaque), and an error body read across any cut into chunks.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	aimedEchoes,
	type EchoFeature,
	echoFeatures,
	expectedOf,
	SITUATIONS,
	scrubbedOf
} from "#test/runtime/redact.fixtures.ts"

/**
 * A recorded value echoed in any of its forms prints as its placeholder on every path. It replaces twenty example cases
 * (redact.test.ts's) and output.test.ts's eleven scrubbing cases; its floor of 17 is one aimed witness per kind and
 * form, its rotating stream 68 drawn echoes.
 */
export const scrubbedEchoes = property.explore(aimedEchoes, {
	needs: {},
	situations: SITUATIONS satisfies ReadonlyArray<Reached<EchoFeature>>,
	check: (_, c: Case<EchoFeature>) => (echo) =>
		Effect.gen(function* () {
			c.noteAll(echoFeatures(echo))
			const scrubbed = yield* scrubbedOf(echo)
			assert.deepEqual(scrubbed, expectedOf(echo))
		}),
	oracle: {
		kind: "specification",
		name: "the design's wire forms of each recorded value, each replaced by its placeholder on every print path"
	},
	kept: [],
	budget: { runs: 68, steered: 68 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: '\treturn Arr.filter(Arr.dedupe(forms), (form) => form !== "")',
			replacement: '\treturn Arr.filter(Arr.dedupe(forms), (form) => form === "")',
			why: "Only empty forms are kept, so no form of any value is scrubbed; the property fails (CATCH's evidence, mutant 14294898a7)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "0xdc_00",
			replacement: "56321",
			why: "An astral character's low surrogate is escaped one unit off, so its ASCII-escaped echo is not found; the property fails (CATCH's evidence, mutant 2c2908bfb9)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "\twhile (end > 0 && Option.exists(Str.charAt(end - 1)(text), isLineEnd)) {",
			replacement: "\twhile (end > 0 && Option.exists(Str.charAt(end - 2)(text), isLineEnd)) {",
			why: "A secret's trailing line end is never dropped, so its echo without the line end survives; the property fails (CATCH's evidence, mutant 5936e85377)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "remaining > 0 && end > 0",
			replacement: "end > 0",
			why: "A trailing fragment's kept tail ignores how much of the form remains; the property fails (CATCH's evidence, mutant 617827d0de)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: ">=",
			replacement: "<",
			why: "Every code point is split into surrogates and none above U+FFFF is, so ASCII-escaped echoes are not found; the property fails (CATCH's evidence, mutant e78ba68245)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original:
				"\tfor (let at = Math.max(0, text.length - form.length + 1); at < text.length; at += 1) {",
			replacement:
				"\tfor (let at = Math.max(0, text.length - form.length + 1); at < text.length; at += 2) {",
			why: "A text's trailing prefix of a form is searched one character short; the property fails (CATCH's evidence, mutant f088f15b14)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/redact.ts",
			original: "at = run.end",
			replacement: "{}",
			why: "The scrub never moves past a replaced run, so the text after an echo is written twice; the property fails (CATCH's evidence, mutant f40c91ecd4)."
		}
	]
})
