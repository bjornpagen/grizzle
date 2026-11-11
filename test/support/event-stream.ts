import { Array as Arr, Data, Effect, Option, type Scope, String as Str } from "effect"

/**
 * An event stream as a client reads it, by WHATWG HTML's interpretation of text/event-stream (section 9.2.6): the one
 * reader the HTTP suites hold an answer's bytes to, written from the specification and never from the server's
 * framing. Lines end at CRLF, LF or CR; a line starting with `:` is a comment; `event` names the event and `data`
 * appends a line to its data; a blank line dispatches the event when its data is not empty. Every field name the
 * stream holds is kept, so a suite can hold a server to sending no `id` and no `retry`.
 */

/** One dispatched event: its type, `message` when no `event` field named one, and its data lines joined by LF. */
export interface StreamEvent {
	readonly event: string
	readonly data: string
}

/** What a stream's bytes read so far hold: its dispatched events, its comment lines, and every field name it sent. */
export interface StreamRead {
	readonly events: ReadonlyArray<StreamEvent>
	readonly comments: number
	readonly fields: ReadonlySet<string>
}

/** The parser's state between chunks: the line not yet ended, and the event being built. */
interface Pending {
	readonly line: string
	readonly event: string
	readonly data: ReadonlyArray<string>
	readonly lastWasCr: boolean
}

const fresh: Pending = { line: "", event: "", data: [], lastWasCr: false }

/** A parser fed text chunk by chunk, which keeps what it has read (StreamRead). */
class StreamParser {
	private pending: Pending = fresh
	private readonly events: Array<StreamEvent> = []
	private comments = 0
	private readonly fields = new Set<string>()

	feed(text: string): void {
		for (const c of text) {
			const was = this.pending.lastWasCr
			if (c === "\n" && was) {
				this.pending = { ...this.pending, lastWasCr: false }
			} else if (c === "\n" || c === "\r") {
				this.endLine()
				this.pending = { ...this.pending, lastWasCr: c === "\r" }
			} else {
				this.pending = { ...this.pending, line: this.pending.line + c, lastWasCr: false }
			}
		}
	}

	private endLine(): void {
		const line = this.pending.line
		this.pending = { ...this.pending, line: "" }
		if (line === "") {
			if (this.pending.data.length > 0) {
				this.events.push({
					event: this.pending.event === "" ? "message" : this.pending.event,
					data: Arr.join(this.pending.data, "\n")
				})
			}
			this.pending = { ...fresh, lastWasCr: this.pending.lastWasCr }
			return
		}
		if (Str.startsWith(":")(line)) {
			this.comments += 1
			return
		}
		const [field, raw] = Option.match(Str.indexOf(":")(line), {
			onNone: () => [line, ""] as const,
			onSome: (colon) => [Str.slice(0, colon)(line), Str.slice(colon + 1)(line)] as const
		})
		const value = Str.startsWith(" ")(raw) ? Str.slice(1)(raw) : raw
		this.fields.add(field)
		if (field === "event") {
			this.pending = { ...this.pending, event: value }
		} else if (field === "data") {
			this.pending = { ...this.pending, data: [...this.pending.data, value] }
		}
	}

	read(): StreamRead {
		return { events: [...this.events], comments: this.comments, fields: new Set(this.fields) }
	}
}

/** A body that could not be read to the point a suite waited for. */
class StreamUnread extends Data.TaggedError("StreamUnread")<{ readonly cause: unknown }> {}

/** A body being read: each `until` reads on from where the last stopped, until `enough` holds or the body ends. */
export interface OpenStream {
	readonly until: (enough: (read: StreamRead) => boolean) => Effect.Effect<StreamRead, StreamUnread>
}

/**
 * `body` opened for reading in the current scope, decoding UTF-8 as a stream; closing the scope cancels the body, as a
 * client that goes away does: a reader that stops at a read's `ready` leaves a live stream behind it, which the cancel
 * ends.
 */
export const openStream = (
	body: ReadableStream<Uint8Array>
): Effect.Effect<OpenStream, never, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
			Effect.sync(() => body.getReader()),
			(reader) => Effect.promise(() => reader.cancel())
		),
		(reader) => {
			const parser = new StreamParser()
			const utf8 = new TextDecoder("utf-8", { fatal: true })
			return {
				until: (enough) =>
					Effect.gen(function* () {
						while (!enough(parser.read())) {
							const chunk = yield* Effect.tryPromise({
								try: () => reader.read(),
								catch: (cause) => new StreamUnread({ cause })
							})
							if (chunk.done) {
								parser.feed(utf8.decode())
								return parser.read()
							}
							parser.feed(utf8.decode(chunk.value, { stream: true }))
						}
						return parser.read()
					})
			}
		}
	)

/** `body` read until `enough` holds of what it has read or the body ends, then cancelled (openStream). */
export const readStream = (
	body: ReadableStream<Uint8Array>,
	enough: (read: StreamRead) => boolean
): Effect.Effect<StreamRead, StreamUnread> =>
	Effect.scoped(Effect.flatMap(openStream(body), (open) => open.until(enough)))

/** Whether a read holds at least `count` events of type `event`. */
export const holdsCount =
	(event: string, count: number) =>
	(read: StreamRead): boolean =>
		Arr.filter(read.events, (e) => e.event === event).length >= count
