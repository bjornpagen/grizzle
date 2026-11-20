/**
 * What the property of manifest.test.ts reads: the files of a generated package, the manifest text the writer prints for
 * them, and that text spoiled by one flaw, each read back as a later run reads the manifest it finds.
 */

import { dictionary, word } from "@bjornpagen/testing/dictionary"
import {
	aimed,
	type Aimed,
	characterOf,
	constant,
	type Gen,
	oneOf,
	string,
	uniqueArray
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Order, Result, String as Str } from "effect"
import type { Schema } from "effect"
import { Digest } from "effect/crypto"
import { sha256Hex } from "#model/digest.ts"
import { jsonText } from "#runtime/json.ts"
import {
	decodeManifest,
	type ManifestEntry,
	manifestFileName,
	printManifest
} from "#write/manifest.ts"

/** How a manifest text as a whole departs from the manifest's shape, or `none` for the text the writer prints. */
type WholeFlaw =
	| "none"
	| "no JSON text"
	| "a list for the manifest"
	| "a member beside files"
	| "files that are no list"

/** How the first entry of a manifest text departs from an entry's shape, or repeats its path. */
type EntryFlaw =
	| "a member beside an entry's three"
	| "an entry without its size"
	| "an empty path"
	| "a sha256 in capitals"
	| "a sha256 a digit short"
	| "a fractional size"
	| "a negative size"
	| "a size written as text"
	| "a repeated path"

const WHOLE_FLAWS = dictionary<WholeFlaw>([
	"none",
	"no JSON text",
	"a list for the manifest",
	"a member beside files",
	"files that are no list"
])

const ENTRY_FLAWS = dictionary<EntryFlaw>([
	"a member beside an entry's three",
	"an entry without its size",
	"an empty path",
	"a sha256 in capitals",
	"a sha256 a digit short",
	"a fractional size",
	"a negative size",
	"a size written as text",
	"a repeated path"
])

/** One generated file: its path in the package and its text, ASCII, so its size in bytes is its length. */
type File = Readonly<{ path: string; content: string }>

/**
 * One case: a manifest whole, its files in the order the writer is handed them, or a manifest whose first entry holds
 * a flaw, that file and the others beside it.
 */
export type ManifestCase =
	| Readonly<{ kind: "whole"; flaw: WholeFlaw; files: ReadonlyArray<File> }>
	| Readonly<{ kind: "entry"; flaw: EntryFlaw; first: File; others: ReadonlyArray<File> }>

const pathGen: Gen<string> = string(characterOf(["a", "b", "/", "."]), { min: 1, max: 3 })

const contentGen: Gen<string> = string(characterOf(["x", "y", "\n"]), { min: 0, max: 3 })

const fileGen =
	(path: string): Gen<File> =>
	(source) => ({ path, content: source.draw(contentGen) })

/** Up to `most` files at distinct paths, `least` of them at least. */
const filesGen = (least: number, most: number): Gen<ReadonlyArray<File>> =>
	uniqueArray(pathGen, fileGen, { min: least, max: most })

const wholeCase =
	(flaw: Gen<WholeFlaw>, least: number): Gen<ManifestCase> =>
	(source) => ({ kind: "whole", flaw: source.draw(flaw), files: source.draw(filesGen(least, 4)) })

const entryCase =
	(flaw: Gen<EntryFlaw>): Gen<ManifestCase> =>
	(source) => {
		const drawn = source.draw(flaw)
		const first = source.draw(fileGen(source.draw(pathGen)))
		return {
			kind: "entry",
			flaw: drawn,
			first,
			others: Arr.filter(source.draw(filesGen(0, 3)), (file) => file.path !== first.path)
		}
	}

export type ManifestFeature = WholeFlaw | EntryFlaw | "several files"

/** The features a case reaches. */
export const manifestFeaturesOf = (c: ManifestCase): ReadonlyArray<ManifestFeature> => [
	c.flaw,
	...(c.kind === "whole" && c.flaw === "none" && c.files.length > 1
		? ["several files" as const]
		: [])
]

/** Manifests of every flaw, aimed at each, and at a clean one of several files. */
export const manifestSpace: Aimed<ManifestCase, ManifestFeature> = aimed(
	oneOf([wholeCase(word(WHOLE_FLAWS), 0), entryCase(word(ENTRY_FLAWS))]),
	[
		...Arr.map(WHOLE_FLAWS, (flaw): readonly [ManifestFeature, Gen<ManifestCase>] => [
			flaw,
			wholeCase(constant(flaw), 0)
		]),
		...Arr.map(ENTRY_FLAWS, (flaw): readonly [ManifestFeature, Gen<ManifestCase>] => [
			flaw,
			entryCase(constant(flaw))
		]),
		["several files", wholeCase(constant("none"), 2)]
	]
)

/** A file's manifest entry, as the writer makes it: its path, its sha256 and its size in bytes. */
const entryOf = (file: File) =>
	Effect.map(sha256Hex(file.content), (sha256): ManifestEntry => ({
		path: file.path,
		sha256,
		size: file.content.length
	}))

/** An entry as the JSON object the manifest writes for it. */
const objectOf = (entry: ManifestEntry): Schema.JsonObject => ({
	path: entry.path,
	sha256: entry.sha256,
	size: entry.size
})

/** The first entry as a flaw spoils it. */
const spoiled = (flaw: EntryFlaw, entry: ManifestEntry): Schema.JsonObject => {
	const { path, sha256, size } = entry
	switch (flaw) {
		case "a member beside an entry's three":
			return { path, sha256, size, mode: 420 }
		case "an entry without its size":
			return { path, sha256 }
		case "an empty path":
			return { path: "", sha256, size }
		case "a sha256 in capitals":
			return { path, sha256: Str.toUpperCase(sha256), size }
		case "a sha256 a digit short":
			return { path, sha256: Str.slice(1)(sha256), size }
		case "a fractional size":
			return { path, sha256, size: size + 0.5 }
		case "a negative size":
			return { path, sha256, size: -1 }
		case "a size written as text":
			return { path, sha256, size: `${size}` }
		case "a repeated path":
			return { path, sha256, size }
	}
}

/** A manifest text whole: the writer's own for `none`, else a JSON text that departs from the shape as the flaw says. */
const wholeText = (flaw: WholeFlaw, entries: ReadonlyArray<ManifestEntry>): string => {
	const objects = Arr.map(entries, objectOf)
	switch (flaw) {
		case "none":
			return printManifest(entries)
		case "no JSON text":
			return Str.slice(0, -2)(printManifest(entries))
		case "a list for the manifest":
			return jsonText(objects)
		case "a member beside files":
			return jsonText({ files: objects, version: 1 })
		case "files that are no list":
			return jsonText({ files: { first: objects } })
	}
}

/** A manifest text whose first entry holds the flaw, and for a repeated path, the first entry again last. */
const entryText = (
	flaw: EntryFlaw,
	first: ManifestEntry,
	others: ReadonlyArray<ManifestEntry>
): string =>
	jsonText({
		files: [
			spoiled(flaw, first),
			...Arr.map(others, objectOf),
			...(flaw === "a repeated path" ? [objectOf(first)] : [])
		]
	})

/** What reading a manifest text comes to: its entries in order, or the refusal's reason and subject. */
type Read = Result.Result<
	ReadonlyArray<ManifestEntry>,
	Readonly<{ reason: string; subject: string }>
>

/**
 * What a case comes to: the manifest the writer prints for its files handed in reverse order, and what a later run reads
 * from the case's text.
 */
export type Outcome = Readonly<{ reversed: string; read: Read }>

const read = (text: string) =>
	decodeManifest(text).pipe(
		Effect.match({
			onFailure: (error): Read => Result.fail({ reason: error.reason, subject: error.subject }),
			onSuccess: (decoded): Read => Result.succeed(decoded)
		})
	)

const byPath = Order.mapInput(Order.String, (entry: ManifestEntry) => entry.path)

const malformed: Read = Result.fail({ reason: "malformed", subject: manifestFileName })

/**
 * Prints and reads the case's manifest, and states what design 3.6 says of it: the manifest lists its entries by path
 * whatever order the writer is handed them in, so their reverse prints the same text; the writer's own text reads back
 * as its entries in path order; a repeated path is refused naming the path; and any text but `{"files": [{path,
 * sha256, size}]}`, with a non-empty path, 64 lowercase hex digits and a whole number of bytes, is refused as malformed,
 * naming the manifest file.
 */
export const outcomesOf = (c: ManifestCase, digest: typeof Digest.Digest.Service) =>
	Effect.gen(function* () {
		if (c.kind === "whole") {
			const entries = yield* Effect.forEach(c.files, entryOf)
			const actual: Outcome = {
				reversed: printManifest(Arr.reverse(entries)),
				read: yield* read(wholeText(c.flaw, entries))
			}
			const expected: Outcome = {
				reversed: printManifest(entries),
				read: c.flaw === "none" ? Result.succeed(Arr.sort(entries, byPath)) : malformed
			}
			return { actual, expected }
		}
		const first = yield* entryOf(c.first)
		const others = yield* Effect.forEach(c.others, entryOf)
		const entries = [first, ...others]
		const actual: Outcome = {
			reversed: printManifest(Arr.reverse(entries)),
			read: yield* read(entryText(c.flaw, first, others))
		}
		const expected: Outcome = {
			reversed: printManifest(entries),
			read:
				c.flaw === "a repeated path"
					? Result.fail({ reason: "duplicate-path", subject: c.first.path })
					: malformed
		}
		return { actual, expected }
	}).pipe(Effect.provideService(Digest.Digest, digest))
