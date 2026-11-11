import {
	Array as Arr,
	Context,
	Effect,
	Option,
	Predicate,
	Record as Rec,
	Schema,
	Stream,
	String as Str
} from "effect"
import { Flag } from "effect/cli"
import { ResponseStreamError } from "../domain/errors.ts"
import { encoder } from "./redact.ts"
import { compactJsonText } from "./sequential.ts"

/**
 * One event a `text/event-stream` body dispatched (WHATWG HTML, "Parsing an event stream"): its type, `message` when
 * the stream named none; its data, its `data` lines joined by LF; the last event ID the stream set, absent until it
 * sets one; the digits of the last `retry` field read since the previous event, the stream's reconnection time in
 * milliseconds, without leading zeros; and `end`, the offset just past the line that dispatched it, in the chunk that
 * held that line's end.
 */
export interface SseEvent {
	readonly _tag: "SseEvent"
	readonly data: string
	readonly end: number
	readonly id: Option.Option<string>
	readonly retry: Option.Option<string>
	readonly type: string
}

/**
 * What the parser reads from one chunk: each event the chunk dispatched, then the failure that ends the stream, after
 * which the parser takes no more input.
 */
export type Parsed = SseEvent | ResponseStreamError

/**
 * The SSE parser of one response body: `step` reads the body's next chunk, `halt` reads the body's end.
 */
export interface SseParser {
	readonly halt: () => ReadonlyArray<ResponseStreamError>
	readonly step: (chunk: Uint8Array) => ReadonlyArray<Parsed>
}

const lineFeed = 0x0a

const carriageReturn = 0x0d

const colon = 0x3a

const space = 0x20

const nul = 0x00

const digitZero = 0x30

const digitNine = 0x39

const byteOrderMark: ReadonlyArray<number> = [0xef, 0xbb, 0xbf]

/**
 * The longest prefix a `data` line carries before its value: a line may pass the record bound by this much, so a `data`
 * line whose value is within the bound is.
 */
const dataPrefixBytes = 6

/**
 * The bytes of an ASCII field name.
 */
const fieldBytes = (name: string): ReadonlyArray<number> => Arr.fromIterable(encoder.encode(name))

const dataField = fieldBytes("data")

const eventField = fieldBytes("event")

const idField = fieldBytes("id")

const retryField = fieldBytes("retry")

/**
 * Whether the line's bytes before `end` spell the ASCII field name `name`.
 */
const isField = (line: Uint8Array, end: number, name: ReadonlyArray<number>): boolean =>
	end === name.length && Arr.every(name, (byte, index) => line[index] === byte)

/**
 * Whether a `retry` value is ASCII digits, at least one.
 */
const isDigits = (value: Uint8Array): boolean =>
	value.length > 0 && value.every((byte) => byte >= digitZero && byte <= digitNine)

/**
 * Whether the bytes open with the UTF-8 byte order mark.
 */
const opensWithMark = (bytes: Uint8Array): boolean =>
	Arr.every(byteOrderMark, (byte, index) => bytes[index] === byte)

/**
 * The pieces of a line that crossed chunk ends and the piece that ends it, as one array.
 */
const joined = (pieces: ReadonlyArray<Uint8Array>, last: Uint8Array): Uint8Array => {
	if (pieces.length === 0) {
		return last
	}

	const line = new Uint8Array(
		Arr.reduce(pieces, last.length, (length, piece) => length + piece.length)
	)
	let offset = 0
	for (const piece of [...pieces, last]) {
		line.set(piece, offset)
		offset += piece.length
	}

	return line
}

/**
 * The first `count` bytes of the pieces of a line, or fewer when the pieces hold fewer.
 */
const leading = (pieces: ReadonlyArray<Uint8Array>, count: number): Uint8Array => {
	const head = new Uint8Array(count)
	let filled = 0
	for (const piece of pieces) {
		const taken = piece.subarray(0, count - filled)
		head.set(taken, filled)
		filled += taken.length
	}

	return head.subarray(0, filled)
}

/**
 * The first line end at or after `from`: the first CR or LF, or -1.
 */
const lineEnd = (chunk: Uint8Array, from: number): number => {
	const feed = chunk.indexOf(lineFeed, from)
	const ret = chunk.indexOf(carriageReturn, from)

	return feed === -1 || (ret !== -1 && ret < feed) ? ret : feed
}

/**
 * A `retry` value's digits without their leading zeros, one zero kept when they are all zeros, so they form a JSON
 * number.
 */
const significant = (digits: Uint8Array): Uint8Array => {
	const first = digits.findIndex((byte) => byte !== digitZero)

	return digits.subarray(first === -1 ? digits.length - 1 : first)
}

/**
 * Build the SSE parser of one response body, which reads it as WHATWG HTML reads `text/event-stream`. Lines end at LF,
 * CR or CRLF, a CRLF split across chunks included; the stream's leading byte order mark is dropped; a blank line
 * dispatches the event when it holds data, and an event with no `data` line is never dispatched; a line opening with a
 * colon is a comment; a field's value is what follows its first colon, less one leading space, and a line with no
 * colon is a field with an empty value; `data` appends its value and an LF, `event` sets the type, `id` sets the last
 * event ID unless it holds NUL, `retry` of ASCII digits sets the reconnection time, and any other field is ignored.
 * Lines are split on bytes and each value is decoded as UTF-8 on its own, which reads what decoding the whole body
 * first reads: CR, LF and the colon are ASCII, never part of a multi-byte sequence, and a malformed sequence becomes
 * U+FFFD either way.
 *
 * Two readings are the generator's own, where WHATWG reads without limit or drops what it cannot use. An event whose
 * data passes `maxRecordBytes` bytes fails `recordTooLarge` at the line that passes it, and so does a line longer than
 * the bound and a `data: ` prefix, as soon as the bytes read of it pass that, so memory stays bounded whatever the
 * chunks. A body that ends inside an event, after a field line and before the blank line that would dispatch it, or
 * inside a field line, fails `truncated`. Each failure carries the index of the event being read, after every event
 * before it.
 *
 * The parser is the runtime's own rather than `Sse.makeParser` (effect 4.1.2, `effect/src/encoding/Sse.ts`): that
 * parser reads decoded text, so it cannot say where in the bytes an event ends, which `--raw` needs to stop there; it
 * reads a `retry` field through `parseInt`, which loses digits past 2^53; and it does not say whether an event is open,
 * which `truncated` needs. `Sse.decode` fails the stream on a `retry` field.
 */
export const sseParser = (maxRecordBytes: number): SseParser => {
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
	const pieces: Array<Uint8Array> = []
	const state = {
		afterCarriageReturn: false,
		data: "",
		dataBytes: 0,
		failed: false,
		first: true,
		hasData: false,
		id: Option.none<string>(),
		index: 0,
		open: false,
		pending: 0,
		retry: Option.none<string>(),
		type: ""
	}

	const fail = (reason: "recordTooLarge" | "truncated"): ResponseStreamError => {
		state.failed = true

		return ResponseStreamError.make({ itemIndex: state.index, reason })
	}

	const unmarked = (line: Uint8Array): Uint8Array => {
		const marked = state.first && opensWithMark(line)
		state.first = false

		return marked ? line.subarray(byteOrderMark.length) : line
	}

	const dispatch = (end: number): ReadonlyArray<Parsed> => {
		const event: SseEvent = {
			_tag: "SseEvent",
			data: Str.slice(0, -1)(state.data),
			end,
			id: state.id,
			retry: state.retry,
			type: state.type === "" ? "message" : state.type
		}
		const { hasData } = state
		state.data = ""
		state.dataBytes = 0
		state.hasData = false
		state.open = false
		state.type = ""
		if (!hasData) {
			return []
		}

		state.retry = Option.none()
		state.index += 1

		return [event]
	}

	const field = (line: Uint8Array): void => {
		state.open = true
		const at = line.indexOf(colon)
		const nameEnd = at === -1 ? line.length : at
		const valueStart = at === -1 ? line.length : at + (line[at + 1] === space ? 2 : 1)
		const value = line.subarray(valueStart)
		if (isField(line, nameEnd, dataField)) {
			state.data += `${decoder.decode(value)}\n`
			state.dataBytes += value.length + 1
			state.hasData = true
		} else if (isField(line, nameEnd, eventField)) {
			state.type = decoder.decode(value)
		} else if (isField(line, nameEnd, idField) && !value.includes(nul)) {
			state.id = Option.some(decoder.decode(value))
		} else if (isField(line, nameEnd, retryField) && isDigits(value)) {
			state.retry = Option.some(decoder.decode(significant(value)))
		}
	}

	const readLine = (whole: Uint8Array, end: number): ReadonlyArray<Parsed> => {
		const line = unmarked(whole)
		if (line.length > maxRecordBytes + dataPrefixBytes) {
			return [fail("recordTooLarge")]
		}

		if (line.length === 0) {
			return dispatch(end)
		}

		if (line[0] !== colon) {
			field(line)
		}

		return state.dataBytes - 1 > maxRecordBytes ? [fail("recordTooLarge")] : []
	}

	const lines = (chunk: Uint8Array, from: number): ReadonlyArray<Parsed> => {
		const out: Array<Parsed> = []
		let position = from
		while (!state.failed && position < chunk.length) {
			const stop = lineEnd(chunk, position)
			if (stop === -1) {
				pieces.push(chunk.subarray(position))
				state.pending += chunk.length - position

				return out
			}

			const whole = joined(pieces, chunk.subarray(position, stop))
			pieces.length = 0
			state.pending = 0
			const returned = chunk[stop] === carriageReturn
			state.afterCarriageReturn = returned && stop + 1 === chunk.length
			position = stop + (returned && chunk[stop + 1] === lineFeed ? 2 : 1)
			for (const parsed of readLine(whole, position)) {
				out.push(parsed)
			}
		}

		return out
	}

	return {
		halt: () => {
			const rest = unmarked(joined(pieces, new Uint8Array(0)))
			const inField = rest.length > 0 && rest[0] !== colon

			return !state.failed && (state.open || inField) ? [fail("truncated")] : []
		},
		step: (chunk) => {
			if (state.failed) {
				return []
			}

			const crlfTail = state.afterCarriageReturn && chunk[0] === lineFeed
			state.afterCarriageReturn &&= chunk.length === 0
			const out = lines(chunk, crlfTail ? 1 : 0)
			const mark =
				state.first && opensWithMark(leading(pieces, byteOrderMark.length))
					? byteOrderMark.length
					: 0
			const failed = Arr.some(out, (parsed) => parsed._tag === "ResponseStreamError")
			const overBound = state.pending - mark > maxRecordBytes + dataPrefixBytes

			return !failed && overBound ? [...out, fail("recordTooLarge")] : out
		}
	}
}

/**
 * How an event's data prints: `json`, the server's JSON text with its insignificant whitespace removed and nothing else
 * changed; `text`, a JSON string.
 */
export type EventData = "json" | "text"

/**
 * Where a failure event's JSON data says that retrying is safe: the JSON Pointer (RFC 6901) into the data, and the
 * value that says so.
 */
export interface RetryWhen {
	readonly equals: boolean | number | string
	readonly pointer: string
}

/**
 * What one event type is to its stream, with how its data prints: an `item` is printed and the stream goes on; `ready`
 * ends the stream's initial state, where the command stops unless it follows the stream; `end` ends the stream; and
 * `error` ends it with a failure, which a retry may follow only when the event's JSON data says retrying is safe.
 */
export type EventRow =
	| { readonly data: EventData; readonly role: "end" | "error" | "item" | "ready" }
	| { readonly data: "json"; readonly retryWhen: RetryWhen; readonly role: "error" }

/**
 * An SSE response's events by type, from the media type's `itemSchema`; an event of a type it does not name is an
 * item whose data prints as `otherwise` says.
 */
export interface EventContract {
	readonly events: Readonly<Record<string, EventRow>>
	readonly otherwise: EventData
}

/**
 * An operation's event contracts by response key and then media key, as its emitted meta holds them.
 */
export type EventTable = Readonly<Record<string, Readonly<Record<string, EventContract>>>>

/**
 * The contract of a stream whose `itemSchema` names no event: every event is an item whose data prints as text, and the
 * stream ends with its body.
 */
export const openContract: EventContract = { events: {}, otherwise: "text" }

/**
 * Where a command stops reading its stream: at the first `ready` event, or only at a terminal event (`end` or `error`)
 * or, for a stream whose contract names no role, the end of the body.
 */
export type StopAt = "ready" | "terminal"

/**
 * The stop point a run reads its stream to: provided from `--follow` by a command whose response names a `ready`
 * event, and absent, which reads to the first `ready` event, for every other command.
 */
export class StopPoint extends Context.Service<StopPoint, StopAt>()(
	"effect-openapi-cli-generator/runtime-src/runtime/sse/StopPoint"
) {}

/**
 * `--follow`, which a command whose streamed response names a `ready` event declares: read on past the `ready` event,
 * printing each live change, until the stream ends or the run is interrupted.
 */
export const followFlag = Flag.Boolean("follow").pipe(
	Flag.withDescription(
		"Keep reading the stream after its ready event, until it ends or is interrupted"
	),
	Flag.withDefault(false),
	Flag.map((follow): StopAt => (follow ? "terminal" : "ready"))
)

/**
 * What a command writes of its stream: one JSON line per event, or the bytes received.
 */
export type EventOutput = "bytes" | "lines"

/**
 * How one body is read: under its contract, to its stop point, written as lines or bytes, each event bounded by
 * `maxRecordBytes`.
 */
export interface EventReading {
	readonly contract: EventContract
	readonly maxRecordBytes: number
	readonly output: EventOutput
	readonly stopAt: StopAt
}

/**
 * A stream that ended at an `error` event: its type, data and index, whether its data says retrying is safe, and the
 * reconnection time the stream last set, in milliseconds, as its digits.
 */
export class EventFailed extends Schema.TaggedError<
	EventFailed,
	{ readonly brand: unique symbol }
>()("EventFailed", {
	data: Schema.String,
	event: Schema.String,
	itemIndex: Schema.Int,
	reconnect: Schema.Option(Schema.String),
	retrySafe: Schema.Boolean
}) {}

/**
 * Whether the contract names any role but `item`: such a stream ends only at a terminal event or its stop point, so a
 * body that ends before either was cut short.
 */
export const hasLifecycle = (contract: EventContract): boolean =>
	Arr.some(Rec.values(contract.events), (row) => row.role !== "item")

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const encodeString = Schema.encodeEffect(Schema.fromJsonString(Schema.String))

/**
 * The tokens of a JSON Pointer (RFC 6901), unescaped.
 */
const pointerTokens = (pointer: string): ReadonlyArray<string> =>
	Arr.map(Arr.drop(Str.split("/")(pointer), 1), (token) =>
		Str.replaceAll("~0", "~")(Str.replaceAll("~1", "/")(token))
	)

/**
 * Whether a JSON Pointer token is an array index as RFC 6901 writes one: digits, with no leading zero but `0` itself.
 */
const isArrayIndex = (token: string): boolean =>
	token !== "" &&
	Arr.every(Str.split("")(token), (char) => char >= "0" && char <= "9") &&
	(token === "0" || !Str.startsWith("0")(token))

/**
 * The member a token names in a JSON value: an array's element at an index, or an object's own member.
 */
const memberOf = (value: unknown, token: string): Option.Option<unknown> => {
	if (Arr.isArray(value)) {
		return isArrayIndex(token) ? Arr.get(value, Number(token)) : Option.none()
	}

	return Predicate.isObject(value) ? Rec.get(value, token) : Option.none()
}

/**
 * Whether the event's data, read as JSON, holds the rule's value at the rule's pointer.
 */
const saysSafe = (data: string, rule: RetryWhen): boolean =>
	Option.exists(
		Option.flatMap(decodeJson(data), (json) =>
			Arr.reduce(pointerTokens(rule.pointer), Option.some(json), (found, token) =>
				Option.flatMap(found, (value) => memberOf(value, token))
			)
		),
		(found) => found === rule.equals
	)

/**
 * Whether a retry may follow a failure event under its row.
 */
const retrySafe = (event: SseEvent, row: EventRow): boolean =>
	"retryWhen" in row && saysSafe(event.data, row.retryWhen)

/**
 * A string as a JSON string literal.
 */
const quoted = (text: string): Effect.Effect<string> => Effect.orDie(encodeString(text))

/**
 * One event as its JSON line: `data` as its JSON text or a string, `event` unless it is the default type `message`,
 * `id` when the stream has set one, and `retry` as the digits received when a `retry` field arrived since the previous
 * event, keys alphabetical. JSON data that is not one JSON text fails `invalidFraming` at the event's index.
 */
const eventLine = Effect.fnUntraced(function* eventLine(
	event: SseEvent,
	data: EventData,
	itemIndex: number
) {
	const text =
		data === "json"
			? yield* Effect.fromOption(compactJsonText(event.data)).pipe(
					Effect.mapError(() => ResponseStreamError.make({ itemIndex, reason: "invalidFraming" }))
				)
			: yield* quoted(event.data)
	const type = event.type === "message" ? "" : `,"event":${yield* quoted(event.type)}`
	const id = Option.isSome(event.id) ? `,"id":${yield* quoted(event.id.value)}` : ""
	const retry = Option.match(event.retry, {
		onNone: () => "",
		onSome: (digits) => `,"retry":${digits}`
	})

	return `{"data":${text}${type}${id}${retry}}\n`
})

/**
 * What reading the body does next: write one event and read on, write the stream's last event, write bytes received
 * after the last event, or fail.
 */
type Step =
	| {
			readonly _tag: "Event"
			readonly event: SseEvent
			readonly itemIndex: number
			readonly last: boolean
			readonly received: Uint8Array
			readonly row: EventRow
	  }
	| { readonly _tag: "Bytes"; readonly bytes: Uint8Array }
	| { readonly _tag: "Fail"; readonly failure: EventFailed | ResponseStreamError }

/**
 * One body's reading between chunks: its parser, how many events it has read, the reconnection time the stream last
 * set, and whether the stream has ended.
 */
interface Reading {
	readonly parser: SseParser
	ended: boolean
	index: number
	reconnect: Option.Option<string>
}

/**
 * The steps of one event under the contract: the event, the stream's last when it is the stop point or an `end` event,
 * then the failure when it is an `error` event.
 */
const eventSteps = (
	reading: Reading,
	event: SseEvent,
	received: Uint8Array,
	settings: EventReading
): ReadonlyArray<Step> => {
	const row = Option.getOrElse(Rec.get(settings.contract.events, event.type), (): EventRow => ({
		data: settings.contract.otherwise,
		role: "item"
	}))
	const itemIndex = reading.index
	const last = row.role === "end" || (row.role === "ready" && settings.stopAt === "ready")
	reading.index += 1
	reading.reconnect = Option.orElse(event.retry, () => reading.reconnect)
	reading.ended = last || row.role === "error"
	const step: Step = { _tag: "Event", event, itemIndex, last, received, row }

	return row.role === "error"
		? [
				step,
				{
					_tag: "Fail",
					failure: EventFailed.make({
						data: event.data,
						event: event.type,
						itemIndex,
						reconnect: reading.reconnect,
						retrySafe: retrySafe(event, row)
					})
				}
			]
		: [step]
}

/**
 * The steps one chunk yields: each event's steps in order until the stream ends, then, under `bytes`, the chunk's
 * bytes after the last event, or the parser's failure.
 */
const chunkSteps = (
	reading: Reading,
	chunk: Uint8Array,
	settings: EventReading
): ReadonlyArray<Step> => {
	const steps: Array<Step> = []
	let from = 0
	for (const parsed of reading.ended ? [] : reading.parser.step(chunk)) {
		if (parsed._tag === "ResponseStreamError") {
			reading.ended = true

			return [...steps, { _tag: "Fail", failure: parsed }]
		}

		for (const step of eventSteps(reading, parsed, chunk.subarray(from, parsed.end), settings)) {
			steps.push(step)
		}
		from = parsed.end
		if (reading.ended) {
			return steps
		}
	}

	return settings.output === "bytes" && !reading.ended && from < chunk.length
		? [...steps, { _tag: "Bytes", bytes: chunk.subarray(from) }]
		: steps
}

/**
 * The steps at the body's end: the parser's `truncated` for a body cut inside an event, else `truncated` for a stream
 * whose contract names a role and that ended before a terminal event or its stop point.
 */
const haltSteps = (reading: Reading, settings: EventReading): ReadonlyArray<Step> => {
	if (reading.ended) {
		return []
	}

	const cut = reading.parser.halt()
	const failures =
		cut.length === 0 && hasLifecycle(settings.contract)
			? [ResponseStreamError.make({ itemIndex: reading.index, reason: "truncated" })]
			: cut

	return Arr.map(failures, (failure): Step => ({ _tag: "Fail", failure }))
}

/**
 * The bytes one step writes: an event's JSON line, or under `bytes` the bytes received through the line that
 * dispatched it; bytes received after the last event; or the step's failure.
 */
const stepBytes =
	(output: EventOutput) =>
	(step: Step): Effect.Effect<Uint8Array, EventFailed | ResponseStreamError> => {
		switch (step._tag) {
			case "Event":
				return output === "bytes"
					? Effect.succeed(step.received)
					: Effect.map(eventLine(step.event, step.row.data, step.itemIndex), (line) =>
							encoder.encode(line)
						)
			case "Bytes":
				return Effect.succeed(step.bytes)
			case "Fail":
				return Effect.fail(step.failure)
		}
	}

/**
 * Read a `text/event-stream` body under its event contract (`sseParser`), writing each event as one JSON line
 * (`eventLine`) or, under `bytes`, the bytes received through the line that dispatched it, as each event is
 * dispatched. The stream ends after the event that is its stop point: the first `ready` event under `ready`, an `end`
 * event under either. After an `error` event it fails with `EventFailed`, which says whether the data allows a retry.
 * A body that ends inside an event fails `truncated`, as does one that ends before a terminal event or its stop point
 * when the contract names any role; one whose contract names none ends with its body. A framing failure ends the
 * stream after the events before it.
 */
export const eventStream =
	(settings: EventReading) =>
	<E, R>(
		body: Stream.Stream<Uint8Array, E, R>
	): Stream.Stream<Uint8Array, E | EventFailed | ResponseStreamError, R> =>
		body.pipe(
			Stream.mapAccum(
				(): Reading => ({
					ended: false,
					index: 0,
					parser: sseParser(settings.maxRecordBytes),
					reconnect: Option.none()
				}),
				(reading, chunk: Uint8Array) => [reading, chunkSteps(reading, chunk, settings)] as const,
				{ onHalt: (reading) => haltSteps(reading, settings) }
			),
			Stream.takeUntil((step) => step._tag === "Event" && step.last),
			Stream.mapEffect(stepBytes(settings.output))
		)
