import { regex } from "arkregex"
import { Array as Arr, Option, String as Str } from "effect"

/** A header line as it travelled: its name as spelled and its value without the whitespace around it. */
export type Header = readonly [name: string, value: string]

/** A message's header lines, in the order they travelled, repeats kept. */
export type HeaderList = ReadonlyArray<Header>

/** A request head: its request line's method and target as sent, and its header lines. */
export type Head = Readonly<{ method: string; target: string; headers: HeaderList }>

/** A request as read off the wire: its head and its body's bytes once any chunked framing is removed. */
export type WireRequest = Head & Readonly<{ body: Uint8Array }>

/**
 * How far the bytes at the front of a connection hold what is wanted: not yet all of it, bytes that cannot begin it,
 * or all of it and the bytes after it.
 */
type Parse<A> =
	| Readonly<{ kind: "incomplete" }>
	| Readonly<{ kind: "malformed" }>
	| Readonly<{ kind: "complete"; value: A; rest: Buffer }>

const incomplete: Readonly<{ kind: "incomplete" }> = { kind: "incomplete" }

const malformed: Readonly<{ kind: "malformed" }> = { kind: "malformed" }

const CRLF = Buffer.from("\r\n", "latin1")

const HEAD_END = Buffer.from("\r\n\r\n", "latin1")

const DECIMAL = regex("^[0-9]+$", "u")

const HEXADECIMAL = regex("^[0-9a-fA-F]+$", "u")

/** A request line: a method, a target and the protocol version, separated by single spaces. */
const REQUEST_LINE = regex("^([^ ]+) ([^ ]+) (HTTP/1\\.[01])$", "u")

/** Where `needle` first occurs in `bytes` at or after `from`. */
const indexOf = (bytes: Buffer, needle: Buffer, from: number): Option.Option<number> => {
	const at = bytes.indexOf(needle, from)
	return at === -1 ? Option.none() : Option.some(at)
}

/** Whether a character is optional whitespace (RFC 9110 OWS): a space or a horizontal tab. */
const isWhitespace = (character: string): boolean => character === " " || character === "\t"

/** A value without the optional whitespace around it. */
const trimWhitespace = (value: string): string => {
	const characters = Str.split("")(value)
	const start = Option.getOrElse(
		Arr.findFirstIndex(characters, (character) => !isWhitespace(character)),
		() => characters.length
	)
	const end = Option.match(
		Arr.findLastIndex(characters, (character) => !isWhitespace(character)),
		{ onNone: () => start, onSome: (last) => last + 1 }
	)
	return Str.slice(start, end)(value)
}

/** A header line split at its first colon, none when it has no colon. */
const headerOf = (line: string): Option.Option<Header> =>
	Option.map(Str.indexOf(":")(line), (colon) => [
		Str.slice(0, colon)(line),
		trimWhitespace(Str.slice(colon + 1)(line))
	])

/** The values of every header line named `name` (in lower case), compared case-insensitively. */
const valuesOf = (headers: HeaderList, name: string): ReadonlyArray<string> =>
	Arr.flatMap(headers, ([candidate, value]) => (Str.toLowerCase(candidate) === name ? [value] : []))

/** Whether a message asks to close its connection after it. */
export const closesConnection = (headers: HeaderList): boolean =>
	Arr.some(
		valuesOf(headers, "connection"),
		(value) => Str.toLowerCase(trimWhitespace(value)) === "close"
	)

/** Reads a request head (its request line and header lines, without the blank line) from its latin1 text. */
const headOf = (text: string): Option.Option<Head> => {
	const [requestLine, ...lines] = Str.split("\r\n")(text)
	return Option.flatMap(
		Option.fromNullishOr(REQUEST_LINE.exec(requestLine)),
		([, method, target]) =>
			Option.map(Option.all(Arr.map(lines, headerOf)), (headers) => ({ method, target, headers }))
	)
}

/** Reads one request head from the front of the bytes. */
export const parseHead = (buffer: Buffer): Parse<Head> =>
	Option.match(indexOf(buffer, HEAD_END, 0), {
		onNone: () => incomplete,
		onSome: (headEnd) =>
			Option.match(headOf(buffer.toString("latin1", 0, headEnd)), {
				onNone: () => malformed,
				onSome: (head) => ({
					kind: "complete",
					value: head,
					rest: buffer.subarray(headEnd + HEAD_END.length)
				})
			})
	})

/** A chunked body: each chunk's size line (extensions ignored), its data and CRLF, then the trailer section. */
const chunkedBody = (buffer: Buffer): Parse<Uint8Array> => {
	const parts: Array<Buffer> = []
	const step = (offset: number): Parse<Uint8Array> =>
		Option.match(indexOf(buffer, CRLF, offset), {
			onNone: () => incomplete,
			onSome: (lineEnd) => {
				const sizeText = trimWhitespace(
					Arr.headNonEmpty(Str.split(";")(buffer.toString("latin1", offset, lineEnd)))
				)
				if (!HEXADECIMAL.test(sizeText)) {
					return malformed
				}
				const size = Number.parseInt(sizeText, 16)
				if (size === 0) {
					return Option.match(indexOf(buffer, HEAD_END, lineEnd), {
						onNone: () => incomplete,
						onSome: (trailerEnd) => ({
							kind: "complete",
							value: Uint8Array.from(Buffer.concat(parts)),
							rest: buffer.subarray(trailerEnd + HEAD_END.length)
						})
					})
				}
				const dataEnd = lineEnd + CRLF.length + size
				if (buffer.length < dataEnd + CRLF.length) {
					return incomplete
				}
				if (!buffer.subarray(dataEnd, dataEnd + CRLF.length).equals(CRLF)) {
					return malformed
				}
				parts.push(buffer.subarray(lineEnd + CRLF.length, dataEnd))
				return step(dataEnd + CRLF.length)
			}
		})
	return step(0)
}

/** A body of `length` bytes under a Content-Length. */
const lengthBody = (buffer: Buffer, length: number): Parse<Uint8Array> =>
	buffer.length < length
		? incomplete
		: {
				kind: "complete",
				value: Uint8Array.from(buffer.subarray(0, length)),
				rest: buffer.subarray(length)
			}

/**
 * The body that follows a request head: chunked when its last transfer coding is `chunked`, else the bytes its
 * Content-Length names (every Content-Length line must agree), else none.
 */
const bodyOf = (headers: HeaderList, buffer: Buffer): Parse<Uint8Array> => {
	const codings = Arr.flatMap(valuesOf(headers, "transfer-encoding"), (value) =>
		Arr.map(Str.split(",")(value), (coding) => Str.toLowerCase(trimWhitespace(coding)))
	)
	if (Option.contains(Arr.last(codings), "chunked")) {
		return chunkedBody(buffer)
	}
	return Arr.match(Arr.dedupe(valuesOf(headers, "content-length")), {
		onEmpty: () => lengthBody(buffer, 0),
		onNonEmpty: (lengths) =>
			lengths.length === 1 && DECIMAL.test(Arr.headNonEmpty(lengths))
				? lengthBody(buffer, Number(Arr.headNonEmpty(lengths)))
				: malformed
	})
}

/** Reads one HTTP/1.1 request, head and body, from the front of the bytes. */
export const parseRequest = (buffer: Buffer): Parse<WireRequest> => {
	const head = parseHead(buffer)
	if (head.kind !== "complete") {
		return head
	}
	const body = bodyOf(head.value.headers, head.rest)
	return body.kind === "complete"
		? { kind: "complete", value: { ...head.value, body: body.value }, rest: body.rest }
		: body
}
