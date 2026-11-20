/**
 * A 2xx body is written as design 4.6 says: an NDJSON or JSON-seq body (any of their media types, parameters and the
 * `+json-seq` suffix included) one compact line per record, bounded by `--max-record-bytes`; any other body, and a
 * sequential one under `--raw`, byte for byte as received; to the `--output` file when given, else to stdout, where a
 * binary body to a terminal is refused before it is read and sequential lines are text; a stdout whose reader goes away
 * ends the write as a success.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	aimedWrites,
	comparable,
	expectedOf,
	type WrittenFeature,
	writtenFeatures,
	writtenIn
} from "#test/runtime/output-sequential.fixtures.ts"

/**
 * A response body reaches its destination framed or as received, as its media type and the settings say. It replaces
 * nine example cases; its rotating stream is nine drawn writes, its floor and steered phase reach each situation by an
 * aimed one.
 */
export const responseWritten = property.explore(aimedWrites, {
	needs: { dir: Scratch.dir },
	situations: [
		"an NDJSON body framed",
		"a JSON-seq body framed",
		"a media type with parameters",
		"a +json-seq suffix",
		"a text body as received",
		"a binary body as received",
		"--raw on a sequential body",
		"a record past --max-record-bytes",
		"a binary body refused at a terminal",
		"sequential lines at a terminal",
		"--output",
		"a stdout that breaks"
	] satisfies ReadonlyArray<Reached<WrittenFeature>>,
	check:
		({ dir }, c: Case<WrittenFeature>) =>
		(written) =>
			Effect.gen(function* () {
				const expected = expectedOf(written)
				c.noteAll(writtenFeatures(written, expected))
				const scratch = yield* dir
				const outcome = yield* writtenIn(scratch, written)
				assert.deepEqual(comparable(written, outcome, expected), expected)
			}),
	oracle: {
		kind: "specification",
		name: "design 4.6's dispatch: framed lines or bytes as received, to the file or stdout"
	},
	kept: [],
	budget: { runs: 9, steered: 24 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sequential.ts",
			original: '[\n\t["{", 1],\n\t["[", 1],\n\t["}", -1],\n\t["]", -1]\n]',
			replacement: '[["[", 1], ["}", -1], ["]", -1]]',
			why: "`{` no longer opens a container, so every NDJSON or JSON-seq object record fails to frame; the property fails (CATCH's evidence, mutant a2aafac954)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/sequential.ts",
			original: 'jsonSeqSuffix.test(essence) ? "jsonseq" : undefined',
			replacement: 'jsonSeqSuffix.test(essence) ? undefined : "jsonseq"',
			why: "A `+json-seq` media type reads as no sequence and every other unknown type as JSON-seq; the property fails (CATCH's evidence, mutant cb8df60b74)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: "mediaType !== undefined && textMediaType.test(mediaType.trim())",
			replacement: "mediaType !== undefined",
			why: "Every media type reads as text, so a binary body is written to a terminal instead of refused; the property fails (CATCH's evidence, mutant 083bb5336d)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/output.ts",
			original: '\t\treturn codec === undefined || codec === "sse" || raw\n',
			replacement: '\t\treturn codec === undefined || codec === "sse"\n',
			why: "`--raw` no longer returns a sequential body as received: it is framed; the property fails."
		}
	]
})
