/**
 * The files a command reads as texts, each as its chunks (grizzle-text TextChunks), never as one string: a file read a
 * block at a time (readText), and a file held to a text by their bytes as the file's are read (matchesFile). A file
 * grizzle writes may be longer than any string V8 builds (a served file), and one string as long as a whole file, once
 * built, is one allocation the heap must find room for.
 */
import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import {
	ByteMatch,
	type BytesParting,
	ChunkWriter,
	chunkBytes,
	type TextChunks
} from "@bjornpagen/grizzle-text/chunks"
import { isWellFormedText } from "@bjornpagen/grizzle-text/utf8"
import { Effect, FileSystem, type PlatformError, Stream } from "effect"

/**
 * A file's text read a block at a time as its chunks (grizzle-text TextChunks), each block decoded as it is read as
 * FileSystem's readFileString decodes a file whole (TextDecoder's UTF-8, a sequence a block cuts carried into the next),
 * so no string of the whole file is ever built.
 */
export const readText = (
	path: string
): Effect.Effect<TextChunks, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const out = new ChunkWriter()
		yield* fs.stream(path).pipe(
			Stream.decodeText,
			Stream.runForEach((piece) =>
				Effect.sync(() => {
					if (!isWellFormedText(piece)) {
						defect("a decoder's text is well-formed")
					}
					out.append(piece)
				})
			)
		)
		return out.chunks()
	})

/**
 * Where the file at `path` parts from `text` (grizzle-text BytesParting): its bytes, read a block at a time, held to the
 * text's UTF-8, encoded a chunk at a time as the file's bytes reach it (ByteMatch), so neither is ever held whole.
 */
export const matchesFile = (
	path: string,
	text: TextChunks
): Effect.Effect<BytesParting, PlatformError.PlatformError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const match = new ByteMatch(chunkBytes(text))
		yield* fs.stream(path).pipe(Stream.runForEach((block) => Effect.sync(() => match.next(block))))
		return match.end()
	})
