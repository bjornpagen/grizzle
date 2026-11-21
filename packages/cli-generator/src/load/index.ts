import { utf8Length, utf8Text, type Json } from "@bjornpagen/grizzle-text/utf8"
import { Effect, Option, String as Str } from "effect"
import type { FileSystem, PlatformError, Stream } from "effect"
import { parseStrictJson } from "#load/json.ts"
import { readOperatorFile, readStreamBytes, refuse, wholeInput } from "#load/read.ts"
import type { LoadRefusal } from "#load/read.ts"
import { parseStrictYaml } from "#load/yaml.ts"
import type { DocumentUri } from "#model/brands.ts"

export { LoadRefusal } from "#load/read.ts"

export interface LoadOptions {
	readonly document: DocumentUri
}

export interface Loaded {
	readonly document: DocumentUri
	readonly format: "json" | "yaml"
	readonly value: Json
}

/** A byte order mark, which grizzle-text's utf8Text keeps as a character. */
const BYTE_ORDER_MARK = "\uFEFF"

/**
 * A document's text past a leading byte order mark, which the loader skips, and the byte offset the text starts at, so
 * a refusal's offset counts the mark's bytes.
 */
const pastMark = (text: string): readonly [text: string, base: number] =>
	Str.startsWith(BYTE_ORDER_MARK)(text)
		? [Str.slice(BYTE_ORDER_MARK.length)(text), utf8Length(BYTE_ORDER_MARK)]
		: [text, 0]

/**
 * Loads one document from bytes already read. The first non-whitespace character picks the
 * format, never the extension: `{` is JSON, anything else is YAML (design 3.1).
 */
export const loadBytes = Effect.fn("load.loadBytes")(function* loadBytes(
	bytes: Uint8Array,
	options: LoadOptions
): Effect.fn.Return<Loaded, LoadRefusal> {
	const { document } = options

	return yield* Option.match(Option.map(Option.fromUndefinedOr(utf8Text(bytes)), pastMark), {
		onNone: () => refuse(document, "DOC-14/invalid-encoding", wholeInput),
		onSome: ([text, base]) =>
			Str.startsWith("{")(Str.trimStart(text))
				? parseStrictJson(text, document, base).pipe(
						Effect.map((value): Loaded => ({ document, format: "json", value }))
					)
				: parseStrictYaml(text, document, base).pipe(
						Effect.map((value): Loaded => ({ document, format: "yaml", value }))
					)
	})
})

/**
 * Loads one document from a file the operator named, read whole from the handle it checked.
 */
export const loadFile = Effect.fn("load.loadFile")(function* loadFile(
	path: string,
	options: LoadOptions
): Effect.fn.Return<Loaded, LoadRefusal, FileSystem.FileSystem> {
	const bytes = yield* readOperatorFile(path, options.document)

	return yield* loadBytes(bytes, options)
})

/**
 * Loads one document from a byte stream (stdin), read whole.
 */
export const loadStream = Effect.fn("load.loadStream")(function* loadStream(
	stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
	options: LoadOptions
): Effect.fn.Return<Loaded, LoadRefusal> {
	const bytes = yield* readStreamBytes(stream, options.document)

	return yield* loadBytes(bytes, options)
})
