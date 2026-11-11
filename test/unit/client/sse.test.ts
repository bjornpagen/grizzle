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
 *
 * Plants (~/.cache/grizzle-release/LIVE-CLIENT/plants): sse-chunk-splits-line (a chunk's unended line read as a whole
 * line), sse-cr-lf-across-chunks (an LF opening a chunk after a CR ending the last read as a second line end).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, boolean, element, type Gen, int, string, weighted } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Result,
	Stream,
	String as Str
} from "effect"
import { type SseEvent, sseEvents } from "#client/sse.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** The characters a value is drawn from: ASCII, a colon, a space, the byte order mark, and two-, three- and four-byte UTF-8. */
const VALUE_CHARACTERS = ["a", "Z", "0", ":", " ", "\uFEFF", "é", "€", "😀", "\u0000"] as const

/** A line's end: CRLF, LF or CR. */
type End = "\r\n" | "\n" | "\r"

const ENDS = ["\n", "\r\n", "\r"] as const

/** One part of an event, as it is written: a data line, an event line, or a line that carries nothing an event holds. */
type Part =
	| Readonly<{ kind: "data"; value: string; spelling: "spaced" | "tight" | "bare" }>
	| Readonly<{ kind: "event"; value: string }>
	| Readonly<{ kind: "noise"; line: string }>

const value: Gen<string> = string(element(VALUE_CHARACTERS), { min: 0, max: 6 })

/** A data line's value and its spelling: `data: v`, `data:v` (a value that opens with no space), or `data` (empty). */
const dataPart: Gen<Part> = (source) => {
	const drawnValue = source.draw(value)
	const spellings: ReadonlyArray<"spaced" | "tight" | "bare"> = [
		"spaced",
		...(Str.startsWith(" ")(drawnValue) ? [] : (["tight"] as const)),
		...(drawnValue === "" ? (["bare"] as const) : [])
	]
	return {
		kind: "data",
		value: drawnValue,
		spelling: source.draw(
			element(Option.getOrThrow(Option.liftPredicate(spellings, Arr.isReadonlyArrayNonEmpty)))
		)
	}
}

/** The lines that carry nothing an event holds: comments, ids, retries, unknown fields. */
const noisePart: Gen<Part> = (source) => ({
	kind: "noise",
	line: source.draw(
		weighted<string>([
			[3, (s) => `:${s.draw(value)}`],
			[1, (s) => `id: ${s.draw(value)}`],
			[1, () => "id"],
			[1, (s) => `retry: ${s.draw(int(0, 9999))}`],
			[1, (s) => `retry:${s.draw(value)}`],
			[1, (s) => `datum: ${s.draw(value)}`],
			[1, (s) => `Data: ${s.draw(value)}`]
		])
	)
})

const eventPart: Gen<Part> = (source) => ({
	kind: "event",
	value: source.draw(element(["", "message", "reset", "upsert", "x y", "é:z"] as const))
})

const parts: Gen<ReadonlyArray<Part>> = array(
	weighted<Part>([
		[4, dataPart],
		[2, noisePart],
		[1, eventPart]
	]),
	{ min: 0, max: 5 }
)

/** A part's text, as its line spells it. */
const lineOf = (part: Part): string => {
	switch (part.kind) {
		case "data":
			return part.spelling === "spaced"
				? `data: ${part.value}`
				: part.spelling === "tight"
					? `data:${part.value}`
					: "data"
		case "event":
			return `event: ${part.value}`
		case "noise":
			return part.line
	}
}

/** The event a block of parts means once a blank line ends it: none without a data line. */
const meant = (block: ReadonlyArray<Part>): Result.Result<SseEvent, void> => {
	const data = Arr.filterMap(block, (part) =>
		part.kind === "data" ? Result.succeed(part.value) : Result.failVoid
	)
	const types = Arr.filterMap(block, (part) =>
		part.kind === "event" ? Result.succeed(part.value) : Result.failVoid
	)
	const type = Option.getOrElse(Arr.last(types), () => "")
	return Arr.isReadonlyArrayNonEmpty(data)
		? Result.succeed({ type: type === "" ? "message" : type, data: Arr.join(data, "\n") })
		: Result.failVoid
}

/** A drawn stream: its blocks, each ended by a blank line, its unended tail, whether a BOM opens it, its lines' ends. */
type Drawn = Readonly<{
	blocks: ReadonlyArray<ReadonlyArray<Part>>
	tail: ReadonlyArray<Part>
	bom: boolean
	text: string
	bytes: Uint8Array
	cuts: ReadonlyArray<number>
	ends: ReadonlyArray<End>
}>

const utf8 = new TextEncoder()

/**
 * The stream's text: each block's lines, then its blank line, then the tail's lines, the last of them unended where
 * the tail ends mid-line. Each line's end is drawn, an LF never ending an empty line a CR precedes.
 */
const streams: Gen<Drawn> = (source) => {
	const blocks = source.draw(array(parts, { min: 0, max: 4 }))
	const tail = source.draw(parts)
	const bom = source.draw(boolean)
	const lines = [
		...Arr.flatMap(blocks, (block) => [...Arr.map(block, lineOf), ""]),
		...Arr.map(tail, lineOf)
	]
	const ends: Array<End> = []
	let text = bom ? "\uFEFF" : ""
	for (const [at, line] of lines.entries()) {
		const previous = ends[at - 1]
		const allowed: ReadonlyArray<End> = previous === "\r" && line === "" ? ["\r\n", "\r"] : ENDS
		const unended =
			at === lines.length - 1 && Arr.isReadonlyArrayNonEmpty(tail) && source.draw(boolean)
		const end = source.draw(
			element(Option.getOrThrow(Option.liftPredicate(allowed, Arr.isReadonlyArrayNonEmpty)))
		)
		ends.push(end)
		text = unended ? `${text}${line}` : `${text}${line}${end}`
	}
	const bytes = utf8.encode(text)
	const cuts = Arr.dedupe(
		Arr.sort(
			source.draw(array(int(1, Math.max(1, bytes.length - 1)), { min: 0, max: 8 })),
			Order.Number
		)
	)
	return { blocks, tail, bom, text, bytes, cuts, ends }
}

/** The stream's bytes cut at its cut positions, every chunk nonempty. */
const chunksOf = (drawnStream: Drawn): ReadonlyArray<Uint8Array> => {
	const bounds = [
		0,
		...Arr.filter(drawnStream.cuts, (cut) => cut < drawnStream.bytes.length),
		drawnStream.bytes.length
	]
	return Arr.filterMap(Arr.zip(bounds, Arr.drop(bounds, 1)), ([from, to]) =>
		to > from ? Result.succeed(drawnStream.bytes.subarray(from, to)) : Result.failVoid
	)
}

/**
 * The grammar read over the whole text, as the specification states it (HTML, "Interpreting an event stream"): a
 * leading byte order mark dropped; lines split at CRLF, LF or CR, the text after the last line end being no line; an
 * empty line dispatches the event when its data buffer is nonempty, its last line feed removed; a line opening with a
 * colon is a comment; a field's value is the text after its first colon, one leading space removed; `event` sets the
 * type buffer and `data` appends its value and a line feed to the data buffer.
 */
const reference = (text: string): ReadonlyArray<SseEvent> => {
	const body = Str.startsWith("\uFEFF")(text) ? Str.slice(1)(text) : text
	const lines: Array<string> = []
	let current = ""
	for (let at = 0; at < body.length; at += 1) {
		const character = body[at] ?? ""
		if (character === "\r" || character === "\n") {
			lines.push(current)
			current = ""
			if (character === "\r" && body[at + 1] === "\n") {
				at += 1
			}
		} else {
			current += character
		}
	}
	const events: Array<SseEvent> = []
	let type = ""
	let data = ""
	for (const line of lines) {
		const colon = Str.indexOf(":")(line)
		const field = Option.match(colon, {
			onNone: () => line,
			onSome: (at) => Str.slice(0, at)(line)
		})
		const raw = Option.match(colon, { onNone: () => "", onSome: (at) => Str.slice(at + 1)(line) })
		const fieldValue = Str.startsWith(" ")(raw) ? Str.slice(1)(raw) : raw
		const comment = Option.contains(colon, 0)
		if (line === "") {
			if (data !== "") {
				events.push({
					type: type === "" ? "message" : type,
					data: Str.endsWith("\n")(data) ? Str.slice(0, -1)(data) : data
				})
			}
			type = ""
			data = ""
		} else if (!comment && field === "event") {
			type = fieldValue
		} else if (!comment && field === "data") {
			data = `${data}${fieldValue}\n`
		}
	}
	return events
}

type Feature =
	| "an LF line"
	| "a CRLF line"
	| "a CR line"
	| "a chunk boundary inside a line"
	| "a chunk boundary inside a character"
	| "a chunk boundary between a CR and its LF"
	| "a comment"
	| "an event of several data lines"
	| "an event with no data line"
	| "an unended tail"
	| "a leading byte order mark"

/** Whether a byte position lies inside a line: neither byte beside it is a line's end. */
const insideLine = (bytes: Uint8Array, cut: number): boolean => {
	const before = bytes[cut - 1]
	const after = bytes[cut]
	return before !== 0x0a && before !== 0x0d && after !== 0x0a && after !== 0x0d
}

describe("the client's event-stream reader", () => {
	it.effect("reads every framing of an event stream into exactly the events it means", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/client/sse",
					oracle: {
						kind: "second-implementation",
						name: "the events the drawn stream means, and the WHATWG grammar read over the whole text at once"
					},
					draw: drawn(streams),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"an LF line",
							"a CRLF line",
							"a CR line",
							"a chunk boundary inside a line",
							"a chunk boundary inside a character",
							"a chunk boundary between a CR and its LF",
							"a comment",
							"an event of several data lines",
							"an event with no data line",
							"an unended tail",
							"a leading byte order mark"
						],
						{ cases: 400, sense: notesOnly }
					),
					kept: [],
					runs: 400,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(drawnStream, c) =>
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
						}
						for (const block of drawnStream.blocks) {
							if (
								Arr.some(block, (part) => part.kind === "noise" && Str.startsWith(":")(part.line))
							) {
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
						const read = yield* Stream.runCollect(
							sseEvents(Stream.fromIterable(chunksOf(drawnStream)))
						)
						const expected = Arr.filterMap(drawnStream.blocks, meant)
						assert.deepEqual(read, expected)
						assert.deepEqual(reference(drawnStream.text), expected)
					})
			)
		)
	)
})
