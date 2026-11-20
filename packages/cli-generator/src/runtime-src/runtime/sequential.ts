import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Result, Stream, String as Str } from "effect"
import { ResponseStreamError } from "#domain/errors.ts"
import { isJsonText } from "#runtime/json.ts"
import { joined, type LineReader, lineReader } from "#runtime/lines.ts"
import { utf8Text } from "#runtime/utf8.ts"

/**
 * A sequential body's framing: NDJSON or JSONL lines, RFC 7464 JSON-seq records, or Server-Sent
 * Events.
 */
export type SequentialCodec = "jsonseq" | "ndjson" | "sse"

/**
 * The sequential codec each media type essence selects. With the `+json-seq` suffix rule in
 * `sequentialCodecOf`, the one owner of these facts: the generator assigns a response alternative
 * its codec through it (`src/normalize/responses.ts`) and the runtime frames a body by it
 * (`responseBytes` in `output.ts`), so the two cannot disagree.
 */
export const sequentialMediaTypes: ReadonlyMap<string, SequentialCodec> = new Map([
	["application/json-seq", "jsonseq"],
	["application/jsonl", "ndjson"],
	["application/ndjson", "ndjson"],
	["application/x-ndjson", "ndjson"],
	["text/event-stream", "sse"]
])

/**
 * A structured syntax suffix essence for JSON text sequences (RFC 8091), such as
 * `application/geo+json-seq`.
 */
const jsonSeqSuffix = regex("^[^/;]+/[^/;]+\\+json-seq$", "u")

/**
 * A media type's essence: parameters dropped, trimmed, lowercased. The one place the runtime
 * splits a media type at `;`.
 */
export const mediaEssence = (mediaType: string): string =>
	Str.toLowerCase(Str.trim(Arr.headNonEmpty(Str.split(mediaType, ";"))))

/**
 * Whether `mediaType` is JSON media: `application/json` or a `+json` suffix, parameters and case
 * ignored.
 */
export const isJsonFamily = (mediaType: string): boolean => {
	const essence = mediaEssence(mediaType)

	return essence === "application/json" || Str.endsWith("+json")(essence)
}

/**
 * The sequential codec a media type selects, or `undefined` for a non-sequential type: its essence
 * (lowercased, parameters dropped) is looked up in `sequentialMediaTypes`, and any other
 * `+json-seq` essence is JSON-seq.
 */
export const sequentialCodecOf = (mediaType: string): SequentialCodec | undefined => {
	const essence = mediaEssence(mediaType)

	return sequentialMediaTypes.get(essence) ?? (jsonSeqSuffix.test(essence) ? "jsonseq" : undefined)
}

/**
 * The RFC 7464 record separator, U+001E, that opens every JSON-seq record: one byte in UTF-8, as
 * the LF that ends a record is, neither ever part of a multi-byte sequence.
 */
const recordSeparator = 0x1e

const lineFeed = 0x0a

/**
 * The bytes JSON allows as whitespace between tokens, which is all that may stand outside a
 * JSON-seq record.
 */
const whitespaceBytes: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * No bytes: the line an LF or a separator ends when nothing came before it.
 */
const noBytes = new Uint8Array(0)

/**
 * A record's tail after its last LF; RFC 7464 ends every record with LF, so a record that does not
 * match was cut short.
 */
const closedByLineFeed = regex("\n[\t\n\r ]*$", "u")

/**
 * One output of a framing step: a record line to emit, or the failure that ends the stream after
 * the records before it have been emitted.
 */
type Framed = Result.Result<string, ResponseStreamError>

/**
 * One record's text with its insignificant whitespace removed, and its status: `complete`;
 * `truncated` when it ends inside a string or an open container; or `invalid` when removing the
 * whitespace would change the data, which the text is then not returned for.
 */
type Compacted =
	| { readonly status: "complete" | "truncated"; readonly text: string }
	| { readonly status: "invalid" }

/**
 * Characters that are JSON syntax or whitespace; every other character outside a string belongs
 * to a number or to `true`, `false` or `null`.
 */
const delimiters: ReadonlySet<string> = new Set([
	"{",
	"}",
	"[",
	"]",
	":",
	",",
	'"',
	" ",
	"\t",
	"\n",
	"\r"
])

/**
 * Characters that open a value, besides a number or literal.
 */
const valueOpeners: ReadonlySet<string> = new Set(["{", "[", '"'])

/**
 * The whitespace JSON allows between tokens, which the compactor removes.
 */
const whitespace: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"])

/**
 * The container depth each bracket adds.
 */
const depthChange: ReadonlyMap<string, number> = new Map([
	["{", 1],
	["[", 1],
	["}", -1],
	["]", -1]
])

/**
 * The punctuation after which another value may follow.
 */
const separators: ReadonlySet<string> = new Set([",", ":"])

/**
 * The first character JSON allows raw inside a string, U+0020; every one below it must be escaped.
 * A character compares below it exactly when its first UTF-16 code unit does.
 */
const firstRawStringCharacter = " "

/**
 * The JSON-seq framer's state between body chunks: the open record's size in bytes received, the
 * text of its lines an LF has ended and its scan, the bytes of its line not yet ended, the index
 * the next record takes, whether a record is open (a separator has arrived and no LF has closed
 * its record since), whether the open record can no longer close at an LF, and whether the stream
 * failed.
 */
interface SeqState {
	bytes: number
	failed: boolean
	itemIndex: number
	line: Array<Uint8Array>
	open: boolean
	record: string
	scan: Scan
	settled: boolean
}

/**
 * The compactor's position in one record: container depth, whether it is inside a string (and
 * just after a backslash there) or inside a number or literal, and whether a value has just ended.
 */
interface Scan {
	afterValue: boolean
	depth: number
	escaped: boolean
	inScalar: boolean
	inString: boolean
}

/**
 * Construct the scan at the start of a record.
 */
const freshScan = (): Scan => ({
	afterValue: false,
	depth: 0,
	escaped: false,
	inScalar: false,
	inString: false
})

/**
 * Advance the scan over one character inside a string. Returns false for a raw character below
 * U+0020, which JSON requires to be escaped.
 */
const scanString = (scan: Scan, char: string): boolean => {
	if (char < firstRawStringCharacter) {
		return false
	}

	scan.inString = scan.escaped || char !== '"'
	scan.escaped = !scan.escaped && char === "\\"
	scan.afterValue = !scan.inString

	return true
}

/**
 * Advance the scan over one character outside strings. Returns false when a value starts right
 * after another value, so removing the whitespace between them would join them, or when a
 * container closes that was never opened.
 */
const scanToken = (scan: Scan, char: string): boolean => {
	if (!delimiters.has(char)) {
		const joins = scan.afterValue && !scan.inScalar

		scan.inScalar = true

		return !joins
	}

	scan.afterValue ||= scan.inScalar
	scan.inScalar = false

	if (scan.afterValue && valueOpeners.has(char)) {
		return false
	}

	const change = depthChange.get(char) ?? 0

	scan.inString = char === '"'
	scan.depth += change
	scan.afterValue = change < 0 || (scan.afterValue && !separators.has(char))

	return scan.depth >= 0
}

/**
 * Remove the whitespace JSON allows between tokens from one record's text. Nothing is parsed:
 * strings, numbers and key order are copied as received, so a number past 2^53 and every escape
 * survive byte for byte, which `JSON.parse` followed by `JSON.stringify` would not keep (design
 * 4.6). Each character is read as string iteration yields it and its offset advanced by its UTF-16
 * length; only ASCII characters are removed, so slicing at them is exact.
 *
 * Removing whitespace is safe only where it separates a value from punctuation, so the record is
 * `invalid` when a value follows another value with no `,` or `:` between them (whitespace in
 * `1 2` would otherwise join two numbers into `12`), when a string holds a raw character below
 * U+0020, or when a container closes that was never opened. It is not a full JSON check: input
 * the compactor cannot alter passes unchanged.
 */
const compact = (record: string): Compacted => {
	const scan = freshScan()
	let text = ""
	let start = 0
	let offset = 0

	for (const char of record) {
		const { inString } = scan

		if (!(inString ? scanString(scan, char) : scanToken(scan, char))) {
			return { status: "invalid" }
		}

		if (!inString && whitespace.has(char)) {
			text += Str.slice(start, offset)(record)
			start = offset + 1
		}

		offset += char.length
	}

	return {
		status: scan.inString || scan.depth > 0 ? "truncated" : "complete",
		text: text + Str.slice(start)(record)
	}
}

/**
 * The NDJSON framer's state between body chunks: its body's lines (#runtime/lines.ts), the index
 * the next record takes, and whether the stream failed.
 */
interface NdjsonState {
	failed: boolean
	itemIndex: number
	readonly lines: LineReader
}

/**
 * The failure that ends a framer's stream at the record being read, after which the framer takes
 * no more input.
 */
const failed = (
	state: { failed: boolean; readonly itemIndex: number },
	reason: ResponseStreamError["reason"]
): Framed => {
	state.failed = true

	return Result.fail(new ResponseStreamError({ itemIndex: state.itemIndex, reason }))
}

/**
 * Whether an NDJSON line of `bytes` bytes, not counting its terminator, passes the bound: the one
 * rule a line that has ended and the line still arriving are both held to.
 */
const overBound = (bytes: number, maxRecordBytes: number): boolean => bytes > maxRecordBytes

/**
 * One NDJSON line's outputs: its record, compacted; nothing for a blank line, which takes no
 * index; or the failure that ends the stream: `recordTooLarge` for a line over the bound,
 * `invalidText` for one whose bytes are no UTF-8, `truncated` for one that ends inside a string or
 * an open container, `invalidFraming` for one the compactor would change.
 */
const ndjsonLine = (
	state: NdjsonState,
	bytes: Uint8Array,
	maxRecordBytes: number
): ReadonlyArray<Framed> => {
	if (overBound(bytes.length, maxRecordBytes)) {
		return [failed(state, "recordTooLarge")]
	}

	const text = utf8Text(bytes)
	if (text === undefined) {
		return [failed(state, "invalidText")]
	}

	const compacted = compact(text)
	if (compacted.status !== "complete") {
		return [failed(state, compacted.status === "invalid" ? "invalidFraming" : "truncated")]
	}

	if (compacted.text === "") {
		return []
	}

	state.itemIndex += 1

	return [Result.succeed(compacted.text)]
}

/**
 * One NDJSON chunk's outputs: each line it ends, then `recordTooLarge` as soon as the line not yet
 * ended passes the bound, without waiting for the line to end.
 */
const ndjsonChunk = (
	state: NdjsonState,
	chunk: Uint8Array,
	maxRecordBytes: number
): ReadonlyArray<Framed> => {
	const out: Array<Framed> = []
	for (const line of state.failed ? [] : state.lines.step(chunk)) {
		for (const framed of ndjsonLine(state, line.bytes, maxRecordBytes)) {
			out.push(framed)
		}

		if (state.failed) {
			return out
		}
	}

	return !state.failed && overBound(state.lines.pending(), maxRecordBytes)
		? [...out, failed(state, "recordTooLarge")]
		: out
}

/**
 * Frame an NDJSON or JSONL response body (`application/x-ndjson`, `application/ndjson`,
 * `application/jsonl`) as one compacted JSON text per record, without a line terminator, emitted
 * as each line arrives.
 *
 * The body is split into lines on its bytes (#runtime/lines.ts), so LF, CRLF and CR end a line
 * and a final line needs no terminator, and each line is decoded as UTF-8 once it has ended; a
 * line that holds only spaces and tabs is blank, skipped and takes no record index.
 * `Ndjson.decode` is not used because it yields `JSON.parse` values, which lose number precision
 * (design 5, NDJSON row). A line over `maxRecordBytes` bytes, not counting its terminator, fails
 * with `recordTooLarge` as soon as its bytes pass the bound; a line whose bytes are no UTF-8 fails
 * with `invalidText`, a byte order mark being a character of its line, never stripped; a line that
 * ends inside a string or an open container fails with `truncated`; and a line the compactor
 * would change (two values apart only by whitespace, a raw control character in a string, an
 * unopened close) fails with `invalidFraming`. Each failure carries the zero-based `itemIndex` of
 * the record among the non-blank lines, after every record before it has been emitted.
 */
export const ndjsonRecords =
	(maxRecordBytes: number) =>
	<E, R>(
		body: Stream.Stream<Uint8Array, E, R>
	): Stream.Stream<string, E | ResponseStreamError, R> =>
		body.pipe(
			Stream.mapAccum(
				(): NdjsonState => ({ failed: false, itemIndex: 0, lines: lineReader() }),
				(state, chunk: Uint8Array) => [state, ndjsonChunk(state, chunk, maxRecordBytes)] as const,
				{
					onHalt: (state) =>
						state.failed ? [] : ndjsonLine(state, state.lines.rest(), maxRecordBytes)
				}
			),
			Stream.mapEffect(Effect.fromResult)
		)

/**
 * Construct the JSON-seq framer's state before the first body chunk.
 */
const seqState = (): SeqState => ({
	bytes: 0,
	failed: false,
	itemIndex: 0,
	line: [],
	open: false,
	record: "",
	scan: freshScan(),
	settled: false
})

/**
 * Close the open JSON-seq record: its compacted text goes to `records`, an empty record goes
 * nowhere, and a record that cannot close is the failure that ends the stream: its line not yet
 * ended is decoded first, and fails `invalidText` where its bytes are no UTF-8. The size excludes
 * the closing LF.
 */
const closeRecord = (
	state: SeqState,
	maxRecordBytes: number,
	records: string[]
): Option.Option<ResponseStreamError> => {
	const { bytes, itemIndex, line, record: ended } = state
	const unended = Option.fromUndefinedOr(utf8Text(joined(line, noBytes)))
	const failure = (reason: ResponseStreamError["reason"]) =>
		Option.some(new ResponseStreamError({ itemIndex, reason }))

	state.bytes = 0
	state.line = []
	state.record = ""
	state.scan = freshScan()
	state.settled = false

	if (Option.isNone(unended)) {
		return failure("invalidText")
	}

	const record = ended + unended.value
	const compacted = compact(record)

	if (compacted.status === "complete" && compacted.text === "") {
		return Option.none()
	}

	if (bytes - (Str.endsWith("\n")(record) ? 1 : 0) > maxRecordBytes) {
		return failure("recordTooLarge")
	}

	if (compacted.status === "invalid") {
		return failure("invalidFraming")
	}

	if (compacted.status === "truncated" || !closedByLineFeed.test(record)) {
		return failure("truncated")
	}

	state.itemIndex += 1
	records.push(compacted.text)

	return Option.none()
}

/**
 * Advance the open record's scan over text added to it, until the scan finds text the compactor
 * would change; the record then closes only at the next separator or the end of the body.
 */
const scanRecord = (state: SeqState, text: string): void => {
	const { scan } = state

	for (const char of state.settled ? "" : text) {
		if (!(scan.inString ? scanString(scan, char) : scanToken(scan, char))) {
			state.settled = true

			return
		}
	}
}

/**
 * One JSON text with its insignificant whitespace removed (`compact`), so its strings, numbers and key order stay as
 * received; `None` when the text is not one JSON text, which `isJsonText` decides.
 */
export const compactJsonText = (text: string): Option.Option<string> => {
	const compacted = compact(text)

	return compacted.status === "complete" && isJsonText(compacted.text)
		? Option.some(compacted.text)
		: Option.none()
}

/**
 * Whether the open record's text, which ends at an LF, is a complete JSON text, so the record
 * closes at that LF (RFC 7464 ends each record with LF) instead of at the next separator. The
 * scan rules out text inside a string or a container without parsing; `isJsonText` decides the
 * rest. Past a top-level value only whitespace may follow, so text that does not parse here never
 * will, and the record settles: it closes at the next separator or the end of the body.
 */
const completeAtLineFeed = (state: SeqState): boolean => {
	const { scan } = state

	if (state.settled || scan.inString || scan.depth > 0 || !scan.afterValue) {
		return false
	}

	const parses = isJsonText(state.record)

	state.settled = !parses

	return parses
}

/**
 * The bytes between each `separator` byte and the next, in order, the last after the last
 * separator: one array where `bytes` holds no separator.
 */
const splitAt = (bytes: Uint8Array, separator: number): Arr.NonEmptyReadonlyArray<Uint8Array> => {
	const parts: Array<Uint8Array> = []
	let start = 0
	let at = bytes.indexOf(separator)
	while (at !== -1) {
		parts.push(bytes.subarray(start, at))
		start = at + 1
		at = bytes.indexOf(separator, start)
	}

	return Arr.append(parts, bytes.subarray(start))
}

/**
 * Whether bytes hold something other than JSON whitespace.
 */
const holdsNonWhitespace = (bytes: Uint8Array): boolean =>
	bytes.some((byte) => !whitespaceBytes.has(byte))

/**
 * Add bytes between separators to the open JSON-seq record line by line, each line decoded once
 * its LF has arrived, closing the record into `records` at the LF that completes its JSON text;
 * or check bytes outside a record (before the first separator, or after a record closed at its
 * LF), where only whitespace may appear. A line not yet ended waits in the record for its LF, a
 * separator or the body's end. Fails as soon as the record passes the bound with one byte left for
 * its closing LF, and with `invalidText` at an ended line whose bytes are no UTF-8.
 */
const appendRecord = (
	state: SeqState,
	part: Uint8Array,
	maxRecordBytes: number,
	records: string[]
): Option.Option<ResponseStreamError> => {
	const lines = splitAt(part, lineFeed)

	for (const [index, line] of lines.entries()) {
		const { itemIndex } = state

		if (!state.open) {
			return Arr.some(Arr.drop(lines, index), holdsNonWhitespace)
				? Option.some(new ResponseStreamError({ itemIndex, reason: "invalidFraming" }))
				: Option.none()
		}

		const endsAtLineFeed = index < lines.length - 1
		const bytes = state.bytes + line.length + (endsAtLineFeed ? 1 : 0)

		if (bytes > maxRecordBytes + 1) {
			return Option.some(new ResponseStreamError({ itemIndex, reason: "recordTooLarge" }))
		}

		state.bytes = bytes

		if (!endsAtLineFeed) {
			state.line.push(line)

			return Option.none()
		}

		const text = utf8Text(joined(state.line, line))
		state.line = []

		if (text === undefined) {
			return Option.some(new ResponseStreamError({ itemIndex, reason: "invalidText" }))
		}

		const ended = `${text}\n`
		state.record += ended
		scanRecord(state, ended)

		if (completeAtLineFeed(state)) {
			const failure = closeRecord(state, maxRecordBytes, records)

			state.open = false

			if (Option.isSome(failure)) {
				return failure
			}
		}
	}

	return Option.none()
}

/**
 * A framing step's outputs: the records it closed, then the failure that ends the stream, when one
 * did.
 */
const outputsOf = (
	records: ReadonlyArray<string>,
	failure: Option.Option<ResponseStreamError>
): ReadonlyArray<Framed> =>
	Arr.appendAll(
		Arr.map(records, (record): Framed => Result.succeed(record)),
		Option.toArray(Option.map(failure, (error): Framed => Result.fail(error)))
	)

/**
 * Frame one chunk of a JSON-seq body's bytes: every record a separator or an LF in the chunk
 * closes, then the first failure, after which the framer takes no more input.
 */
const frameChunk = (
	state: SeqState,
	chunk: Uint8Array,
	maxRecordBytes: number
): ReadonlyArray<Framed> => {
	const records: string[] = []
	const parts = state.failed ? [] : splitAt(chunk, recordSeparator)

	for (const [position, part] of parts.entries()) {
		const closes = position > 0 && state.open

		state.open ||= position > 0

		const failure = Option.orElse(
			closes ? closeRecord(state, maxRecordBytes, records) : Option.none(),
			() => appendRecord(state, part, maxRecordBytes, records)
		)

		if (Option.isSome(failure)) {
			state.failed = true

			return outputsOf(records, failure)
		}
	}

	return outputsOf(records, Option.none())
}

/**
 * Frame a JSON-seq response body (RFC 7464, `application/json-seq` and `+json-seq`) as one
 * compacted JSON text per record, without a line terminator, emitted as each record closes.
 *
 * The body is framed on its bytes, U+001E and LF being one byte each, and each line of a record is
 * decoded as UTF-8 once its LF, the next separator or the body's end has arrived. A record opens at
 * U+001E and closes at the first LF after which its text parses as JSON, so it is emitted as it
 * arrives; an LF inside the text is whitespace and keeps the record open. A record that never
 * parses at an LF closes at the next separator or the end of the body. The body may open with
 * whitespace; any other byte before the first separator, or after a record's closing LF and before
 * the next separator, fails with `invalidFraming`. An empty record (separators in a row, or only
 * whitespace) is skipped and takes no index. A record over `maxRecordBytes` bytes, not counting its
 * closing LF, fails with `recordTooLarge` as soon as the bound is passed; a line whose bytes are no
 * UTF-8 fails with `invalidText`, a byte order mark being a character of its record, never
 * stripped; a record that does not end with LF, or ends inside a string or an open container,
 * fails with `truncated`; a record the compactor would change fails with `invalidFraming`. Each
 * failure carries the zero-based `itemIndex` of the record being read, after every record before it
 * has been emitted.
 */
export const jsonSeqRecords =
	(maxRecordBytes: number) =>
	<E, R>(
		body: Stream.Stream<Uint8Array, E, R>
	): Stream.Stream<string, E | ResponseStreamError, R> =>
		body.pipe(
			Stream.mapAccum(
				seqState,
				(state, chunk: Uint8Array) => [state, frameChunk(state, chunk, maxRecordBytes)] as const,
				{
					onHalt: (state) => {
						const records: string[] = []
						const last =
							state.failed || !state.open
								? Option.none()
								: closeRecord(state, maxRecordBytes, records)

						return outputsOf(records, last)
					}
				}
			),
			Stream.mapEffect(Effect.fromResult)
		)
