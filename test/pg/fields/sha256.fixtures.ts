/** What the properties of sha256.test.ts read: its spaces, its schema and its helpers. */

import { array, boolean, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, Sha256, sha256 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { btreeMaxItemSize } from "#compiler/schema/representability.ts"
import { succeeded } from "#test/support/assert.ts"
import { fixtureTemplate } from "#test/support/pg/reads/support.ts"

/** A path of any length: text of no byte bound, which no key may hold as itself. */
const Path = str.regex("^.*$", "su")

/**
 * A media file, keyed by `digest`, the SHA-256 of its path's UTF-8 that the host states (Sha256.ofText), the pantry's
 * Media declaration: a key over a digest, which holds a path past any B-tree entry by its 32 bytes.
 */
export const Media = relation("Media", { digest: sha256, path: Path, size: pg.integer }, ["digest"])

export const Digests = schema("Digests", [Media], [])

/**
 * The full world's workload: media written with the facts each call gives, every medium read back, and one found by
 * its digest, a parameter of the sha256 type.
 */
const programs = Object.freeze({
	store: ChangeSet.empty(Digests).insert(Media, []),
	media: query(Digests).rule((r) => {
		const { digest, path, size } = v(Media, "m")
		return r.match(Media, { digest, path, size }).find({ digest, path, size })
	}),
	byDigest: query(Digests).rule((r) => {
		const { digest, path } = v(Media, "m")
		return r
			.match(Media, { digest, path })
			.where(r.eq(digest, r.param("digest", sha256)))
			.find({ path })
	})
})

/** How the module's fixture is installed: its label and the programs its login's workload holds. */
export const digestsInstall = Object.freeze({ label: "sha256", programs })

/** Digests installed as `grizzle generate` drafts it, once per member: the template every case clones. */
export const digestsTemplate = fixtureTemplate(import.meta, Digests, digestsInstall)

/** The characters a path is drawn of, by their UTF-8 width, a quote and a backslash among them. */
const characters = ["a", "Z", "/", ".", "'", "\\", "é", "中", "😀"] as const

/** A path: empty, short, or past a B-tree entry (btreeMaxItemSize), which no index entry holds as itself. */
const pathGen: Gen<string> = weighted([
	[1, () => ""],
	[5, (s) => Arr.join(s.draw(array(element(characters), { min: 1, max: 24 })), "")],
	[2, (s) => Str.repeat(s.draw(int(1, 3)) * btreeMaxItemSize)(s.draw(element(characters)))]
])

/** A drawn case: its distinct paths, each a medium of its own digest, and whether one apply inserts them all. */
export interface Drawn {
	readonly paths: Arr.NonEmptyReadonlyArray<string>
	readonly batched: boolean
}

export const space: Gen<Drawn> = (s) => {
	const first = s.draw(pathGen)
	const more = s.draw(array(pathGen, { min: 0, max: 6 }))
	return {
		paths: [first, ...Arr.filter(Arr.dedupe(more), (p) => p !== first)],
		batched: s.draw(boolean)
	}
}

export type Feature =
	| "the empty path"
	| "a path past a B-tree entry"
	| "many media in one batched insert"
	| "one medium per apply"

export const notes = (d: Drawn): ReadonlyArray<Feature> => [
	...(Arr.some(d.paths, (p) => p === "") ? (["the empty path"] as const) : []),
	...(Arr.some(d.paths, (p) => Buffer.byteLength(p, "utf8") > btreeMaxItemSize)
		? (["a path past a B-tree entry"] as const)
		: []),
	...(d.batched && d.paths.length >= 3 ? (["many media in one batched insert"] as const) : []),
	...(d.batched ? [] : (["one medium per apply"] as const))
]

/** A path's medium: its digest, the SHA-256 of its UTF-8, the path, and a size. */
export const mediumOf = (path: string, at: number) => ({
	digest: succeeded(Sha256.ofText(path), "a drawn path is well-formed text"),
	path,
	size: at
})

/** SHA-256's digest length, which `Sha256.ofBytes` of no bytes states. */
export const digestLength = Sha256.ofBytes(new Uint8Array()).length

/** A wrong length for a digest: any but SHA-256's, shorter or longer, up to twice it. */
export const wrongLength: Gen<number> = (s) => {
	const length = s.draw(int(0, 2 * digestLength))
	return length === digestLength ? length + 1 : length
}

export type LengthFeature = "a shorter value" | "a longer value"
