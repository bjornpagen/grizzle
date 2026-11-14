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
 *   its `ready` named, its bytes written first under the raw output; `truncated` for a stream whose contract names a role and that ends before either.
 *
 * Features: every line end, a CRLF and a character split across chunks, multi-line data, the default type, a comment,
 * an unknown field, a field without a colon, a block with no data, the byte order mark, malformed UTF-8, an id carried
 * on, retry digits with leading zeros, a body cut inside an event, a record over the bound; a stop at ready, a stream
 * followed past ready, an end, failures safe and never, invalid JSON data, a lifecycle cut short, an open stream to its
 * end, raw bytes, an undeclared event type, a ready read past to its next event, and an unexpected event.
 *
 * Plants (~/.cache/effect-openapi-cli-generator/plants): sse-joins-across-blank-line.patch (a blank line dispatches
 * the event without clearing its data, so the next event's data joins it), sse-stops-before-ready.patch (the stream
 * stops one event before its stop point); and, applied to src/runtime-src/runtime/sse.ts, seen to fail and reverted, an
 * event outside a closed contract read as a text item, and a `ready` with a `next` taken as the stop point.
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	production,
	string
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Cause,
	Duration,
	Effect,
	Exit,
	Formatter,
	Option,
	Record as Rec,
	Schema,
	Stream,
	String as Str
} from "effect"
import {
	type EventContract,
	type EventData,
	type EventOtherwise,
	type EventOutput,
	type EventRow,
	eventStream,
	hasLifecycle,
	type Parsed,
	sseParser,
	type StopAt
} from "#runtime-src/runtime/sse.ts"

/** The production record bound, 16 MiB, which no generated line reaches. */
const productionBound = 16 * 1024 * 1024

/** How far a line may pass the record bound: the longest field prefix, `data: `. */
const prefixBytes = 6

/** A line's end. */
type Ending = "\n" | "\r" | "\r\n"

/** How a field line separates its name from its value: no colon (an empty value), a colon, or a colon and a space. */
type Separator = "bare" | "colon" | "colon space"

/** A run of a value's bytes: text, or a byte sequence that is not UTF-8. */
type Piece =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "malformed"; bytes: ReadonlyArray<number> }>

/** One line of a framing, without its end. */
type Line =
	| Readonly<{ kind: "field"; name: string; separator: Separator; value: ReadonlyArray<Piece> }>
	| Readonly<{ kind: "comment"; value: ReadonlyArray<Piece> }>
	| Readonly<{ kind: "blank" }>

/** A line and its end. */
type Ended = Readonly<{ line: Line; ending: Ending }>

/** One event a framing is generated from: its `event`, `data` and `id` values, and its `retry` digits. */
type SourceEvent = Readonly<{
	type: Option.Option<string>
	data: Arr.NonEmptyReadonlyArray<ReadonlyArray<Piece>>
	id: Option.Option<string>
	retry: Option.Option<string>
}>

/** One part of a body: an event with the lines it is written as, or a block with no data, which dispatches nothing. */
type Part =
	| Readonly<{ kind: "event"; source: SourceEvent; lines: ReadonlyArray<Ended> }>
	| Readonly<{ kind: "block"; lines: ReadonlyArray<Ended> }>

/** A body to parse: its mark, its parts, its last line cut short, the record bound and the chunk sizes it cycles. */
type Framing = Readonly<{
	mark: boolean
	parts: ReadonlyArray<Part>
	tail: Option.Option<Line>
	bound: number
	chunks: Arr.NonEmptyReadonlyArray<number>
}>

/** The features the parsing property reaches. */
type ParseFeature =
	| "LF line end"
	| "CR line end"
	| "CRLF line end"
	| "CRLF split across chunks"
	| "character split across chunks"
	| "multi-line data"
	| "default type"
	| "comment"
	| "unknown field"
	| "field without a colon"
	| "block with no data"
	| "byte order mark"
	| "malformed UTF-8"
	| "id carried on"
	| "retry with leading zeros"
	| "body cut inside an event"
	| "record over the bound"

const textPiece = (value: string): Piece => ({ kind: "text", text: value })

const utf8 = (value: string): ReadonlyArray<number> =>
	Arr.fromIterable(new TextEncoder().encode(value))

const pieceBytes = (piece: Piece): ReadonlyArray<number> =>
	piece.kind === "text" ? utf8(piece.text) : piece.bytes

const valueBytes = (value: ReadonlyArray<Piece>): ReadonlyArray<number> =>
	Arr.flatMap(value, pieceBytes)

const valueText: Gen<string> = string(
	characterOf(["a", " ", ":", "é", "😀", "\u0000", "﻿", "{", '"', "1"]),
	{ min: 0, max: 4 }
)

const malformed: Gen<Piece> = map(
	element([[0xff], [0xe2, 0x82], [0xc3], [0xed, 0xa0, 0x80], [0x80]]),
	(bytes): Piece => ({ kind: "malformed", bytes })
)

const pieces: Gen<ReadonlyArray<Piece>> = array(oneOf([map(valueText, textPiece), malformed]), {
	min: 0,
	max: 3
})

const ending: Gen<Ending> = element(["\n", "\r", "\r\n"])

/** Whether a value's first byte is a space, which only a separator with a space keeps. */
const leadsWithSpace = (value: ReadonlyArray<Piece>): boolean =>
	Option.contains(Arr.head(valueBytes(value)), 0x20)

/** A field line whose value the parser reads as written: the separator never strips a space the value holds. */
const field =
	(name: string, value: Gen<ReadonlyArray<Piece>>): Gen<Line> =>
	(source) => {
		const drawnValue = value(source)
		const separators: Arr.NonEmptyReadonlyArray<Separator> = leadsWithSpace(drawnValue)
			? ["colon space"]
			: Arr.isReadonlyArrayEmpty(drawnValue)
				? ["colon", "colon space", "bare"]
				: ["colon", "colon space"]
		return { kind: "field", name, separator: element(separators)(source), value: drawnValue }
	}

/** A line with a drawn end. */
const endedLine =
	(line: Gen<Line>): Gen<Ended> =>
	(source) => ({ line: line(source), ending: ending(source) })

/** Lines that change no event: a comment, an unknown field, a `retry` without digits, an `id` holding NUL. */
const noiseLine: Gen<Line> = oneOf([
	map(pieces, (value): Line => ({ kind: "comment", value })),
	field("x", pieces),
	field("Data", pieces),
	field("data2", pieces),
	field("retry", constant([textPiece("1a")])),
	field("id", constant([textPiece("a\u0000b")]))
])

const sourceEvent: Gen<SourceEvent> = (source) => ({
	type: option(valueText)(source),
	data: [pieces(source), ...array(pieces, { min: 0, max: 2 })(source)],
	id: option(string(characterOf(["7", "a", " ", "é"]), { min: 0, max: 3 }))(source),
	retry: option(string(characterOf(["0", "1", "5"]), { min: 1, max: 3 }))(source)
})

/** The event's field lines, its data lines in their order and the others placed among them, noise before any of them,
 * then the blank line. */
const eventPart: Gen<Part> = (source) => {
	const event = sourceEvent(source)
	const dataLines = Arr.map(event.data, (value) =>
		endedLine(field("data", constant(value)))(source)
	)
	const others = Arr.getSomes([
		Option.map(event.type, (value) => field("event", constant([textPiece(value)]))),
		Option.map(event.id, (value) => field("id", constant([textPiece(value)]))),
		Option.map(event.retry, (value) => field("retry", constant([textPiece(value)])))
	])
	const placed = Arr.reduce(others, dataLines, (lines, line) =>
		Option.getOrElse(
			Arr.insertAt(lines, int(0, lines.length)(source), endedLine(line)(source)),
			() => lines
		)
	)
	const noisy = Arr.flatMap(placed, (line) => [
		...array(endedLine(noiseLine), { min: 0, max: 1 })(source),
		line
	])
	return {
		kind: "event",
		source: event,
		lines: [...noisy, endedLine(constant<Line>({ kind: "blank" }))(source)]
	}
}

/** A block with no data: an `event` field and noise, then the blank line. */
const blockPart: Gen<Part> = (source) => ({
	kind: "block",
	lines: [
		endedLine(
			field(
				"event",
				map(valueText, (value) => [textPiece(value)])
			)
		)(source),
		...array(endedLine(noiseLine), { min: 0, max: 2 })(source),
		endedLine(constant<Line>({ kind: "blank" }))(source)
	]
})

const framing: Gen<Framing> = (source) => ({
	mark: boolean(source),
	parts: array(oneOf([eventPart, blockPart]), { min: 0, max: 4 })(source),
	tail: option(oneOf([noiseLine, field("data", pieces)]))(source),
	bound: production(productionBound, [0, 1, 2, 3, 5, 8, 13])(source),
	chunks: [int(1, 7)(source), ...array(int(1, 7), { min: 0, max: 3 })(source)]
})

const separatorText: Readonly<Record<Separator, string>> = {
	bare: "",
	colon: ":",
	"colon space": ": "
}

const lineBytes = (line: Line): ReadonlyArray<number> => {
	switch (line.kind) {
		case "blank":
			return []
		case "comment":
			return [...utf8(":"), ...valueBytes(line.value)]
		case "field":
			return [...utf8(`${line.name}${separatorText[line.separator]}`), ...valueBytes(line.value)]
	}
}

const endedBytes = (line: Ended): ReadonlyArray<number> => [
	...lineBytes(line.line),
	...utf8(line.ending)
]

/**
 * A part's lines with no two read as one: a CR that ends a line and the LF that ends a blank line after it would read
 * as one CRLF, so that blank line ends with CRLF instead.
 */
const unambiguous = (lines: ReadonlyArray<Ended>): ReadonlyArray<Ended> =>
	Arr.map(lines, (line, index) =>
		line.line.kind === "blank" &&
		line.ending === "\n" &&
		Option.exists(Arr.get(lines, index - 1), (previous) => previous.ending === "\r")
			? { line: line.line, ending: "\r\n" }
			: line
	)

/** The framing's body as bytes. */
const bodyOf = (framed: Framing): Uint8Array =>
	Uint8Array.from([
		...(framed.mark ? [0xef, 0xbb, 0xbf] : []),
		...Arr.flatMap(framed.parts, (part) => Arr.flatMap(unambiguous(part.lines), endedBytes)),
		...Option.match(framed.tail, { onNone: () => [], onSome: lineBytes })
	])

/** Where the chunks of a body start, its sizes cycled from the first byte. */
const chunkStarts = (
	length: number,
	sizes: Arr.NonEmptyReadonlyArray<number>
): ReadonlyArray<number> =>
	Arr.unfold({ start: 0, turn: 0 }, (at) =>
		at.start < length
			? Option.some([
					at.start,
					{ start: at.start + Arr.getUnsafe(sizes, at.turn % sizes.length), turn: at.turn + 1 }
				] as const)
			: Option.none()
	)

/** The body cut at its chunk starts. */
const chunked = (body: Uint8Array, starts: ReadonlyArray<number>): ReadonlyArray<Uint8Array> =>
	Arr.map(starts, (start, index) =>
		body.subarray(
			start,
			Option.getOrElse(Arr.get(starts, index + 1), () => body.length)
		)
	)

/** An event as the oracles state it. */
type Read = Readonly<{
	type: string
	data: string
	id: Option.Option<string>
	retry: Option.Option<string>
}>

/** A reading: the events dispatched, then the failure that ended the stream, if any. */
type Reading = Readonly<{
	events: ReadonlyArray<Read>
	failure: Option.Option<Readonly<{ reason: string; itemIndex: number }>>
}>

/** The parser's reading of the body in its chunks. */
const parsedReading = (chunks: ReadonlyArray<Uint8Array>, bound: number): Reading => {
	const parser = sseParser(bound)
	const all: ReadonlyArray<Parsed> = [
		...Arr.flatMap(chunks, (chunk) => parser.step(chunk)),
		...parser.halt()
	]
	return {
		events: Arr.flatMap(all, (item) =>
			item._tag === "SseEvent"
				? [{ type: item.type, data: item.data, id: item.id, retry: item.retry }]
				: []
		),
		failure: Arr.head(
			Arr.flatMap(all, (item) =>
				item._tag === "ResponseStreamError"
					? [{ reason: item.reason, itemIndex: item.itemIndex ?? -1 }]
					: []
			)
		)
	}
}

/** The lines of decoded text, each ended by CR, LF or CRLF, and the text after the last line end. */
const linesOf = (decoded: string): Readonly<{ lines: ReadonlyArray<string>; rest: string }> => {
	const units = Str.split("")(decoded)
	const lines: Array<string> = []
	let start = 0
	let index = 0
	while (index < units.length) {
		const unit = Arr.getUnsafe(units, index)
		if (unit === "\r" || unit === "\n") {
			lines.push(Str.slice(start, index)(decoded))
			const crlf = unit === "\r" && Option.contains(Arr.get(units, index + 1), "\n")
			index += crlf ? 2 : 1
			start = index
		} else {
			index += 1
		}
	}
	return { lines, rest: Str.slice(start)(decoded) }
}

/**
 * The length in bytes received of each line of a body, split as `linesOf` splits its text, and of the bytes after the
 * last line end; the leading byte order mark is not part of the first line.
 */
const lineLengthsOf = (
	body: Uint8Array
): Readonly<{ lines: ReadonlyArray<number>; rest: number }> => {
	const lines: Array<number> = []
	const marked = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf
	let start = marked ? 3 : 0
	let index = start
	while (index < body.length) {
		const byte = body[index]
		if (byte === 0x0d || byte === 0x0a) {
			lines.push(index - start)
			index += byte === 0x0d && body[index + 1] === 0x0a ? 2 : 1
			start = index
		} else {
			index += 1
		}
	}
	return { lines, rest: body.length - start }
}

/** A `retry` value of ASCII digits, at least one, without its leading zeros. */
const retryDigits = (value: string): Option.Option<string> => {
	const units = Str.split("")(value)
	const digits =
		!Arr.isReadonlyArrayEmpty(units) && Arr.every(units, (unit) => unit >= "0" && unit <= "9")
	const significant = Arr.dropWhile(units, (unit) => unit === "0")
	return digits
		? Option.some(Arr.isReadonlyArrayEmpty(significant) ? "0" : Arr.join(significant, ""))
		: Option.none()
}

/**
 * WHATWG HTML's "Parsing an event stream", transcribed over the whole body decoded at once (UTF-8 decode drops the
 * leading byte order mark and replaces malformed bytes), with the generator's two readings, each counted in bytes
 * received: a line longer than the bound and a `data: ` prefix, or data longer than the bound, fails
 * `recordTooLarge`; a body that ends inside an event fails `truncated`, where WHATWG drops the event.
 */
const referenceRead = (body: Uint8Array, bound: number): Reading => {
	const { lines, rest } = linesOf(new TextDecoder().decode(body))
	const lengths = lineLengthsOf(body)
	const events: Array<Read> = []
	const failed = (reason: string): Reading => ({
		events,
		failure: Option.some({ reason, itemIndex: events.length })
	})
	const buffers = {
		data: "",
		type: "",
		id: Option.none<string>(),
		retry: Option.none<string>(),
		open: false,
		dataBytes: 0
	}
	for (const [index, line] of lines.entries()) {
		const length = Option.getOrElse(Arr.get(lengths.lines, index), () => 0)
		if (length > bound + prefixBytes) {
			return failed("recordTooLarge")
		}
		if (line === "") {
			if (buffers.data !== "") {
				events.push({
					type: buffers.type === "" ? "message" : buffers.type,
					data: Str.slice(0, -1)(buffers.data),
					id: buffers.id,
					retry: buffers.retry
				})
				buffers.retry = Option.none()
			}
			buffers.data = ""
			buffers.dataBytes = 0
			buffers.type = ""
			buffers.open = false
		} else if (!Str.startsWith(":")(line)) {
			buffers.open = true
			const colon = Str.indexOf(":")(line)
			const name = Option.match(colon, {
				onNone: () => line,
				onSome: (at) => Str.slice(0, at)(line)
			})
			const raw = Option.match(colon, { onNone: () => "", onSome: (at) => Str.slice(at + 1)(line) })
			const value = Str.startsWith(" ")(raw) ? Str.slice(1)(raw) : raw
			if (name === "event") {
				buffers.type = value
			} else if (name === "data") {
				buffers.data = `${buffers.data}${value}\n`
				buffers.dataBytes += length - (line.length - value.length) + 1
				if (buffers.dataBytes - 1 > bound) {
					return failed("recordTooLarge")
				}
			} else if (name === "id" && !Str.includes("\u0000")(value)) {
				buffers.id = Option.some(value)
			} else if (name === "retry") {
				buffers.retry = Option.orElse(retryDigits(value), () => buffers.retry)
			}
		}
	}
	if (lengths.rest > bound + prefixBytes) {
		return failed("recordTooLarge")
	}
	const cut = buffers.open || (rest !== "" && !Str.startsWith(":")(rest))
	return cut ? failed("truncated") : { events, failure: Option.none() }
}

/** A value's text as the parser decodes one value: UTF-8, malformed bytes replaced, a leading U+FEFF kept. */
const decodedValue = (value: ReadonlyArray<Piece>): string =>
	new TextDecoder("utf-8", { ignoreBOM: true }).decode(Uint8Array.from(valueBytes(value)))

/** The events a framing's parts were generated from, in order. */
const sourcesOf = (framed: Framing): ReadonlyArray<SourceEvent> =>
	Arr.flatMap(framed.parts, (part) => (part.kind === "event" ? [part.source] : []))

/**
 * The events a framing was generated from, as a parser reads them: the type, `message` for none or an empty one; the
 * data lines joined by LF; the last id set so far; the event's own retry digits.
 */
const sourceReading = (framed: Framing): Reading => {
	const sources = sourcesOf(framed)
	const events = Arr.mapAccum(sources, Option.none<string>(), (lastId, event) => {
		const id = Option.orElse(event.id, () => lastId)
		return [
			id,
			{
				type: Option.getOrElse(
					Option.filter(event.type, (type) => type !== ""),
					() => "message"
				),
				data: Arr.join(Arr.map(event.data, decodedValue), "\n"),
				id,
				retry: Option.flatMap(event.retry, retryDigits)
			}
		] as const
	})[1]
	const cut = Option.exists(framed.tail, (line) => line.kind === "field")
	return {
		events,
		failure: cut ? Option.some({ reason: "truncated", itemIndex: events.length }) : Option.none()
	}
}

/** The features a framing and its chunks reach. */
const parseFeatures = (
	framed: Framing,
	body: Uint8Array,
	starts: ReadonlyArray<number>,
	reference: Reading
): ReadonlyArray<ParseFeature> => {
	const ended = Arr.flatMap(framed.parts, (part) => part.lines)
	const lines = [...Arr.map(ended, (line) => line.line), ...Option.toArray(framed.tail)]
	const values = Arr.flatMap(lines, (line) => (line.kind === "blank" ? [] : [line.value]))
	const sources = sourcesOf(framed)
	const isField = (line: Line, names: ReadonlyArray<string>): boolean =>
		line.kind === "field" && Arr.contains(names, line.name)
	const cutInside = (start: number, test: (before: number, at: number) => boolean): boolean =>
		start > 0 && start < body.length && test(body[start - 1] ?? 0, body[start] ?? 0)
	const features: ReadonlyArray<readonly [ParseFeature, boolean]> = [
		["LF line end", Arr.some(ended, (line) => line.ending === "\n")],
		["CR line end", Arr.some(ended, (line) => line.ending === "\r")],
		["CRLF line end", Arr.some(ended, (line) => line.ending === "\r\n")],
		[
			"CRLF split across chunks",
			Arr.some(starts, (start) => cutInside(start, (before, at) => before === 0x0d && at === 0x0a))
		],
		[
			"character split across chunks",
			Arr.some(starts, (start) => cutInside(start, (_, at) => at >= 0x80 && at <= 0xbf))
		],
		["multi-line data", Arr.some(sources, (event) => event.data.length > 1)],
		["default type", Arr.some(reference.events, (event) => event.type === "message")],
		["comment", Arr.some(lines, (line) => line.kind === "comment")],
		["unknown field", Arr.some(lines, (line) => isField(line, ["x", "Data", "data2"]))],
		[
			"field without a colon",
			Arr.some(lines, (line) => line.kind === "field" && line.separator === "bare")
		],
		["block with no data", Arr.some(framed.parts, (part) => part.kind === "block")],
		["byte order mark", framed.mark],
		[
			"malformed UTF-8",
			Arr.some(values, (value) => Arr.some(value, (piece) => piece.kind === "malformed"))
		],
		[
			"id carried on",
			Option.exists(
				Option.all([
					Arr.findFirstIndex(sources, (event) => Option.isSome(event.id)),
					Arr.findLastIndex(sources, (event) => Option.isNone(event.id))
				]),
				([set, unset]) => set < unset
			)
		],
		[
			"retry with leading zeros",
			Arr.some(sources, (event) => Option.exists(event.retry, Str.startsWith("0")))
		],
		[
			"body cut inside an event",
			Option.exists(reference.failure, (failure) => failure.reason === "truncated")
		],
		[
			"record over the bound",
			Option.exists(reference.failure, (failure) => failure.reason === "recordTooLarge")
		]
	]
	return Arr.flatMap(features, ([feature, reached]) => (reached ? [feature] : []))
}

/** A JSON data value as the tokens it is written with, and what its `/error/retry` holds. */
type JsonData = Readonly<{
	tokens: Arr.NonEmptyReadonlyArray<string>
	retry: "never" | "none" | "safe"
	valid: boolean
}>

const errorTokens = (verdict: "never" | "safe"): Arr.NonEmptyReadonlyArray<string> => [
	"{",
	'"error"',
	":",
	"{",
	'"kind"',
	":",
	'"transient"',
	",",
	'"retry"',
	":",
	`"${verdict}"`,
	"}",
	"}"
]

const jsonData: Gen<JsonData> = element([
	{ tokens: errorTokens("safe"), retry: "safe", valid: true },
	{ tokens: errorTokens("never"), retry: "never", valid: true },
	{
		tokens: ["{", '"n"', ":", "9007199254740993", ",", '"s"', ":", '"a b"', "}"],
		retry: "none",
		valid: true
	},
	{ tokens: ["[", "1.50", ",", "-0e0", "]"], retry: "none", valid: true },
	{ tokens: ["{", "}"], retry: "none", valid: true },
	{ tokens: ["{", '"error"', ":"], retry: "none", valid: false }
])

/** One event of a stream under a contract: its type and data, written with drawn whitespace between JSON tokens. */
type StreamEvent = Readonly<{
	type: string
	json: JsonData
	text: string
	gaps: ReadonlyArray<string>
}>

/** A stream under a contract: the contract's rows, the events, the stop point, the output and the chunk sizes. */
type ControlCase = Readonly<{
	rows: ReadonlyArray<readonly [string, EventRow]>
	otherwise: EventOtherwise
	events: ReadonlyArray<StreamEvent>
	stopAt: StopAt
	output: EventOutput
	chunks: Arr.NonEmptyReadonlyArray<number>
}>

/** The features the control property reaches. */
type ControlFeature =
	| "stopped at ready"
	| "followed past ready"
	| "ended at end"
	| "failed, retry safe"
	| "failed, retry never"
	| "invalid JSON data"
	| "lifecycle cut short"
	| "open stream to its end"
	| "raw bytes"
	| "undeclared event type"
	| "ready read past to its next event"
	| "unexpected event"

const declaredTypes: Arr.NonEmptyReadonlyArray<string> = [
	"reset",
	"upsert",
	"ready",
	"end",
	"error"
]

const row: Gen<EventRow> = (source) => {
	const data = element<EventData>(["json", "text"])(source)
	const role = element<EventRow["role"]>(["item", "ready", "end", "error"])(source)
	if (role === "ready" && boolean(source)) {
		return { data, next: element(declaredTypes)(source), role }
	}
	return role === "error" && data === "json" && boolean(source)
		? { data, retryWhen: { pointer: "/error/retry", equals: "safe" }, role }
		: { data, role }
}

const streamEvent: Gen<StreamEvent> = (source) => {
	const json = jsonData(source)
	return {
		type: element([...declaredTypes, "other"])(source),
		json,
		text: string(characterOf(["a", " ", "\n", ":", "é"]), { min: 0, max: 4 })(source),
		gaps: array(element(["", " ", "\n", "\t "]), {
			min: json.tokens.length - 1,
			max: json.tokens.length - 1
		})(source)
	}
}

const controlCase: Gen<ControlCase> = (source) => ({
	rows: Arr.map(declaredTypes, (type) => [type, row(source)] as const),
	otherwise: element<EventOtherwise>([
		{ _tag: "Open", data: "text" },
		{ _tag: "Open", data: "json" },
		{ _tag: "Closed" }
	])(source),
	events: array(streamEvent, { min: 0, max: 6 })(source),
	stopAt: element<StopAt>(["ready", "terminal"])(source),
	output: element<EventOutput>(["lines", "bytes"])(source),
	chunks: [int(1, 9)(source), ...array(int(1, 9), { min: 0, max: 2 })(source)]
})

const contractOf = (control: ControlCase): EventContract => ({
	events: Rec.fromEntries(control.rows),
	otherwise: control.otherwise
})

/** An event type's row: the contract's, an item of an open contract, or none under a closed one. */
const rowOf = (control: ControlCase, type: string): Option.Option<EventRow> =>
	Option.orElse(Rec.get(contractOf(control).events, type), () =>
		control.otherwise._tag === "Open"
			? Option.some<EventRow>({ data: control.otherwise.data, role: "item" })
			: Option.none()
	)

/** How an event type's data is written and printed: its row's, text where it has none. */
const dataOf = (control: ControlCase, type: string): EventData =>
	Option.match(rowOf(control, type), { onNone: () => "text", onSome: (found) => found.data })

/** An event's data as it is written: its JSON tokens with their gaps, or its text. */
const writtenData = (control: ControlCase, event: StreamEvent): string =>
	dataOf(control, event.type) === "json"
		? Arr.join(
				Arr.map(event.json.tokens, (token, index) =>
					index === 0
						? token
						: `${Option.getOrElse(Arr.get(event.gaps, index - 1), () => "")}${token}`
				),
				""
			)
		: event.text

/** An event as the stream's body writes it: its type, its data line by line, the blank line. */
const eventText = (control: ControlCase, event: StreamEvent): string =>
	`event: ${event.type}\n${Arr.join(
		Arr.map(Str.split("\n")(writtenData(control, event)), (line) => `data: ${line}\n`),
		""
	)}\n`

/** What the stream should do: the text it writes, then how it ends. */
type Expected = Readonly<{
	written: string
	end:
		| Readonly<{ kind: "done" }>
		| Readonly<{ kind: "stream error"; reason: string; itemIndex: number }>
		| Readonly<{ kind: "event failed"; event: string; itemIndex: number; retrySafe: boolean }>
}>

const quoted = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

/** A stream that wrote `written` and ended as `end` says. */
const outcome = (written: string, end: Expected["end"]): Expected => ({ written, end })

/** An event's line, as the contract states it: its data compacted or quoted, then its type. */
const expectedLine = (control: ControlCase, event: StreamEvent) =>
	Effect.gen(function* () {
		const data =
			dataOf(control, event.type) === "json"
				? Arr.join(event.json.tokens, "")
				: yield* quoted(event.text)
		return `{"data":${data},"event":${yield* quoted(event.type)}}\n`
	})

/** The contract's specification of the stream: each event written in order until a stop, a failure or the end. */
const expectedOf = (control: ControlCase) =>
	Effect.gen(function* () {
		let written = ""
		let expected = Option.none<string>()
		for (const [index, event] of control.events.entries()) {
			const found =
				Option.isSome(expected) && expected.value !== event.type
					? Option.none<EventRow>()
					: rowOf(control, event.type)
			if (Option.isNone(found)) {
				return outcome(
					control.output === "bytes" ? `${written}${eventText(control, event)}` : written,
					{ kind: "stream error", reason: "unexpectedEvent", itemIndex: index }
				)
			}
			const eventRow = found.value
			expected = "next" in eventRow ? Option.some(eventRow.next) : Option.none()
			const invalid = eventRow.data === "json" && !event.json.valid
			if (control.output === "lines" && invalid) {
				return outcome(written, {
					kind: "stream error",
					reason: "invalidFraming",
					itemIndex: index
				})
			}
			const line =
				control.output === "lines" ? yield* expectedLine(control, event) : eventText(control, event)
			written = `${written}${line}`
			if (
				eventRow.role === "end" ||
				(eventRow.role === "ready" && !("next" in eventRow) && control.stopAt === "ready")
			) {
				return outcome(written, { kind: "done" })
			}
			if (eventRow.role === "error") {
				return outcome(written, {
					kind: "event failed",
					event: event.type,
					itemIndex: index,
					retrySafe: "retryWhen" in eventRow && event.json.retry === "safe"
				})
			}
		}
		const lifecycle = hasLifecycle(contractOf(control))
		return outcome(
			written,
			lifecycle
				? { kind: "stream error", reason: "truncated", itemIndex: control.events.length }
				: { kind: "done" }
		)
	})

/** What the stream did: the text it wrote, then how it ended. */
const actualOf = (control: ControlCase) =>
	Effect.gen(function* () {
		const body = new TextEncoder().encode(
			Arr.join(
				Arr.map(control.events, (event) => eventText(control, event)),
				""
			)
		)
		const chunks = chunked(body, chunkStarts(body.length, control.chunks))
		const written: Array<Uint8Array> = []
		const exit = yield* Effect.exit(
			Stream.fromIterable(chunks).pipe(
				eventStream({
					contract: contractOf(control),
					maxRecordBytes: productionBound,
					output: control.output,
					stopAt: control.stopAt
				}),
				Stream.runForEach((bytes) => Effect.sync(() => written.push(bytes)))
			)
		)
		const text = new TextDecoder().decode(
			Uint8Array.from(Arr.flatMap(written, (bytes) => Arr.fromIterable(bytes)))
		)
		const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none()
		const end: Expected["end"] = Option.match(failure, {
			onNone: () => ({ kind: "done" }),
			onSome: (error) =>
				error._tag === "EventFailed"
					? {
							kind: "event failed",
							event: error.event,
							itemIndex: error.itemIndex,
							retrySafe: error.retrySafe
						}
					: { kind: "stream error", reason: error.reason, itemIndex: error.itemIndex ?? -1 }
		})
		return outcome(text, end)
	})

/** The features a control case reaches, read from the specification of what it does. */
const controlFeatures = (
	control: ControlCase,
	expected: Expected
): ReadonlyArray<ControlFeature> => {
	const roleOf = (type: string): Option.Option<EventRow["role"]> =>
		Option.map(rowOf(control, type), (found) => found.role)
	const readyPassed = Arr.some(control.events, (event) =>
		Option.exists(roleOf(event.type), (role) => role === "ready")
	)
	const features: ReadonlyArray<readonly [ControlFeature, boolean]> = [
		["stopped at ready", control.stopAt === "ready" && expected.end.kind === "done" && readyPassed],
		["followed past ready", control.stopAt === "terminal" && readyPassed],
		[
			"ended at end",
			expected.end.kind === "done" &&
				Arr.some(control.events, (event) =>
					Option.exists(roleOf(event.type), (role) => role === "end")
				)
		],
		["failed, retry safe", expected.end.kind === "event failed" && expected.end.retrySafe],
		["failed, retry never", expected.end.kind === "event failed" && !expected.end.retrySafe],
		[
			"invalid JSON data",
			expected.end.kind === "stream error" && expected.end.reason === "invalidFraming"
		],
		[
			"lifecycle cut short",
			expected.end.kind === "stream error" && expected.end.reason === "truncated"
		],
		[
			"open stream to its end",
			expected.end.kind === "done" &&
				!hasLifecycle(contractOf(control)) &&
				control.events.length > 0
		],
		["raw bytes", control.output === "bytes"],
		["undeclared event type", Arr.some(control.events, (event) => event.type === "other")],
		[
			"ready read past to its next event",
			Arr.some(control.events, (event, index) =>
				Option.exists(
					rowOf(control, event.type),
					(found) =>
						"next" in found &&
						Option.exists(Arr.get(control.events, index + 1), (after) => after.type === found.next)
				)
			) && expected.end.kind === "done"
		],
		[
			"unexpected event",
			expected.end.kind === "stream error" && expected.end.reason === "unexpectedEvent"
		]
	]
	return Arr.flatMap(features, ([feature, reached]) => (reached ? [feature] : []))
}

describe("the SSE parser", () => {
	it.effect(
		"reads every framing as WHATWG reads the whole body, and as the events it was framed from",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "runtime/sse-parser",
						oracle: {
							kind: "second-implementation",
							name: "a transcription of WHATWG's event-stream parsing over the whole body decoded at once"
						},
						draw: drawn(framing),
						literal: Formatter.format,
						coverage: required<ParseFeature>(
							[
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
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.seconds(10)
					},
					(framed, c) =>
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
						})
				)
			)
	)
})

describe("an event stream", () => {
	it.effect(
		"writes each event under its contract through its stop point, and fails as the contract says",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "runtime/sse-stream",
						oracle: {
							kind: "specification",
							name: "the event contract: each event's line or bytes through the first stop event, and the failure an error event names"
						},
						draw: drawn(controlCase),
						literal: Formatter.format,
						coverage: required<ControlFeature>(
							[
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
								"unexpected event"
							],
							{ cases: 2000, sense: notesOnly }
						),
						kept: [],
						runs: 1000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang: Duration.seconds(10)
					},
					(control, c) =>
						Effect.gen(function* () {
							const expected = yield* expectedOf(control)
							const actual = yield* actualOf(control)
							c.noteAll(controlFeatures(control, expected))
							deepStrictEqual(actual, expected)
						})
				)
			)
	)
})
