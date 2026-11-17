/**
 * A `text/event-stream` body is read as WHATWG HTML's "Parsing an event stream" reads it, whatever chunks it arrives
 * in, with the generator's record bound; and an event stream writes each event under its contract, stopping where its
 * stop point says.
 *
 * - The parser (sseParser): framings generated from event lists, with comments, unknown fields, ignored `retry` and
 *   `id` lines, blocks with no data, fields without a colon, a byte order mark, every line end, malformed UTF-8 and a
 *   last line cut short, encoded and cut into chunks of any size. Oracles: a transcription of the WHATWG algorithm over
 *   the whole body decoded at once, with the bound's two readings; and, under the production bound, the generating
 *   events themselves.
 * - The event stream (eventStream): event lists under generated contracts, open or closed, stop points and outputs.
 *   Oracle: the contract's specification: each event's line, or its bytes, through the first stop event (a `ready` with
 *   a `next` is none, and only its `next` may follow it); after an `error` event the failure with the verdict its
 *   data's pointer gives; `unexpectedEvent` for an event a closed contract does not name or one other than the `next`
 *   its `ready` named, its bytes written first under the raw output; `invalidData` for an event whose row checks its
 *   data against a schema that refuses it, never printed as a line, its bytes written first under the raw output, as
 *   they arrive; `truncated` for a stream whose contract names a role and that ends before either.
 *
 * Features: every line end, a CRLF and a character split across chunks, multi-line data, the default type, a comment,
 * an unknown field, a field without a colon, a block with no data, the byte order mark, malformed UTF-8, an id carried
 * on, retry digits with leading zeros, a body cut inside an event, a record over the bound; a stop at ready, a stream
 * followed past ready, an end, failures safe and never, invalid JSON data, a lifecycle cut short, an open stream to its
 * end, raw bytes, an undeclared event type, a ready read past to its next event, an unexpected event, and data its
 * schema admits and refuses.
 */

import { deepStrictEqual } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	bodyOf,
	chunked,
	chunkStarts,
	controlSpace,
	type ControlFeature,
	controlFeatures,
	expectedOf,
	framing,
	parsedReading,
	type ParseFeature,
	parseFeatures,
	productionBound,
	referenceRead,
	sourceReading
} from "#test/runtime/sse.fixtures.ts"

/**
 * The SSE parser reads every framing as WHATWG reads the whole body, and as the events it was framed from. Its budget is the count its suite stated
 * before the conversion: 1000 independent cases, and up to 2000 steered while a situation is unreached.
 */
export const sseParser = property.explore(framing, {
	needs: {},
	situations: [
		"LF line end",
		"CR line end",
		"CRLF line end",
		"CRLF split across chunks",
		"character split across chunks",
		"multi-line data",
		"default type",
		"comment",
		"unknown field",
		"field without a colon",
		"block with no data",
		"byte order mark",
		"malformed UTF-8",
		"id carried on",
		"retry with leading zeros",
		"body cut inside an event",
		"record over the bound"
	] satisfies ReadonlyArray<Reached<ParseFeature>>,
	check: (_, c: Case<ParseFeature>) => (framed) =>
		Effect.sync(() => {
			const body = bodyOf(framed)
			const starts = chunkStarts(body.length, framed.chunks)
			const reading = parsedReading(chunked(body, starts), framed.bound)
			const reference = referenceRead(body, framed.bound)
			c.noteAll(parseFeatures(framed, body, starts, reference))
			deepStrictEqual(reading, reference)
			if (framed.bound === productionBound) {
				deepStrictEqual(reading, sourceReading(framed))
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "a transcription of WHATWG's event-stream parsing over the whole body decoded at once"
	},
	kept: [],
	budget: { runs: 1000, steered: 2000 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: "state.dataBytes += value.length + 1",
			replacement: "{}",
			why: "A data line's bytes are not counted toward the record bound, so a record over the bound is read whole; the property fails (CATCH's evidence, mutant 170e92bd40)."
		}
	]
})

/**
 * An event stream writes each event under its contract through its stop point, and fails as the contract says. Its budget is the count its suite stated
 * before the conversion: 1000 independent cases, and up to 2000 steered while a situation is unreached.
 */
export const eventStream = property.explore(controlSpace, {
	needs: {},
	situations: [
		"stopped at ready",
		"followed past ready",
		"ended at end",
		"failed, retry safe",
		"failed, retry never",
		"invalid JSON data",
		"lifecycle cut short",
		"open stream to its end",
		"raw bytes",
		"undeclared event type",
		"ready read past to its next event",
		"unexpected event",
		"data its schema admits",
		"data its schema refuses"
	] satisfies ReadonlyArray<Reached<ControlFeature>>,
	check: (_, c: Case<ControlFeature>) => (control) =>
		Effect.gen(function* () {
			const expected = yield* expectedOf(control)
			const actual = yield* actualOf(control)
			c.noteAll(controlFeatures(control, expected))
			deepStrictEqual(actual, expected)
		}),
	oracle: {
		kind: "specification",
		name: "the event contract: each event's line or bytes through the first stop event, and the failure an error event names"
	},
	kept: [],
	budget: { runs: 1000, steered: 2000 },
	kills: [
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original:
				'\t\t\t\t\t? Option.some<EventRow>({ data: contract.otherwise.data, role: "item" })\n\t\t\t\t\t: Option.none()',
			replacement:
				'\t\t\t\t\t? Option.some<EventRow>({ data: contract.otherwise.data, role: "item" })\n\t\t\t\t\t: Option.some<EventRow>({ data: "text", role: "item" })',
			why: "An event a closed contract does not name is read as a text item instead of breaking the contract; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original:
				'row.role === "end" || (row.role === "ready" && !("next" in row) && settings.stopAt === "ready")',
			replacement: 'row.role === "end" || (row.role === "ready" && settings.stopAt === "ready")',
			why: "A `ready` with a `next` is taken as the stop point, so the one event it names is never read; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original:
				'const admitted = (data: EventData, text: string): boolean =>\n\ttypeof data === "string" ||',
			replacement: "const admitted = (data: EventData, text: string): boolean =>\n\ttrue ||",
			why: "admitted answers true for every data, so data its row's schema refuses is printed instead of failing the stream; the property fails."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/sequential.ts",
			original: '[\n\t["{", 1],\n\t["[", 1],\n\t["}", -1],\n\t["]", -1]\n]',
			replacement: '[["{", 1], ["}", -1], ["]", -1]]',
			why: "`[` no longer adds a container depth, so a JSON record holding an array is read at the wrong depth; the property fails (CATCH's evidence, mutant 9b617f6911)."
		},
		{
			file: "packages/generator/src/runtime-src/runtime/sse.ts",
			original: 'row.role !== "item"',
			replacement: "false",
			why: "No contract reads as having a lifecycle, so a stream cut before its terminal event passes as complete; the property fails (CATCH's evidence, mutant 02ed788d4e)."
		}
	]
})
