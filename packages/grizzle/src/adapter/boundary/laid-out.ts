/**
 * A file generate lays out in parts, read back (deploy/render/parts.ts): its entries read in order, each a block at a
 * time (adapter/boundary/files.ts readText), and their texts joined into the one text generate laid out, before anything
 * of it is read. Only generate, check, migrate and the lock report read such a file.
 */
import { joinedParts, type TextChunks } from "@bjornpagen/grizzle-text/chunks"
import { Array as Arr, Effect, FileSystem, Path, type PlatformError } from "effect"
import { readText } from "#adapter/boundary/files.ts"
import { toResult } from "#adapter/engine.ts"
import { type Artifact, type CompileError, malformedArtifact } from "#compiler/plan/common.ts"
import { isEntryOf, type LaidOutFile, laidOutFiles } from "#compiler/plan/migration.ts"

/** A laid-out file of `directory` read as its one text (deploy/render/parts.ts): its entries read in order (readText),
 * their texts joined (grizzle-text joinedParts), so every reader reads the text generate laid out, whole. */
export const readLaidOut = (
	directory: string,
	file: LaidOutFile
): Effect.Effect<TextChunks, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const parts = yield* Effect.forEach(file.entries, (entry) =>
			readText(path.join(directory, entry))
		)
		return joinedParts(parts)
	})

/**
 * The text of the file `name` of `directory` as generate laid it out: its entries among the directory's (parts.ts
 * isEntryOf) read as one (readLaidOut), the file whole or its parts joined; refused as MalformedArtifact of `artifact`
 * where none is, or where its parts lay out no file (parts.ts laidOutFiles).
 */
export const readNamed = (
	directory: string,
	name: string,
	artifact: Artifact
): Effect.Effect<
	TextChunks,
	CompileError | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const listed = yield* fs.readDirectory(directory)
		const entries = Arr.filter(listed, (e) => isEntryOf(e, name))
		const files = yield* Effect.mapError(Effect.fromResult(toResult(laidOutFiles(entries))), () =>
			malformedArtifact(artifact, [], `${name} whole, or its parts numbered from 1, at least two`)
		)
		const file = yield* Effect.mapError(Effect.fromOption(Arr.head(files)), () =>
			malformedArtifact(artifact, [], `${directory} holding ${name}`)
		)
		return yield* readLaidOut(directory, file)
	})
