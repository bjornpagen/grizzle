/**
 * Sequential JSON bodies frame as their records. An NDJSON or JSON-seq body, cut into chunks anywhere (inside a record,
 * a terminator or a character), yields each record compacted (the whitespace between its tokens removed, its numbers
 * past 2^53, escapes, raw U+2028 and key order kept byte for byte), skipping blank lines, empty JSON-seq records and
 * leading whitespace, until the first record that fails: one past the bound (its bytes as written) as recordTooLarge,
 * one whose bytes are no UTF-8 as invalidText, one the compactor would change (an unopened close, a raw control
 * character in a string, two values apart only by whitespace) as invalidFraming, one cut short as truncated, and in
 * JSON-seq text after a record's closing LF as invalidFraming at the next index; a byte order mark is a character, so
 * a body that opens with one fails as invalidFraming at its first record. A JSON-seq record is emitted as its LF
 * arrives, before the body's next chunk is pulled.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	bodies,
	type BodyFeature,
	bodyFeatures,
	expectedOf,
	paced,
	pacedActual,
	pacedExpected
} from "#test/runtime/sequential.fixtures.ts"

/**
 * A sequential body frames as its compacted records up to its first failing one. It replaces thirty example cases
 * (sequential-json.test.ts's 24 with its malformed table, sequential-json-seq.test.ts's 6); its floor of 19 is one aimed
 * witness per required situation, its rotating stream 68 drawn bodies.
 */
export const sequentialRecords = property.explore(bodies, {
	needs: {},
	situations: [
		"NDJSON",
		"JSON-seq",
		"a number past 2^53",
		"an escape kept as written",
		"a raw U+2028",
		"whitespace inside a record",
		"a line feed inside a JSON-seq record",
		"a CRLF terminator",
		"a blank line or an empty record",
		"leading whitespace",
		"a record split across chunks",
		"a record exactly at the bound",
		"a record one byte past the bound",
		"a wide character in a bounded record",
		"a record the compactor would change",
		"a record cut short",
		"text after a JSON-seq record",
		"a record that is no UTF-8",
		"an NDJSON line that is no UTF-8 ends the stream",
		"a byte order mark"
	] satisfies ReadonlyArray<Reached<BodyFeature>>,
	check: (_, c: Case<BodyFeature>) => (body) =>
		Effect.gen(function* () {
			c.noteAll(bodyFeatures(body))
			const framed = yield* actualOf(body)
			assert.deepEqual(framed, expectedOf(body))
		}),
	oracle: {
		kind: "specification",
		name: "the records a body's tokens make, compacted, in order, up to the first record's failure"
	},
	kept: [],
	budget: { runs: 68, steered: 68 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: "scan.afterValue && !scan.inScalar",
			replacement: "!scan.inScalar",
			why: "A value right after a punctuation-free value start is read as joining another, so a record whose scalars follow `,` or `:` fails as invalidFraming; the property fails (CATCH's evidence, mutant 7677fad55d)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: '\tif (compacted.status === "truncated" || !closedByLineFeed.test(record)) {',
			replacement: '\tif (compacted.status !== "truncated" || !closedByLineFeed.test(record)) {',
			why: "A complete JSON-seq record closed by its LF fails as truncated and a cut one passes; the property fails (CATCH's evidence, mutant 2aa3c002ab)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: '[\n\t["{", 1],\n\t["[", 1],\n\t["}", -1],\n\t["]", -1]\n]',
			replacement: '[["[", 1], ["}", -1], ["]", -1]]',
			why: "`{` no longer opens a container, so an object's closing `}` reads as a close that was never opened and every object record fails as invalidFraming; the property fails (CATCH's evidence, mutant a2aafac954)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: "): boolean => bytes > maxRecordBytes",
			replacement: "): boolean => false",
			why: "No NDJSON line passes the bound, so a line over it is read whole; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original:
				'{\n\tif (char < firstRawStringCharacter) {\n\t\treturn false\n\t}\n\n\tscan.inString = scan.escaped || char !== \'"\'\n\tscan.escaped = !scan.escaped && char === "\\\\"\n\tscan.afterValue = !scan.inString\n\n\treturn true\n}',
			replacement: "{ return true }",
			why: "A string's characters are not scanned, so a raw control character in a string passes and a string's end is never seen; the property fails (CATCH's evidence, mutant 7e756d706b)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: "return outputsOf(records, failure)",
			replacement: "return outputsOf(records, Option.none())",
			why: "A JSON-seq framing failure is dropped instead of ending the stream, so the body reads as fewer records with no failure; the property fails (CATCH's evidence, mutant f562ff3bda)."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: 'return [failed(state, "invalidText")]',
			replacement: "return []",
			why: "An NDJSON line whose bytes are no UTF-8 is skipped as if blank, so the body reads as fewer records with no failure; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: 'return Option.some(new ResponseStreamError({ itemIndex, reason: "invalidText" }))',
			replacement: "return Option.none()",
			why: "A JSON-seq line whose bytes are no UTF-8 is dropped from its record, so the record reads without it and no failure ends the stream; the property fails."
		}
	]
})

/**
 * A JSON-seq record is emitted before the body's next chunk is pulled. It replaces six example cases; its budget is 8
 * drawn bodies, its floor 2.
 */
export const jsonSeqPaced = property.explore(paced, {
	needs: {},
	situations: [],
	check: () => (records) =>
		Effect.gen(function* () {
			const log = yield* pacedActual(records)
			assert.deepEqual(log, pacedExpected(records))
		}),
	oracle: {
		kind: "specification",
		name: "each record emitted at its LF, before the next chunk's pull"
	},
	kept: [],
	budget: { runs: 8, steered: 0 },
	kills: [
		{
			file: "packages/cli-generator/src/runtime-src/runtime/sequential.ts",
			original: "if (completeAtLineFeed(state)) {",
			replacement: "if (false) {",
			why: "A record no longer closes at the LF that completes its JSON text, so it waits for the next separator and is emitted only after the next chunk is pulled; the property fails."
		},
		{
			file: "packages/cli-generator/src/runtime-src/runtime/json.ts",
			original: "JSON.parse(text)",
			replacement: 'JSON.parse("")',
			why: "The JSON door reads no text as JSON, so no JSON-seq record closes at the LF that completes it and each waits for the next separator; the property fails."
		}
	]
})
