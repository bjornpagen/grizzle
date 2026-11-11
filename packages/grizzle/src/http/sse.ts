import { Stream } from "effect"
import { type WireJson, wireText } from "#compiler/plan/runtime.ts"

/**
 * The text/event-stream framing of a call's answer (WHATWG HTML, server-sent events): each event one `event:` line
 * naming it and one `data:` line holding its JSON, then the blank line that dispatches it, and a heartbeat a comment
 * line. No event carries an id or a retry field: a reconnect is a new call. JSON text holds no line break (a string's
 * are escaped), so one `data:` line holds the whole value, and every event holds one, `{}` at least, since a parser
 * drops an event whose data is empty.
 */

/** One event of a call's answer as its lines carry it: its name and its data. */
export interface SseEvent {
	readonly event: string
	readonly data: WireJson
}

/**
 * The headers of every answer: the stream's media type, and no cache and no proxy buffering, so each event reaches the
 * client as it is written. None is connection-specific, so HTTP/2 and HTTP/3 carry them as HTTP/1.1 does.
 */
export const sseHeaders: Readonly<Record<string, string>> = Object.freeze({
	"content-type": "text/event-stream",
	"cache-control": "no-cache",
	"x-accel-buffering": "no"
})

const utf8 = new TextEncoder()

/** The bytes of one event: its `event:` line, its `data:` line, and the blank line that dispatches it. */
const sseBytes = (frame: SseEvent): Uint8Array =>
	utf8.encode(`event: ${frame.event}\ndata: ${wireText(frame.data)}\n\n`)

/** The bytes of one heartbeat: a comment line, which a parser skips. */
const heartbeatBytes = (): Uint8Array => utf8.encode(": \n")

/**
 * `events` framed, each the bytes of one event (sseBytes), beside a heartbeat every `heartbeatMs` milliseconds from the
 * answer's start, which ends when the events end. The heartbeat keeps a quiet live read's connection open through
 * proxies and idle timeouts; the interval is the caller's.
 */
export const sseStream = <E, R>(
	events: Stream.Stream<SseEvent, E, R>,
	heartbeatMs: number
): Stream.Stream<Uint8Array, E, R> =>
	Stream.merge(Stream.map(events, sseBytes), Stream.map(Stream.tick(heartbeatMs), heartbeatBytes), {
		haltStrategy: "left"
	})
