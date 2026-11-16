/** What the properties of sse.test.ts read: its spaces, models and helpers. */

import {
	array,
	boolean,
	element,
	type Gen,
	int,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import { type SseEvent } from "#client/sse.ts"

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
export const meant = (block: ReadonlyArray<Part>): Result.Result<SseEvent, void> => {
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

/**
 * A drawn stream: its blocks, each ended by a blank line, its unended tail, whether a BOM opens it, its lines' ends, and
 * the positions between a CR and its LF that end a data line its event reads on after (readOn).
 */
type Drawn = Readonly<{
	blocks: ReadonlyArray<ReadonlyArray<Part>>
	tail: ReadonlyArray<Part>
	bom: boolean
	text: string
	bytes: Uint8Array
	cuts: ReadonlyArray<number>
	ends: ReadonlyArray<End>
	readOn: ReadonlyArray<number>
}>

const utf8 = new TextEncoder()

/**
 * A line of the stream: its text, and whether it is a data line its event reads on after, another data line of its
 * block following it, or a data line of the tail, which no blank line ends. A line feed read as a second end of such a
 * line, an empty line, would dispatch its event early: one event read as two, or a tail's data dispatched.
 */
type Line = Readonly<{ text: string; readsOn: boolean }>

/** A block's lines, then its blank line. */
const blockLines = (block: ReadonlyArray<Part>): ReadonlyArray<Line> => [
	...Arr.map(block, (part, at) => ({
		text: lineOf(part),
		readsOn:
			part.kind === "data" && Arr.some(Arr.drop(block, at + 1), (later) => later.kind === "data")
	})),
	{ text: "", readsOn: false }
]

/** The tail's lines: each data line's event reads on, since no blank line ends it. */
const tailLines = (tail: ReadonlyArray<Part>): ReadonlyArray<Line> =>
	Arr.map(tail, (part) => ({ text: lineOf(part), readsOn: part.kind === "data" }))

/**
 * The stream's text: each block's lines, then its blank line, then the tail's lines, the last of them unended where
 * the tail ends mid-line. Each line's end is drawn, an LF never ending an empty line a CR precedes. A cut is any byte
 * position, or, half the time where the stream holds one, a position between a CR and its LF ending a data line its
 * event reads on after, which a position drawn over every byte seldom is.
 */
export const streams: Gen<Drawn> = (source) => {
	const blocks = source.draw(array(parts, { min: 0, max: 4 }))
	const tail = source.draw(parts)
	const bom = source.draw(boolean)
	const lines = [...Arr.flatMap(blocks, blockLines), ...tailLines(tail)]
	const ends: Array<End> = []
	const readOn: Array<number> = []
	let text = bom ? "\uFEFF" : ""
	for (const [at, line] of lines.entries()) {
		const previous = ends[at - 1]
		const allowed: ReadonlyArray<End> =
			previous === "\r" && line.text === "" ? ["\r\n", "\r"] : ENDS
		const unended =
			at === lines.length - 1 && Arr.isReadonlyArrayNonEmpty(tail) && source.draw(boolean)
		const end = source.draw(
			element(Option.getOrThrow(Option.liftPredicate(allowed, Arr.isReadonlyArrayNonEmpty)))
		)
		ends.push(end)
		if (!unended && end === "\r\n" && line.readsOn) {
			readOn.push(utf8.encode(`${text}${line.text}\r`).length)
		}
		text = unended ? `${text}${line.text}` : `${text}${line.text}${end}`
	}
	const bytes = utf8.encode(text)
	const anywhere = int(1, Math.max(1, bytes.length - 1))
	const cut = Arr.match(readOn, {
		onEmpty: () => anywhere,
		onNonEmpty: (positions) => oneOf([anywhere, element(positions)])
	})
	const cuts = Arr.dedupe(Arr.sort(source.draw(array(cut, { min: 0, max: 8 })), Order.Number))
	return { blocks, tail, bom, text, bytes, cuts, ends, readOn }
}

/** The stream's bytes cut at its cut positions, every chunk nonempty. */
export const chunksOf = (drawnStream: Drawn): ReadonlyArray<Uint8Array> => {
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
export const reference = (text: string): ReadonlyArray<SseEvent> => {
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

export type Feature =
	| "an LF line"
	| "a CRLF line"
	| "a CR line"
	| "a chunk boundary inside a line"
	| "a chunk boundary inside a character"
	| "a chunk boundary between a CR and its LF"
	| "a chunk boundary between a CR and its LF ending a data line its event reads on after"
	| "a comment"
	| "an event of several data lines"
	| "an event with no data line"
	| "an unended tail"
	| "a leading byte order mark"

/** Whether a byte position lies inside a line: neither byte beside it is a line's end. */
export const insideLine = (bytes: Uint8Array, cut: number): boolean => {
	const before = bytes[cut - 1]
	const after = bytes[cut]
	return before !== 0x0a && before !== 0x0d && after !== 0x0a && after !== 0x0d
}
