import * as Stream from "effect/Stream"

/**
 * One event an event stream dispatched (WHATWG HTML, "Interpreting an event stream"): its type, the value of its last
 * `event` field, or "message" where it had none or an empty one; and its data, the values of its `data` fields joined
 * by line feeds.
 */
export interface SseEvent {
	readonly type: string
	readonly data: string
}

/**
 * What a reading of an event stream holds between two pieces of its text: the line begun and not yet ended, whether
 * the text so far ended in a carriage return, whose line it ended, so that a line feed opening the next piece ends no
 * second line, and the event being built, the grammar's event type buffer and data buffer, each data line's value
 * followed by a line feed.
 */
interface SseReading {
	readonly line: string
	readonly afterReturn: boolean
	readonly type: string
	readonly data: string
}

/** A reading before any text: no line begun, and an empty event. */
const sseStart: SseReading = Object.freeze({
	line: "",
	afterReturn: false,
	type: "",
	data: ""
})

/** A field line's value: the text after its first colon, less one leading space; empty for a line with no colon. */
const valueOf = (line: string, colon: number): string =>
	colon < 0 ? "" : line.slice(line.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1)

/**
 * The next piece of an event stream's decoded text read on from `reading`: the reading after it, and the events its
 * blank lines dispatched, in order. A line ends at CRLF, LF or CR; a CR that ends the piece ends its line at once, and a
 * line feed opening the next piece completes that CRLF. A line starting with a colon is a comment, a heartbeat; `event`
 * sets the type and `data` appends a line to the data; every other field, `id` and `retry` included, reads nothing an
 * event carries, since no call resumes by an event id. Each line ends in the piece that ends it, whatever piece it
 * began in, so where the text is cut into pieces changes nothing it reads.
 */
const readSse = (
	reading: SseReading,
	text: string
): readonly [SseReading, ReadonlyArray<SseEvent>] => {
	const events: Array<SseEvent> = []
	let type = reading.type
	let data = reading.data
	const take = (whole: string): void => {
		const colon = whole.indexOf(":")
		const field = colon < 0 ? whole : whole.slice(0, colon)
		if (whole.length === 0) {
			if (data.length > 0) {
				events.push({ type: type.length === 0 ? "message" : type, data: data.slice(0, -1) })
			}
			type = ""
			data = ""
		} else if (field === "event") {
			type = valueOf(whole, colon)
		} else if (field === "data") {
			data = `${data}${valueOf(whole, colon)}\n`
		}
	}
	let line = reading.line
	let afterReturn = reading.afterReturn && text.length === 0
	let start = reading.afterReturn && text.charCodeAt(0) === 0x0a ? 1 : 0
	let feed = text.indexOf("\n", start)
	let carriage = text.indexOf("\r", start)
	while (feed >= 0 || carriage >= 0) {
		const end = carriage < 0 || (feed >= 0 && feed < carriage) ? feed : carriage
		take(line + text.slice(start, end))
		line = ""
		const crlf = end === carriage && text.charCodeAt(end + 1) === 0x0a
		afterReturn = end === carriage && end + 1 === text.length
		start = crlf ? end + 2 : end + 1
		feed = feed >= 0 && feed < start ? text.indexOf("\n", start) : feed
		carriage = carriage >= 0 && carriage < start ? text.indexOf("\r", start) : carriage
	}
	return [{ line: line + text.slice(start), afterReturn, type, data }, events]
}

/**
 * The events of an event stream's bytes, read by the WHATWG grammar: decoded as UTF-8 across chunk boundaries, a
 * leading byte order mark dropped, and each piece read on from the last (readSse). The events end where the bytes end,
 * and an event the bytes leave unended is dropped, as the grammar drops it.
 */
export const sseEvents = <E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<SseEvent, E, R> =>
	bytes.pipe(
		Stream.decodeText,
		Stream.mapAccum(() => sseStart, readSse)
	)
