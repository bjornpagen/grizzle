/**
 * What the property of determinism.test.ts reads: a drawn document and an author config that fits it, generated into a
 * directory of its own, and the tree of files the generation leaves there.
 */

import type { Gen } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Order, Path, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { Hex } from "effect/encoding"
import { generate } from "#generate.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import {
	type ConfigSketch,
	configGen,
	configOf,
	type DocumentSketch,
	documentGen,
	documentOf,
	textOf
} from "#test/support/openapi-gen.ts"

/** A drawn document of any line and an author config drawn for it. */
export type GenerationCase = Readonly<{ document: DocumentSketch; config: ConfigSketch }>

export const generationSpace: Gen<GenerationCase> = (source) => {
	const document = source.draw(documentGen)
	return { document, config: source.draw(configGen(document)) }
}

export type DeterminismFeature =
	| "a package of several operations"
	| `a ${DocumentSketch["line"]} document`

/** The features a case reaches. */
export const determinismFeaturesOf = (c: GenerationCase): ReadonlyArray<DeterminismFeature> => [
	`a ${c.document.line} document`,
	...(c.document.operations.length > 1 ? ["a package of several operations" as const] : [])
]

/** One file of a generated tree: its path in the output directory, `/`-separated, and its bytes in hex. */
type Written = Readonly<{ relative: string; bytes: string }>

/**
 * Generates the case's document under its author config into `<scratch>/<name>/out`, the document and the config
 * written beside it, and reads back every file under the output directory, sorted by path, byte for byte.
 */
export const treeOf = (
	scratch: ScratchDir,
	digest: typeof Digest.Digest.Service,
	name: string,
	c: GenerationCase
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.join(scratch, name)
		const specPath = path.join(directory, "openapi.json")
		const configPath = path.join(directory, "author-config.json")
		const out = path.join(directory, "out")
		yield* fs.makeDirectory(directory, { recursive: true })
		yield* fs.writeFileString(specPath, textOf(documentOf(c.document)))
		yield* fs.writeFileString(configPath, textOf(configOf(c.config)))
		yield* generate(
			{
				document: fixedDocumentUri("file:///determinism/openapi.json"),
				outDir: out,
				source: { _tag: "File", path: specPath },
				strict: false
			},
			{ document: fixedDocumentUri("file:///determinism/author-config.json"), path: configPath }
		).pipe(Effect.provideService(Digest.Digest, digest))
		const relatives = yield* fs.readDirectory(out, { recursive: true })
		const files = yield* Effect.filter(relatives, (relative) =>
			fs.stat(path.join(out, relative)).pipe(Effect.map((info) => info.type === "File"))
		)
		return yield* Effect.forEach(Arr.sort(files, Order.String), (relative) =>
			fs.readFile(path.join(out, relative)).pipe(
				Effect.map((bytes): Written => ({
					relative: Arr.join(Str.split(relative, path.sep), "/"),
					bytes: Hex.encode(bytes)
				}))
			)
		)
	})
