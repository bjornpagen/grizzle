import { Brand, Effect, FileSystem } from "effect"

/**
 * A file's canonical path: what realpath answers, every symlink followed (macOS's /tmp is /private/tmp), so one file has
 * one spelling, the one Node names the module by when it loads it. Only realPathOf mints one.
 */
export type RealPath = string & Brand.Brand<"RealPath">

const realPath = Brand.nominal<RealPath>()

/** The canonical path of the file at `path`. */
export const realPathOf = Effect.fnUntraced(function* (path: string) {
	const fs = yield* FileSystem.FileSystem
	const resolved = yield* fs.realPath(path)
	return realPath(resolved)
})

/**
 * One mutant as a test process sees it: the file it replaces, by its canonical path, and the text that file holds
 * instead. Nothing is written anywhere; the text reaches each test process as this value.
 */
export type MutatedFile = Readonly<{ target: RealPath; text: string }>

declare module "vitest" {
	interface ProvidedContext {
		"superstarter.testing.mutated": MutatedFile
	}
}
