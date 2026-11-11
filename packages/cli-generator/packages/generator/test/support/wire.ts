import { connect } from "node:net"
import {
	type Gen,
	array,
	bytes,
	characterOf,
	element,
	option,
	string
} from "@superstarter/testing/gen"
import { regex } from "arkregex"
import { Array as Arr, Effect, Option, String as Str } from "effect"
import type { HeaderList, WireRequest } from "#test/support/http.ts"

/**
 * A header line as a client writes it: its name, its value, and the optional whitespace written around the value. This
 * module is the harness suites' second reading of HTTP/1.1 framing, a client's writer and a response reader written
 * apart from the capture server's parser and writer, which the suites check against it.
 */
export type HeaderSketch = Readonly<{ name: string; value: string; before: string; after: string }>

/** A chunk of a chunked request body: its bytes, never none, and whether its size line carries an extension. */
type ChunkSketch = Readonly<{ bytes: Uint8Array; extension: boolean }>

/** How a request body travels: no framing header at all, under a Content-Length, or chunked with an optional trailer. */
type BodySketch =
	| Readonly<{ framing: "none" }>
	| Readonly<{ framing: "length"; bytes: Uint8Array }>
	| Readonly<{
			framing: "chunked"
			chunks: ReadonlyArray<ChunkSketch>
			trailer: Option.Option<HeaderSketch>
	  }>

/** A request a client writes: method, origin-form target, its own header lines and its body. */
export type RequestSketch = Readonly<{
	method: string
	target: string
	headers: ReadonlyArray<HeaderSketch>
	body: BodySketch
}>

/** RFC 9110 token characters, a few of each class, both cases. */
const tchar = characterOf([
	"a",
	"Z",
	"0",
	"9",
	"!",
	"#",
	"$",
	"%",
	"&",
	"'",
	"*",
	"+",
	"-",
	".",
	"^",
	"_",
	"`",
	"|",
	"~"
])

/** A token, such as a method or a header name's tail. */
const token: Gen<string> = string(tchar, { min: 1, max: 5 })

/** A method: a token; the methods with meaning are tokens too. */
export const method: Gen<string> = token

/** A target in origin form: a path of path characters and percent escapes, and a query or none. */
export const target: Gen<string> = (source) => {
	const path = string(
		characterOf([
			"a",
			"Z",
			"0",
			"/",
			"-",
			".",
			"_",
			"~",
			"%2F",
			"%7e",
			":",
			"@",
			"!",
			"$",
			"(",
			"'"
		]),
		{
			min: 0,
			max: 6
		}
	)(source)
	const query = option(
		string(characterOf(["a", "=", "&", "?", "/", "%20", "+"]), { min: 0, max: 5 })
	)(source)
	return `/${path}${Option.match(query, { onNone: () => "", onSome: (text) => `?${text}` })}`
}

/** Field-value characters other than whitespace: visible ASCII and latin1 bytes past 0x7F. */
const fieldCharacter = characterOf([
	"a",
	"Z",
	"0",
	'"',
	",",
	";",
	"=",
	":",
	"~",
	"é",
	"ÿ",
	"\u0080"
])

/** Optional whitespace: spaces and horizontal tabs. */
const whitespace: Gen<string> = string(characterOf([" ", "\t"]), { min: 0, max: 2 })

/** A field value: words of field characters joined by one space or tab, so it neither starts nor ends with whitespace. */
const fieldValue: Gen<string> = (source) =>
	Arr.join(
		array(string(fieldCharacter, { min: 1, max: 3 }), { min: 0, max: 3 })(source),
		element([" ", "\t"])(source)
	)

/**
 * A header line the client owns: its name an `X-` token in either case, so it never names a framing or connection
 * header; its value; and the whitespace around it.
 */
export const header: Gen<HeaderSketch> = (source) => ({
	name: `${element(["X-", "x-"])(source)}${token(source)}`,
	value: fieldValue(source),
	before: whitespace(source),
	after: whitespace(source)
})

/** A request body: no framing at all, or bytes under a Content-Length, or chunks with or without a trailer. */
const body: Gen<BodySketch> = (source) => {
	const framing = element<BodySketch["framing"]>(["none", "length", "chunked"])(source)
	switch (framing) {
		case "none":
			return { framing }
		case "length":
			return { framing, bytes: bytes({ min: 0, max: 12 })(source) }
		case "chunked":
			return {
				framing,
				chunks: array(
					(chunk): ChunkSketch => ({
						bytes: bytes({ min: 1, max: 6 })(chunk),
						extension: element([false, true])(chunk)
					}),
					{ min: 0, max: 3 }
				)(source),
				trailer: option(header)(source)
			}
	}
}

/** A request a client writes. */
export const request: Gen<RequestSketch> = (source) => ({
	method: method(source),
	target: target(source),
	headers: array(header, { min: 0, max: 3 })(source),
	body: body(source)
})

/** The bytes of a body as a client writes them, without its framing header. */
const bodyBytes = (sketch: BodySketch): Buffer => {
	switch (sketch.framing) {
		case "none":
			return Buffer.alloc(0)
		case "length":
			return Buffer.from(sketch.bytes)
		case "chunked":
			return Buffer.concat([
				...Arr.map(sketch.chunks, (chunk) =>
					Buffer.concat([
						Buffer.from(
							`${chunk.bytes.length.toString(16)}${chunk.extension ? ";ext=1" : ""}\r\n`,
							"latin1"
						),
						chunk.bytes,
						Buffer.from("\r\n", "latin1")
					])
				),
				Buffer.from(
					`0\r\n${Option.match(sketch.trailer, { onNone: () => "", onSome: (line) => `${line.name}:${line.before}${line.value}${line.after}\r\n` })}\r\n`,
					"latin1"
				)
			])
	}
}

/** The framing header line a body needs, if any. */
const framingOf = (sketch: BodySketch): HeaderList => {
	switch (sketch.framing) {
		case "none":
			return []
		case "length":
			return [["Content-Length", String(sketch.bytes.length)]]
		case "chunked":
			return [["Transfer-Encoding", "chunked"]]
	}
}

/** The line a request that asks to close its connection carries. */
const closing: HeaderList = [["Connection", "close"]]

/** The header lines a request travels with, as the server should record them; the last of a connection asks to close it. */
const headersOf = (sketch: RequestSketch, closes: boolean): HeaderList => [
	...Arr.map(sketch.headers, (line): readonly [string, string] => [line.name, line.value]),
	...framingOf(sketch.body),
	...(closes ? closing : [])
]

/** The bytes a client writes for a request; one that `closes` asks the server to close the connection after it. */
export const requestBytes = (sketch: RequestSketch, closes: boolean): Buffer => {
	const own = Arr.map(
		sketch.headers,
		(line) => `${line.name}:${line.before}${line.value}${line.after}`
	)
	const added = Arr.map(
		Arr.drop(headersOf(sketch, closes), sketch.headers.length),
		([name, value]) => `${name}: ${value}`
	)
	const lines = Arr.map(Arr.appendAll(own, added), (line) => `${line}\r\n`)
	return Buffer.concat([
		Buffer.from(
			`${sketch.method} ${sketch.target} HTTP/1.1\r\n${Arr.join(lines, "")}\r\n`,
			"latin1"
		),
		bodyBytes(sketch.body)
	])
}

/** The bytes of a body once its framing is removed. */
const decodedBody = (sketch: BodySketch): Uint8Array => {
	switch (sketch.framing) {
		case "none":
			return new Uint8Array(0)
		case "length":
			return Uint8Array.from(sketch.bytes)
		case "chunked":
			return Uint8Array.from(Buffer.concat(Arr.map(sketch.chunks, (chunk) => chunk.bytes)))
	}
}

/** The request the server should record for a sketch a client wrote. */
export const recordedOf = (sketch: RequestSketch, closes: boolean): WireRequest => ({
	method: sketch.method,
	target: sketch.target,
	headers: headersOf(sketch, closes),
	body: decodedBody(sketch.body)
})

/** A response as the reference reader reads it: its status, header lines, the body bytes that arrived, and whether all did. */
export type ReadResponse = Readonly<{
	status: number
	headers: HeaderList
	body: Uint8Array
	complete: boolean
}>

const STATUS_LINE = regex("^HTTP/1\\.1 ([0-9]{3}) Scripted$", "u")

/** Where `needle` first occurs in `haystack` at or after `from`. */
const find = (haystack: Buffer, needle: string, from: number): Option.Option<number> => {
	const at = haystack.indexOf(needle, from, "latin1")
	return at === -1 ? Option.none() : Option.some(at)
}

/** The body of a chunked response from `offset`, as far as it arrived, after the chunks before it. */
const readChunked = (
	received: Buffer,
	offset: number,
	before: ReadonlyArray<Buffer>
): Readonly<{ body: Uint8Array; complete: boolean }> => {
	const sofar = (complete: boolean) => ({ body: Uint8Array.from(Buffer.concat(before)), complete })
	return Option.match(find(received, "\r\n", offset), {
		onNone: () => sofar(false),
		onSome: (lineEnd) => {
			const size = Number.parseInt(received.toString("latin1", offset, lineEnd), 16)
			const dataEnd = lineEnd + 2 + size
			if (size === 0) {
				return sofar(received.length === lineEnd + 4)
			}
			return received.length < dataEnd + 2
				? sofar(false)
				: readChunked(
						received,
						dataEnd + 2,
						Arr.append(before, received.subarray(lineEnd + 2, dataEnd))
					)
		}
	})
}

/** A response header line, split at its first `: `, as the server writes it. */
const responseHeader = (line: string): readonly [string, string] =>
	Option.match(Str.indexOf(": ")(line), {
		onNone: () => [line, ""],
		onSome: (colon) => [Str.slice(0, colon)(line), Str.slice(colon + 2)(line)]
	})

/**
 * Reads the one response a connection carried, none when its head never arrived whole. A response to `HEAD` has no
 * body. A Content-Length body is complete when every byte it promised arrived and no more; a chunked one when its last
 * chunk ends the bytes.
 */
export const readResponse = (received: Uint8Array, head: boolean): Option.Option<ReadResponse> => {
	const buffer = Buffer.from(received)
	return Option.flatMap(find(buffer, "\r\n\r\n", 0), (end) => {
		const [statusLine, ...lines] = Str.split("\r\n")(buffer.toString("latin1", 0, end))
		return Option.map(Option.fromNullishOr(STATUS_LINE.exec(statusLine)), ([, status]) => {
			const headers = Arr.map(lines, responseHeader)
			const rest = buffer.subarray(end + 4)
			if (head) {
				return {
					status: Number(status),
					headers,
					body: Uint8Array.from(rest),
					complete: rest.length === 0
				}
			}
			return Option.match(
				Arr.findFirst(headers, ([name]) => name === "Content-Length"),
				{
					onNone: () => ({ status: Number(status), headers, ...readChunked(rest, 0, []) }),
					onSome: ([, value]) => ({
						status: Number(status),
						headers,
						body: Uint8Array.from(rest),
						complete: rest.length === Number(value)
					})
				}
			)
		})
	})
}

/** The latin1 bytes of the text. */
export const latin1Bytes = (text: string): Uint8Array =>
	Uint8Array.from(Buffer.from(text, "latin1"))

/**
 * A client's exchange: connects to 127.0.0.1 at the port, writes the bytes, and reads until the server closes the
 * connection, or until `enough` holds for what arrived, when the client closes it.
 */
export const exchange = (
	port: number,
	sent: Uint8Array,
	enough: (received: Uint8Array) => boolean
): Effect.Effect<Uint8Array> =>
	Effect.callback<Uint8Array>((resume) => {
		const received: Array<Buffer> = []
		const socket = connect(port, "127.0.0.1")
		socket.on("data", (chunk: Buffer) => {
			received.push(chunk)
			if (enough(Buffer.concat(received))) {
				socket.destroy()
			}
		})
		socket.once("close", () => {
			resume(Effect.succeed(Uint8Array.from(Buffer.concat(received))))
		})
		socket.on("error", () => {
			socket.destroy()
		})
		socket.once("connect", () => {
			socket.write(sent)
		})
		return Effect.sync(() => {
			socket.destroy()
		})
	})

/** Reads until the server closes the connection. */
export const untilClosed = (): boolean => false
