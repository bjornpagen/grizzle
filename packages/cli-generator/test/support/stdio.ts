import { utf8Chunks, utf8Text } from "@bjornpagen/grizzle-text/utf8"
import { Array as Arr, Data, Effect, Option, Sink, Stream } from "effect"

/** A reading of UTF-8 bytes as text, or a defect where they are none: a harness reading a stream as text has no other. */
const decoded = (text: string | undefined): Effect.Effect<string> =>
	Option.match(Option.fromUndefinedOr(text), {
		onNone: () => Effect.die("a test stream received bytes that are no UTF-8 text"),
		onSome: Effect.succeed
	})

/** The text one whole chunk a test's stdout or stderr received carries: the text written, or the UTF-8 its bytes are. */
export const chunkText = (chunk: string | Uint8Array): Effect.Effect<string> =>
	typeof chunk === "string" ? Effect.succeed(chunk) : decoded(utf8Text(chunk))

/** No text, or one: what a run of bytes adds, which is nothing while they end inside a character. */
const someText = (text: string): ReadonlyArray<string> => (text === "" ? [] : [text])

/**
 * A test stream's sink, for `Stdio.layerTest`: `onText` called with each text one run of it receives, in order. A text
 * written is handed on as written; bytes are read as one UTF-8 text across their chunks, so a character a write cuts
 * between two chunks is handed on whole, with the chunk that ends it, and a chunk that only begins one hands on
 * nothing. A sequence still cut when a text is written or the stream ends is no UTF-8, and dies.
 */
export const receiving = (onText: (text: string) => void) => () =>
	Sink.suspend(() => {
		const reader = utf8Chunks()
		const read = (chunk: string | Uint8Array): Effect.Effect<ReadonlyArray<string>> =>
			typeof chunk === "string"
				? Effect.map(decoded(reader.end()), (held) => [`${held}${chunk}`])
				: Effect.map(decoded(reader.chunk(chunk)), someText)
		const hand = (texts: ReadonlyArray<string>): void => {
			for (const text of texts) {
				onText(text)
			}
		}
		return Sink.forEachArray((chunks: ReadonlyArray<string | Uint8Array>) =>
			Effect.map(Effect.forEach(chunks, read), (texts) => hand(Arr.flatten(texts)))
		).pipe(Sink.mapEffect(() => Effect.map(decoded(reader.end()), (rest) => hand(someText(rest)))))
	})

/** A test stream's sink, for `Stdio.layerTest`: every text one run of it receives appended to `into` (`receiving`). */
export const appendingTo = (into: Array<string>) =>
	receiving((text) => {
		into.push(text)
	})

/** A live stream whose bytes are no UTF-8 text, which ends its reading. */
class StreamNotUtf8 extends Data.TaggedError("StreamNotUtf8") {}

/**
 * The text a live stream's bytes carry, read as they arrive: decoded across chunk boundaries, so a character two
 * chunks split reads whole (utf8Chunks), and failing with StreamNotUtf8 where the bytes are no UTF-8 text. For a stream
 * a test cannot collect whole, such as a live read that never ends; a whole buffer goes through chunkText.
 */
export const streamText = <E, R>(
	bytes: Stream.Stream<Uint8Array, E, R>
): Stream.Stream<string, E | StreamNotUtf8, R> =>
	Stream.suspend(() => {
		const reader = utf8Chunks()
		const read = (text: string | undefined): Effect.Effect<string, StreamNotUtf8> =>
			Effect.mapError(Effect.fromNullishOr(text), () => new StreamNotUtf8())
		return Stream.concat(
			Stream.mapEffect(bytes, (chunk) => read(reader.chunk(chunk))),
			Stream.fromEffect(Effect.suspend(() => read(reader.end())))
		)
	})
