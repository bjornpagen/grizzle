/** What the properties of document-set.test.ts read: drawn --document pairs, the files behind them, and the set they make. */

import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Cause, Effect, Exit, FileSystem, Option, Path, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { type DocumentPair, makeDocumentSet } from "#load/document-set.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import type { Json } from "#model/pointer.ts"

/** The host part of an absolute retrieval URI, as written: the canonical spelling or one of its other spellings. */
type Spelling = "canonical" | "upper scheme and host" | "a dot segment" | "a fragment"

/** A retrieval URI: absolute, naming a resource (a host and a path) under a spelling, or relative. */
export type DrawnUri =
	| Readonly<{ kind: "absolute"; host: string; name: string; spelling: Spelling }>
	| Readonly<{ kind: "relative"; name: string }>

/** How a pair's file is laid out: a JSON file, a YAML file, a symlink to a JSON file, or nothing at its path. */
export type Layout = "json" | "yaml" | "symlink" | "missing"

/** A drawn pair: its retrieval URI, its file's layout and the directory name its path lies under. */
export type DrawnPair = Readonly<{ uri: DrawnUri; layout: Layout; directory: string }>

/** The entry document's retrieval URI the set is told of, if any. */
export type Entry = Readonly<{ kind: "none" }> | Readonly<{ kind: "named"; uri: DrawnUri }>

/** A --document load: its pairs in order, and the entry. */
export type Pairs = Readonly<{ pairs: ReadonlyArray<DrawnPair>; entry: Entry }>

const HOSTS: Arr.NonEmptyReadonlyArray<string> = ["example.com", "api.example.org"]

const NAMES: Arr.NonEmptyReadonlyArray<string> = [
	"pet.json",
	"a/owner.yaml",
	"a/b/doc.json",
	"doc-0.json"
]

/** Directory names a pair's path lies under, a space, `%`, `#` and a wide character among them. */
const DIRECTORIES: Arr.NonEmptyReadonlyArray<string> = ["plain", "no such dir 100% #1 é"]

const spelling: Gen<Spelling> = weighted([
	[3, constant<Spelling>("canonical")],
	[1, constant<Spelling>("upper scheme and host")],
	[1, constant<Spelling>("a dot segment")],
	[1, constant<Spelling>("a fragment")]
])

/** An absolute retrieval URI. */
type AbsoluteUri = Extract<DrawnUri, { kind: "absolute" }>

const absolute: Gen<AbsoluteUri> = (s) => ({
	kind: "absolute",
	host: s.draw(element(HOSTS)),
	name: s.draw(element(NAMES)),
	spelling: s.draw(spelling)
})

const drawnUri: Gen<DrawnUri> = weighted<DrawnUri>([
	[6, absolute],
	[1, map(element(NAMES), (name): DrawnUri => ({ kind: "relative", name }))]
])

const layout: Gen<Layout> = weighted([
	[3, constant<Layout>("json")],
	[3, constant<Layout>("yaml")],
	[1, constant<Layout>("symlink")],
	[1, constant<Layout>("missing")]
])

const pairOf =
	(uris: Gen<DrawnUri>, layouts: Gen<Layout>): Gen<DrawnPair> =>
	(s) => ({
		uri: s.draw(uris),
		layout: s.draw(layouts),
		directory: s.draw(element(DIRECTORIES))
	})

const entry: Gen<Entry> = weighted([
	[2, constant<Entry>({ kind: "none" })],
	[1, map(absolute, (uri): Entry => ({ kind: "named", uri }))]
])

/** Loads of one to five drawn pairs and an entry. */
const drawnPairs: Gen<Pairs> = (s) => ({
	pairs: s.draw(array(pairOf(drawnUri, layout), { min: 1, max: 5 })),
	entry: s.draw(entry)
})

/** The canonical retrieval URI of a resource. */
const canonicalOf = (host: string, name: string): string => `https://${host}/${name}`

/** A URI's text as the operator writes it. */
const uriText = (uri: DrawnUri): string => {
	if (uri.kind === "relative") {
		return `schemas/${uri.name}`
	}
	switch (uri.spelling) {
		case "canonical":
			return canonicalOf(uri.host, uri.name)
		case "upper scheme and host":
			return `HTTPS://${Str.toUpperCase(uri.host)}/${uri.name}`
		case "a dot segment":
			return `https://${uri.host}/./${uri.name}`
		case "a fragment":
			return `${canonicalOf(uri.host, uri.name)}#part`
	}
}

/** The resource a URI names, the same for every spelling: none for a relative URI. */
const resourceOf = (uri: DrawnUri): Option.Option<string> =>
	uri.kind === "relative" ? Option.none() : Option.some(canonicalOf(uri.host, uri.name))

/** The value a pair's file holds: its place among the pairs, so no two members hold one value. */
const valueOf = (at: number): Json => ({ member: at })

/** A pair's file's text: the value as JSON, or as YAML. */
const textOf = (layoutOf: Layout, at: number): string =>
	layoutOf === "yaml" ? `member: ${at}\n` : `{"member":${at}}`

/** What a set gives: its members in order, or the refusal it ends with. */
export type Made =
	| Readonly<{
			kind: "set"
			members: ReadonlyArray<
				Readonly<{ uri: string; path: string; format: string; value: Json; sha256: string }>
			>
	  }>
	| Readonly<{ kind: "refused"; code: string; scope: string; document: string; hint: string }>

/** A pair as the loader is given it, at its path in the case's directory. */
const pairAt = (path: Path.Path, dir: ScratchDir, pair: DrawnPair, at: number): DocumentPair => ({
	uri: uriText(pair.uri),
	path: path.join(
		dir,
		pair.directory,
		`${at}-${pair.layout}.${pair.layout === "yaml" ? "yaml" : "json"}`
	)
})

/** Lays out each pair's file in the case's directory: a missing one is left absent, a symlink names a JSON file. */
export const laidOut = (dir: ScratchDir, load: Pairs) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* Effect.forEach(
			DIRECTORIES,
			(name) => fs.makeDirectory(path.join(dir, name), { recursive: true }),
			{
				discard: true
			}
		)
		return yield* Effect.forEach(load.pairs, (pair, at) =>
			Effect.gen(function* () {
				const given = pairAt(path, dir, pair, at)
				switch (pair.layout) {
					case "json":
					case "yaml":
						yield* fs.writeFileString(given.path, textOf(pair.layout, at))
						break
					case "symlink": {
						const target = path.join(dir, `${at}-target.json`)
						yield* fs.writeFileString(target, textOf("json", at))
						yield* fs.symlink(target, given.path)
						break
					}
					case "missing":
						break
				}
				return given
			})
		)
	})

/**
 * The set the specification gives: pairs load in order, the first refusal ending the load. A relative URI is refused
 * as relative-uri under the file URL of the pair's path; a URI naming the resource a member already has, or the entry's
 * resource under another spelling, is refused as a duplicate under its own URI; a missing file is refused as unreadable;
 * every refusal is document-scoped and names the pair's path. Every other pair is a member under its URI as written,
 * keeping its path, its format (YAML for the YAML file, JSON otherwise, a symlink read as the JSON file it names) and
 * the sha256 of the bytes it parsed.
 */
export const expectedSet = (load: Pairs, given: ReadonlyArray<DocumentPair>) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const digest = yield* Digest.Digest
		const members: Array<
			Readonly<{ uri: string; path: string; format: string; value: Json; sha256: string }>
		> = []
		const loadedResources: Array<string> = []
		const entryUri = load.entry.kind === "named" ? Option.some(load.entry.uri) : Option.none()
		for (const [at, pair] of load.pairs.entries()) {
			const pairGiven = Arr.getUnsafe(given, at)
			const refused = (code: string, document: string): Made => ({
				kind: "refused",
				code,
				scope: "document",
				document,
				hint: pairGiven.path
			})
			const resource = resourceOf(pair.uri)
			if (Option.isNone(resource)) {
				const url = yield* Effect.orDie(path.toFileUrl(pairGiven.path))
				return refused("REF-16/relative-uri", url.href)
			}
			const entryClash = Option.exists(
				entryUri,
				(named) =>
					uriText(named) !== pairGiven.uri &&
					Option.exists(resourceOf(named), (other) => other === resource.value)
			)
			if (entryClash || Arr.contains(loadedResources, resource.value)) {
				return refused("REF-16/duplicate-uri", pairGiven.uri)
			}
			if (pair.layout === "missing") {
				return refused("DOC-14/unreadable", pairGiven.uri)
			}
			const sha256 = yield* digest.digestHex(
				Digest.sha256,
				new TextEncoder().encode(textOf(pair.layout === "yaml" ? "yaml" : "json", at))
			)
			loadedResources.push(resource.value)
			members.push({
				uri: pairGiven.uri,
				path: pairGiven.path,
				format: pair.layout === "yaml" ? "yaml" : "json",
				value: valueOf(at),
				sha256
			})
		}
		const made: Made = { kind: "set", members }
		return made
	})

/** The set the loader makes of the pairs as given, read in the fields the specification states. */
export const actualSet = (load: Pairs, given: ReadonlyArray<DocumentPair>) =>
	Effect.map(
		Effect.exit(
			makeDocumentSet(
				given,
				load.entry.kind === "named" ? { entry: fixedDocumentUri(uriText(load.entry.uri)) } : {}
			)
		),
		(exit): Made =>
			Exit.match(exit, {
				onSuccess: (set): Made => ({
					kind: "set",
					members: Arr.map(Arr.fromIterable(set.documents.entries()), ([uri, member]) => ({
						uri: String(uri),
						path: member.path,
						format: member.format,
						value: member.value,
						sha256: member.sha256
					}))
				}),
				onFailure: (cause): Made =>
					Option.match(Cause.findErrorOption(cause), {
						onNone: () => ({
							kind: "refused",
							code: "a defect",
							scope: "",
							document: "",
							hint: ""
						}),
						onSome: (refusal) => ({
							kind: "refused",
							code: refusal.diagnostic.code,
							scope: refusal.diagnostic.scope,
							document: String(refusal.diagnostic.document),
							hint: refusal.diagnostic.hint ?? ""
						})
					})
			})
	)

export type PairsFeature =
	| "a JSON member and a YAML member"
	| "a symlinked pair"
	| "a relative URI"
	| "a relative URI under a path with a space, % and #"
	| "an unreadable path"
	| "a repeated retrieval URI"
	| "a resource spelled with upper case"
	| "a resource spelled with a dot segment"
	| "a resource spelled with a fragment"
	| "a pair spelling the entry differently"
	| "the entry among the pairs"
	| "a refusal before a later pair's refusal"
	| "thirty pairs or more"

export const pairsFeatures = (load: Pairs, made: Made): ReadonlyArray<PairsFeature> => {
	const when = (holds: boolean, feature: PairsFeature): ReadonlyArray<PairsFeature> =>
		holds ? [feature] : []
	const loadedLayouts = made.kind === "set" ? Arr.map(made.members, (member) => member.format) : []
	const refusedAt =
		made.kind === "refused"
			? Arr.findFirstIndex(load.pairs, (_, at) => Str.includes(`/${at}-`)(made.hint))
			: Option.none()
	const refusedPair = Option.flatMap(refusedAt, (at) => Arr.get(load.pairs, at))
	const entryResource = load.entry.kind === "named" ? resourceOf(load.entry.uri) : Option.none()
	return [
		...when(
			Arr.contains(loadedLayouts, "json") && Arr.contains(loadedLayouts, "yaml"),
			"a JSON member and a YAML member"
		),
		...when(
			made.kind === "set" && Arr.some(load.pairs, (pair) => pair.layout === "symlink"),
			"a symlinked pair"
		),
		...when(made.kind === "refused" && made.code === "REF-16/relative-uri", "a relative URI"),
		...when(
			made.kind === "refused" &&
				made.code === "REF-16/relative-uri" &&
				Option.exists(refusedPair, (pair) => pair.directory !== "plain"),
			"a relative URI under a path with a space, % and #"
		),
		...when(made.kind === "refused" && made.code === "DOC-14/unreadable", "an unreadable path"),
		...when(
			made.kind === "refused" && made.code === "REF-16/duplicate-uri",
			"a repeated retrieval URI"
		),
		...Arr.flatMap(
			[
				["upper scheme and host", "a resource spelled with upper case"],
				["a dot segment", "a resource spelled with a dot segment"],
				["a fragment", "a resource spelled with a fragment"]
			] as const,
			([spelled, feature]) =>
				when(
					made.kind === "refused" &&
						made.code === "REF-16/duplicate-uri" &&
						Option.exists(
							refusedPair,
							(pair) => pair.uri.kind === "absolute" && pair.uri.spelling === spelled
						),
					feature
				)
		),
		...when(
			made.kind === "refused" &&
				made.code === "REF-16/duplicate-uri" &&
				Option.exists(refusedPair, (pair) =>
					Option.exists(entryResource, (resource) =>
						Option.contains(resourceOf(pair.uri), resource)
					)
				),
			"a pair spelling the entry differently"
		),
		...when(
			made.kind === "set" &&
				load.entry.kind === "named" &&
				Arr.some(
					made.members,
					(member) => load.entry.kind === "named" && member.uri === uriText(load.entry.uri)
				),
			"the entry among the pairs"
		),
		...when(
			Arr.some(
				load.pairs,
				(pair, at) =>
					Option.exists(refusedAt, (refused) => at > refused) &&
					(pair.layout === "missing" || pair.uri.kind === "relative")
			),
			"a refusal before a later pair's refusal"
		),
		...when(made.kind === "set" && made.members.length >= 30, "thirty pairs or more")
	]
}

/** Thirty to forty pairs of distinct resources, every one loading, with or without the entry among them. */
const manyPairs: Gen<Pairs> = (s) => {
	const count = s.draw(int(30, 40))
	const pairs = Array.from({ length: count }, (_, at): DrawnPair => ({
		uri: { kind: "absolute", host: "example.com", name: `doc-${at}.json`, spelling: "canonical" },
		layout: "json",
		directory: "plain"
	}))
	return {
		pairs,
		entry: s.draw(
			oneOf<Entry>([
				constant<Entry>({ kind: "none" }),
				constant<Entry>({
					kind: "named",
					uri: { kind: "absolute", host: "example.com", name: "doc-0.json", spelling: "canonical" }
				}),
				constant<Entry>({
					kind: "named",
					uri: {
						kind: "absolute",
						host: "api.example.org",
						name: "pet.json",
						spelling: "canonical"
					}
				})
			])
		)
	}
}

/** A first pair, then a second naming the same resource under `spelled`. */
const respelled =
	(spelled: Spelling): Gen<Pairs> =>
	(s) => {
		const first = s.draw(
			pairOf(
				map(absolute, (uri): DrawnUri => ({ ...uri, spelling: "canonical" })),
				constant<Layout>("json")
			)
		)
		const again: DrawnUri =
			first.uri.kind === "absolute" ? { ...first.uri, spelling: spelled } : first.uri
		return {
			pairs: [first, { uri: again, layout: "yaml", directory: "plain" }],
			entry: { kind: "none" }
		}
	}

/** Loads of drawn pairs, aimed at each pending situation by a load built to reach it. */
export const pairLoads: Aimed<Pairs, PairsFeature> = aimed(drawnPairs, [
	[
		"a JSON member and a YAML member",
		constant<Pairs>({
			pairs: [
				{
					uri: { kind: "absolute", host: "example.com", name: "pet.json", spelling: "canonical" },
					layout: "json",
					directory: "plain"
				},
				{
					uri: {
						kind: "absolute",
						host: "example.com",
						name: "a/owner.yaml",
						spelling: "canonical"
					},
					layout: "yaml",
					directory: "plain"
				}
			],
			entry: { kind: "none" }
		})
	],
	[
		"a symlinked pair",
		map(pairOf(absolute, constant<Layout>("symlink")), (pair): Pairs => ({
			pairs: [pair],
			entry: { kind: "none" }
		}))
	],
	[
		"a relative URI",
		map(
			pairOf(
				map(element(NAMES), (name): DrawnUri => ({ kind: "relative", name })),
				layout
			),
			(pair): Pairs => ({
				pairs: [pair],
				entry: { kind: "none" }
			})
		)
	],
	[
		"a relative URI under a path with a space, % and #",
		map(element(NAMES), (name): Pairs => ({
			pairs: [
				{ uri: { kind: "relative", name }, layout: "missing", directory: "no such dir 100% #1 é" }
			],
			entry: { kind: "none" }
		}))
	],
	[
		"an unreadable path",
		map(pairOf(absolute, constant<Layout>("missing")), (pair): Pairs => ({
			pairs: [pair],
			entry: { kind: "none" }
		}))
	],
	["a repeated retrieval URI", respelled("canonical")],
	["a resource spelled with upper case", respelled("upper scheme and host")],
	["a resource spelled with a dot segment", respelled("a dot segment")],
	["a resource spelled with a fragment", respelled("a fragment")],
	[
		"a pair spelling the entry differently",
		map(absolute, (uri): Pairs => ({
			pairs: [
				{ uri: { ...uri, spelling: "upper scheme and host" }, layout: "json", directory: "plain" }
			],
			entry: { kind: "named", uri: { ...uri, spelling: "canonical" } }
		}))
	],
	[
		"the entry among the pairs",
		map(absolute, (uri): Pairs => ({
			pairs: [{ uri, layout: "json", directory: "plain" }],
			entry: { kind: "named", uri }
		}))
	],
	[
		"a refusal before a later pair's refusal",
		constant<Pairs>({
			pairs: [
				{ uri: { kind: "relative", name: "a/owner.yaml" }, layout: "yaml", directory: "plain" },
				{
					uri: { kind: "absolute", host: "example.com", name: "pet.json", spelling: "canonical" },
					layout: "missing",
					directory: "plain"
				}
			],
			entry: { kind: "none" }
		})
	],
	["thirty pairs or more", manyPairs]
])
