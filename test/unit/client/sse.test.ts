/**
 * The client's event-stream reader (packages/grizzle/src/client/sse.ts sseEvents): an event stream drawn from the
 * WHATWG grammar's own vocabulary, written as UTF-8 and cut into chunks anywhere, is read into exactly the events it
 * means, whatever its framing.
 *
 * - The stream: events of data lines (none, one or several, a value empty, spaced, unspaced, holding colons, spaces,
 *   a byte order mark and characters of two, three and four UTF-8 bytes), each with an `event` field or none, or several
 *   of which the last wins, beside lines that carry nothing an event holds (comments, `id`, `retry`, unknown fields),
 *   each line ended by CRLF, LF or CR, an optional leading byte order mark, and a tail the bytes leave unended. A CR is
 *   never followed by the LF of an empty line, which would make one CRLF of them.
 * - The cut: any set of byte positions, inside a line, inside a character, between a CR and its LF.
 *
 * Oracles: the events the drawn stream means (its parts' data lines and last type, every event with no data line
 * dispatching nothing, and the unended tail dispatching nothing), and a second implementation, the grammar read over
 * the whole text at once, line by line as the specification states it. Features: each line ending, a chunk boundary
 * inside a line, inside a character and between a CR and its LF, a comment, an event of several data lines, an event
 * with no data line, an unended tail, and a leading byte order mark.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, String as Str, Stream } from "effect"
import { sseEvents } from "#client/sse.ts"
import { assert } from "#test/support/assert.ts"
import {
	chunksOf,
	type Feature,
	insideLine,
	meant,
	reference,
	streams
} from "#test/unit/client/sse.fixtures.ts"

/** The client's event-stream reader reads every framing of an event stream into exactly the events it means. */
export const theClientsEventStreamReaderReadsEveryFramingOfAnEventStreamIntoExactlyTheEventsItMeans =
	property.explore(streams, {
		needs: {},
		situations: [
			"an LF line",
			"a CRLF line",
			"a CR line",
			"a chunk boundary inside a line",
			"a chunk boundary inside a character",
			"a chunk boundary between a CR and its LF",
			"a chunk boundary between a CR and its LF ending a data line its event reads on after",
			"a comment",
			"an event of several data lines",
			"an event with no data line",
			"an unended tail",
			"a leading byte order mark"
		] satisfies ReadonlyArray<Reached<Feature>>,
		check: (_, c: Case<Feature>) => (drawnStream) =>
			Effect.gen(function* () {
				for (const end of drawnStream.ends) {
					c.note(end === "\n" ? "an LF line" : end === "\r\n" ? "a CRLF line" : "a CR line")
				}
				for (const cut of drawnStream.cuts) {
					const byte = drawnStream.bytes[cut] ?? 0
					if (cut < drawnStream.bytes.length && insideLine(drawnStream.bytes, cut)) {
						c.note("a chunk boundary inside a line")
					}
					if ((byte & 0xc0) === 0x80) {
						c.note("a chunk boundary inside a character")
					}
					if (drawnStream.bytes[cut - 1] === 0x0d && byte === 0x0a) {
						c.note("a chunk boundary between a CR and its LF")
					}
					if (Arr.contains(drawnStream.readOn, cut)) {
						c.note(
							"a chunk boundary between a CR and its LF ending a data line its event reads on after"
						)
					}
				}
				for (const block of drawnStream.blocks) {
					if (Arr.some(block, (part) => part.kind === "noise" && Str.startsWith(":")(part.line))) {
						c.note("a comment")
					}
					const data = Arr.filter(block, (part) => part.kind === "data").length
					if (data === 0) {
						c.note("an event with no data line")
					} else if (data > 1) {
						c.note("an event of several data lines")
					}
				}
				if (Arr.isReadonlyArrayNonEmpty(drawnStream.tail)) {
					c.note("an unended tail")
				}
				if (drawnStream.bom) {
					c.note("a leading byte order mark")
				}
				const read = yield* Stream.runCollect(sseEvents(Stream.fromIterable(chunksOf(drawnStream))))
				const expected = Arr.filterMap(drawnStream.blocks, meant)
				assert.deepEqual(read, expected)
				assert.deepEqual(reference(drawnStream.text), expected)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the events the drawn stream means, and the WHATWG grammar read over the whole text at once"
		},
		kept: [],
		kills: [
			{
				file: "packages/grizzle/src/client/sse.ts",
				original: "\tlet line = reading.line",
				replacement: '\tif (reading.line.length > 0) take(reading.line)\n\tlet line = ""',
				why: "A chunk's unended line is read as a whole line."
			},
			{
				file: "packages/grizzle/src/client/sse.ts",
				original: "\tlet start = reading.afterReturn && text.charCodeAt(0) === 0x0a ? 1 : 0",
				replacement: "\tlet start = 0",
				why: "An LF opening a chunk after a CR ending the last is read as a second line end."
			}
		]
	})
