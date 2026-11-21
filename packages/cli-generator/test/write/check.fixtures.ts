/**
 * What the properties of check.test.ts read: the golden package's inputs laid out under a root as a caller would keep
 * them, a generation of them as `generate` runs it (file URLs of the real paths, as main.ts names a document), and the
 * faults an output directory can carry against a fresh generation.
 */

import { defined } from "@bjornpagen/testing/assert"
import { element, type FiniteSpace, finite, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Order, Path } from "effect"
import type { Digest } from "effect/crypto"
import { checkGeneration, generate } from "#generate.ts"
import { isDocumentUri } from "#model/brands.ts"
import { writeFiles } from "#write/index.ts"
import type { CheckDifference } from "#write/index.ts"
import { manifestFileName } from "#write/manifest.ts"

/**
 * Where a caller keeps the spec, the author config and the output directory, each relative to one root: the config
 * beside the spec or in a directory of its own, the output beside them or nested deeper.
 */
export type Layout = Readonly<{ spec: string; config: string; out: string }>

const LAYOUTS: Arr.NonEmptyReadonlyArray<Layout> = [
	{ spec: "openapi.json", config: "author-config.json", out: "out" },
	{ spec: "spec/openapi.json", config: "config/author-config.json", out: "generated/cli" },
	{ spec: "api/v1/openapi.json", config: "author-config.json", out: "packages/cli" }
]

/** Every layout once. */
export const layouts: FiniteSpace<Layout> = finite((source) => source.draw(element(LAYOUTS)))

/** The golden package's spec and author config, as text. */
const goldenTexts = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const golden = path.join(import.meta.dirname, "../fixtures/golden/users-update")
	return {
		spec: yield* fs.readFileString(path.join(golden, "openapi.json")),
		config: yield* fs.readFileString(path.join(golden, "author-config.json"))
	}
})

/** A file URL of an absolute path, as main.ts names a document: its retrieval URI. */
const documentOf = (absolute: string) =>
	Effect.map(
		Effect.flatMap(Path.Path, (path) => path.toFileUrl(absolute)),
		(url) => defined(isDocumentUri(url.href) ? url.href : undefined, "a file URL is a URI")
	)

/** The inputs of one generation under `root`: the golden texts written where the layout puts them. */
const inputsUnder = (root: string, layout: Layout) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const texts = yield* goldenTexts
		const spec = path.join(root, layout.spec)
		const config = path.join(root, layout.config)
		yield* fs.makeDirectory(path.dirname(spec), { recursive: true })
		yield* fs.makeDirectory(path.dirname(config), { recursive: true })
		yield* fs.writeFileString(spec, texts.spec)
		yield* fs.writeFileString(config, texts.config)
		const input = {
			document: yield* documentOf(spec),
			outDir: path.join(root, layout.out),
			source: { _tag: "File" as const, path: spec },
			strict: false
		}
		return { input, config: { document: yield* documentOf(config), path: config } }
	})

/** Every file of a directory, by its path relative to it, in path order, with its text. */
const filesOf = (dir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const entries = yield* fs.readDirectory(dir, { recursive: true })
		const files = yield* Effect.filter(entries, (entry) =>
			Effect.map(fs.stat(path.join(dir, entry)), (info) => info.type === "File")
		)
		return yield* Effect.forEach(Arr.sort(files, Order.String), (file) =>
			Effect.map(fs.readFileString(path.join(dir, file)), (text) => [file, text] as const)
		)
	})

/** A generation under `root` in `layout`: every file it wrote, and the root's own absolute path. */
export const generatedUnder = (root: string, layout: Layout) =>
	Effect.gen(function* () {
		const { input, config } = yield* inputsUnder(root, layout)
		yield* generate(input, config)
		return yield* filesOf(input.outDir)
	})

/** Whether a text names a host path of `root`, as a path or inside a file URL. */
export const namesRoot = (text: string, root: string): boolean => text.includes(root)

/** A fault an output directory carries against a fresh generation, at one of its files where it names one. */
export type Fault =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "edited" | "missing"; at: number }>
	| Readonly<{ kind: "extra" }>

/** Every fault, at each of the first eight files a generation writes, the manifest counted among them. */
export const faults: FiniteSpace<Fault> = finite((source) => {
	const kind = source.draw(element(["none", "edited", "missing", "extra"] as const))
	switch (kind) {
		case "none":
		case "extra":
			return { kind }
		case "edited":
		case "missing":
			return { kind, at: source.draw(int(0, 7)) }
	}
})

/** The name of an extra file a stale generation left: listed by the manifest, written by no fresh one. */
const STALE = "api/stale.ts"

/** The situation a fault reaches, by its kind and, for a faulted file, whether it is the manifest. */
export type CheckFeature =
	| "a fresh generation passes"
	| "an extra file the manifest lists"
	| "a generated file edited"
	| "a generated file missing"
	| "the manifest edited"
	| "the manifest missing"

/** One file a fault names, and the situation it reaches. */
const faulted = (written: readonly string[], at: number, kind: "edited" | "missing") => {
	const file = defined(written[at % written.length], "the generation wrote a file there")
	const feature: CheckFeature =
		file === manifestFileName ? `the manifest ${kind}` : `a generated file ${kind}`
	return { file, feature }
}

/**
 * An output directory generated fresh, then given `fault`: what `checkGeneration` finds there, what the fault leaves
 * (the faulted file named; for an extra file, the manifest edited and the extra file it lists; nothing for none), and
 * the situation reached.
 */
export const checkedAfter = (root: string, fault: Fault) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const { input, config } = yield* inputsUnder(root, Arr.headNonEmpty(LAYOUTS))
		const result = yield* generate(input, config)
		const written = [...result.files, manifestFileName]
		const left = (): Effect.Effect<
			Readonly<{ expected: readonly CheckDifference[]; feature: CheckFeature }>,
			unknown,
			FileSystem.FileSystem | Path.Path | Digest.Digest
		> => {
			switch (fault.kind) {
				case "none":
					return Effect.succeed({ expected: [], feature: "a fresh generation passes" })
				case "edited": {
					const { file, feature } = faulted(written, fault.at, "edited")
					return Effect.as(
						fs.writeFileString(path.join(input.outDir, file), "edited\n", { flag: "a" }),
						{ expected: [{ kind: "edited", path: file }], feature }
					)
				}
				case "missing": {
					const { file, feature } = faulted(written, fault.at, "missing")
					return Effect.as(fs.remove(path.join(input.outDir, file)), {
						expected: [{ kind: "missing", path: file }],
						feature
					})
				}
				case "extra":
					return Effect.flatMap(
						Effect.forEach(result.files, (file) =>
							Effect.map(fs.readFileString(path.join(input.outDir, file)), (content) => ({
								content,
								path: file
							}))
						),
						(kept) =>
							Effect.as(
								writeFiles(input.outDir, [...kept, { content: "export {}\n", path: STALE }]),
								{
									expected: [
										{ kind: "edited", path: manifestFileName },
										{ kind: "extra", path: STALE }
									],
									feature: "an extra file the manifest lists"
								}
							)
					)
			}
		}
		const { expected, feature } = yield* left()
		const found = yield* checkGeneration(input, config)
		return { expected, feature, found }
	})
