import { regex } from "arkregex"
import { Array as Arr, Effect, Option, Result, Stream, String as Str } from "effect"
import { ResponseStreamError } from "#domain/errors.ts"
import { isJsonText } from "#runtime/json.ts"

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
 * The RFC 7464 record separator that opens every JSON-seq record.
 */
const recordSeparator = "\u001E"

/**
 * A record's tail after its last LF; RFC 7464 ends every record with LF, so a record that does not
 * match was cut short.
 */
const closedByLineFeed = regex("\n[\t\n\r ]*$", "u")

/**
 * Text that holds something other than JSON whitespace.
 */
const nonWhitespace = regex("[^\t\n\r ]", "u")

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
 * The JSON-seq framer's state between body chunks: the open record's text, UTF-8 size and scan,
 * the index the next record takes, whether a record is open (a separator has arrived and no LF
 * has closed its record since), whether the open record can no longer close at an LF, and whether
 * the stream failed.
 */
interface SeqState {
	bytes: number
	failed: boolean
	itemIndex: number
	open: boolean
	record: string
	scan: Scan
	settled: boolean
}

/**
 * Compute the UTF-8 byte length of one character as string iteration yields it (RFC 3629): a
 * single code unit below U+0080 takes one byte, below U+0800 two, and any other three (a lone
 * surrogate is written as U+FFFD); a surrogate pair, a code point past U+FFFF, takes four. A
 * character compares below a one-unit string exactly when its first code unit does, and a pair's
 * first unit is past U+0800.
 */
export const utf8Bytes = (char: string): number => {
	if (char < "\u0080") {
		return 1
	}

	if (char < "\u0800") {
		return 2
	}

	return char.length === 1 ? 3 : 4
}

/**
 * Compute the UTF-8 byte length of a string without encoding it.
 */
const utf8Length = (text: string): number => {
	let length = 0

	for (const char of text) {
		length += utf8Bytes(char)
	}

	return length
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
 * Bound each line of decoded NDJSON text to `maxRecordBytes` UTF-8 bytes, not counting its
 * terminator, before `Stream.splitLines` buffers it. An over-long line yields the text before it
 * and then `recordTooLarge` at the index of the record being read, without waiting for the line to
 * end. Line breaks are LF, CR and CRLF, as `Stream.splitLines` splits them; a line holding only
 * spaces and tabs is blank and takes no record index.
 */
const boundLines = (maxRecordBytes: number) =>
	Stream.mapAccum(
		() => ({ bytes: 0, content: false, failed: false, itemIndex: 0 }),
		(state, chunk: string) => {
			let offset = 0

			for (const char of state.failed ? "" : chunk) {
				if (char === "\n" || char === "\r") {
					state.itemIndex += state.content ? 1 : 0
					state.bytes = 0
					state.content = false
				} else {
					state.bytes += utf8Bytes(char)
					state.content ||= char !== " " && char !== "\t"
				}

				if (state.bytes > maxRecordBytes) {
					state.failed = true

					return [
						state,
						[
							Result.succeed(Str.slice(0, offset)(chunk)),
							Result.fail(
								new ResponseStreamError({ itemIndex: state.itemIndex, reason: "recordTooLarge" })
							)
						]
					] as const
				}

				offset += char.length
			}

			return [state, state.failed ? [] : [Result.succeed(chunk)]] as const
		}
	)

/**
 * Frame an NDJSON or JSONL response body (`application/x-ndjson`, `application/ndjson`,
 * `application/jsonl`) as one
 * compacted JSON text per record, without a line terminator, emitted as each line arrives.
 *
 * The body is decoded as UTF-8 and split by `Stream.splitLines`, so LF, CRLF and CR end a line and
 * a final line needs no terminator; blank lines are skipped. `Ndjson.decode` is not used because
 * it yields `JSON.parse` values, which lose number precision (design 5, NDJSON row). A line over
 * `maxRecordBytes` UTF-8 bytes fails with `recordTooLarge`, a line that ends inside a string or
 * an open container fails with `truncated`, and a line the compactor would change (two values
 * apart only by whitespace, a raw control character in a string, an unopened close) fails with
 * `invalidFraming`. Each failure carries the zero-based `itemIndex` of the record among the
 * non-blank lines, after every record before it has been emitted.
 */
export const ndjsonRecords =
	(maxRecordBytes: number) =>
	<E, R>(
		body: Stream.Stream<Uint8Array, E, R>
	): Stream.Stream<string, E | ResponseStreamError, R> =>
		body.pipe(
			Stream.decodeText(),
			boundLines(maxRecordBytes),
			Stream.mapEffect(Effect.fromResult),
			Stream.splitLines,
			Stream.mapAccumEffect(
				() => 0,
				(itemIndex, line: string) => {
					const compacted = compact(line)

					if (compacted.status !== "complete") {
						const reason = compacted.status === "invalid" ? "invalidFraming" : "truncated"

						return Effect.fail(new ResponseStreamError({ itemIndex, reason }))
					}

					return Effect.succeed(
						compacted.text === ""
							? ([itemIndex, []] as const)
							: ([itemIndex + 1, [compacted.text]] as const)
					)
				}
			)
		)

/**
 * Construct the JSON-seq framer's state before the first body chunk.
 */
const seqState = (): SeqState => ({
	bytes: 0,
	failed: false,
	itemIndex: 0,
	open: false,
	record: "",
	scan: freshScan(),
	settled: false
})

/**
 * Close the open JSON-seq record: its compacted text goes to `records`, an empty record goes
 * nowhere, and a record that cannot close is the failure that ends the stream. The size excludes
 * the closing LF.
 */
const closeRecord = (
	state: SeqState,
	maxRecordBytes: number,
	records: string[]
): Option.Option<ResponseStreamError> => {
	const { bytes, itemIndex, record } = state
	const compacted = compact(record)
	const failure = (reason: ResponseStreamError["reason"]) =>
		Option.some(new ResponseStreamError({ itemIndex, reason }))

	state.bytes = 0
	state.record = ""
	state.scan = freshScan()
	state.settled = false

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
 * Add text between separators to the open JSON-seq record line by line, closing it into `records`
 * at the LF that completes its JSON text, or check text outside a record: before the first
 * separator, or after a record closed at its LF, where only whitespace may appear. Fails as soon
 * as the record passes the bound with one byte left for its closing LF.
 */
const appendRecord = (
	state: SeqState,
	part: string,
	maxRecordBytes: number,
	records: string[]
): Option.Option<ResponseStreamError> => {
	const lines = Str.split(part, "\n")

	for (const [index, line] of lines.entries()) {
		const { itemIndex } = state

		if (!state.open) {
			return Arr.some(Arr.drop(lines, index), (rest) => nonWhitespace.test(rest))
				? Option.some(new ResponseStreamError({ itemIndex, reason: "invalidFraming" }))
				: Option.none()
		}

		const endsAtLineFeed = index < lines.length - 1
		const text = endsAtLineFeed ? `${line}\n` : line
		const bytes = state.bytes + utf8Length(text)

		if (bytes > maxRecordBytes + 1) {
			return Option.some(new ResponseStreamError({ itemIndex, reason: "recordTooLarge" }))
		}

		state.bytes = bytes
		state.record += text
		scanRecord(state, text)

		if (endsAtLineFeed && completeAtLineFeed(state)) {
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
 * Frame one chunk of decoded JSON-seq text: every record a separator or an LF in the chunk closes,
 * then the first failure, after which the framer takes no more input.
 */
const frameChunk = (
	state: SeqState,
	chunk: string,
	maxRecordBytes: number
): ReadonlyArray<Framed> => {
	const records: string[] = []
	const parts = state.failed ? [] : Str.split(chunk, recordSeparator)

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
 * A record opens at U+001E and closes at the first LF after which its text parses as JSON, so it
 * is emitted as it arrives; an LF inside the text is whitespace and keeps the record open. A
 * record that never parses at an LF closes at the next separator or the end of the body. The body
 * may open with whitespace; any other text before the first separator, or after a record's closing
 * LF and before the next separator, fails with `invalidFraming`. An empty
 * record (separators in a row, or only whitespace) is skipped and takes no index. A record over
 * `maxRecordBytes` UTF-8 bytes, not counting its closing LF, fails with `recordTooLarge` as soon as
 * the bound is passed; a record that does not end with LF, or ends inside a string or an open
 * container, fails with `truncated`; a record the compactor would change fails with
 * `invalidFraming`. Each failure carries the zero-based `itemIndex` of the record being read,
 * after every record before it has been emitted.
 */
export const jsonSeqRecords =
	(maxRecordBytes: number) =>
	<E, R>(
		body: Stream.Stream<Uint8Array, E, R>
	): Stream.Stream<string, E | ResponseStreamError, R> =>
		body.pipe(
			Stream.decodeText(),
			Stream.mapAccum(
				seqState,
				(state, chunk: string) => [state, frameChunk(state, chunk, maxRecordBytes)] as const,
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
