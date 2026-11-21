/** What the properties of ref-root.test.ts read: drawn reference-root trees, one hazard planted in each, and the set they load as. */

import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { type Aimed, aimed } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Ref,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { setMembers } from "#generate.ts"
import { type DocumentPair, makeDocumentSet, resolveUnderRoot } from "#load/document-set.ts"
import { fixedDocumentUri } from "#model/brands.ts"
import { finished } from "#test/support/process.ts"

/** A spec file of the base tree: the directories it lies under, below the root, and its name. */
export type SpecFile = Readonly<{ dirs: ReadonlyArray<string>; name: string }>

/** What a tree holds beside its spec files: one hazard, planted under names that sort after every base entry. */
export type Hazard =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "a link to a member" }>
	| Readonly<{ kind: "a directory link inside the root" }>
	| Readonly<{ kind: "a spec-named link to an outside file" }>
	| Readonly<{ kind: "a spec-named link to an outside directory" }>
	| Readonly<{ kind: "a directory link to outside, not spec-named" }>
	| Readonly<{ kind: "skipped entries: dangling, escaping and special" }>
	| Readonly<{ kind: "a spec-named FIFO" }>
	| Readonly<{ kind: "directory links closing a cycle" }>
	| Readonly<{ kind: "a spec file deep below the root"; depth: number }>
	| Readonly<{ kind: "pairs beside the root"; count: number; entry: boolean }>
	| Readonly<{ kind: "a pair under a member's URI"; spelled: boolean }>
	| Readonly<{ kind: "a member swapped for an outside link at its open" }>
	| Readonly<{ kind: "a parent swapped for an outside link at its member's open" }>
	| Readonly<{ kind: "a parent swapped out and back around its member's open" }>
	| Readonly<{ kind: "a ../ path" }>

/** A tree: its spec files (always a.json at the root and sub/b.yaml, then drawn ones), and its one hazard. */
export type Tree = Readonly<{ files: ReadonlyArray<SpecFile>; hazard: Hazard }>

const NAMES: Arr.NonEmptyReadonlyArray<string> = ["c.json", "d.yaml", "e.yml", "F.JSON", "g.YAML"]

const DIRS: Arr.NonEmptyReadonlyArray<string> = ["sub", "x", "y"]

/** The two files every tree holds, which the swap hazards and the links aim at. */
const BASE: ReadonlyArray<SpecFile> = [
	{ dirs: [], name: "a.json" },
	{ dirs: ["sub"], name: "b.yaml" }
]

const specFile: Gen<SpecFile> = (s) => ({
	dirs: s.draw(array(element(DIRS), { min: 0, max: 2 })),
	name: s.draw(element(NAMES))
})

const keyOf = (file: SpecFile): string => Arr.join([...file.dirs, file.name], "/")

const filesGen: Gen<ReadonlyArray<SpecFile>> = map(
	uniqueArray(map(specFile, keyOf), (key) => constant(key), { min: 0, max: 4 }),
	(keys) =>
		Arr.dedupeWith(
			[
				...BASE,
				...Arr.map(keys, (key): SpecFile => {
					const parts = Str.split("/")(key)
					return { dirs: Arr.dropRight(parts, 1), name: Arr.lastNonEmpty(parts) }
				})
			],
			(left, right) => keyOf(left) === keyOf(right)
		)
)

const HAZARDS: Arr.NonEmptyReadonlyArray<Hazard["kind"]> = [
	"none",
	"a link to a member",
	"a directory link inside the root",
	"a spec-named link to an outside file",
	"a spec-named link to an outside directory",
	"a directory link to outside, not spec-named",
	"skipped entries: dangling, escaping and special",
	"a spec-named FIFO",
	"directory links closing a cycle",
	"a spec file deep below the root",
	"pairs beside the root",
	"a pair under a member's URI",
	"a member swapped for an outside link at its open",
	"a parent swapped for an outside link at its member's open",
	"a parent swapped out and back around its member's open",
	"a ../ path"
]

const hazardOf = (kind: Hazard["kind"]): Gen<Hazard> => {
	switch (kind) {
		case "a spec file deep below the root":
			return map(int(1, 40), (depth): Hazard => ({ kind, depth }))
		case "pairs beside the root":
			return (s) => ({
				kind,
				count: s.draw(int(1, 40)),
				entry: s.draw(
					weighted([
						[1, constant(true)],
						[1, constant(false)]
					])
				)
			})
		case "a pair under a member's URI":
			return map(
				weighted([
					[1, constant(true)],
					[1, constant(false)]
				]),
				(spelled): Hazard => ({ kind, spelled })
			)
		case "none":
		case "a link to a member":
		case "a directory link inside the root":
		case "a spec-named link to an outside file":
		case "a spec-named link to an outside directory":
		case "a directory link to outside, not spec-named":
		case "skipped entries: dangling, escaping and special":
		case "a spec-named FIFO":
		case "directory links closing a cycle":
		case "a member swapped for an outside link at its open":
		case "a parent swapped for an outside link at its member's open":
		case "a parent swapped out and back around its member's open":
		case "a ../ path":
			return constant<Hazard>({ kind })
	}
}

const treeOf =
	(hazards: Gen<Hazard>): Gen<Tree> =>
	(s) => ({ files: s.draw(filesGen), hazard: s.draw(hazards) })

/** Trees of drawn spec files with one drawn hazard, aimed at each hazard while its situation is pending. */
export const trees: Aimed<Tree, Hazard["kind"]> = aimed(
	treeOf((s) => s.draw(hazardOf(s.draw(element(HAZARDS))))),
	Arr.map(HAZARDS, (kind) => [kind, treeOf(hazardOf(kind))] as const)
)

/** The relative path of a spec file. */
const relativeOf = (file: SpecFile): ReadonlyArray<string> => [...file.dirs, file.name]

/** Segment lists in the walk's order: by first segment (names compared as strings), then the next. */
const walkOrder: Order.Order<ReadonlyArray<string>> = Order.make((left, right) => {
	for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
		const order = Order.String(Arr.getUnsafe(left, at), Arr.getUnsafe(right, at))
		if (order !== 0) {
			return order
		}
	}
	return Order.Number(left.length, right.length)
})

/** A spec file's text: its relative path as the value of one key, as JSON or as YAML by its extension. */
const textOf = (relative: ReadonlyArray<string>): string => {
	const at = Arr.join(relative, "/")
	return Str.endsWith(".json")(Str.toLowerCase(at))
		? `{"at":${Formatter.formatJson(at)}}`
		: `at: "${at}"\n`
}

/** A path of `segments` below `root`. */
const joined = (path: Path.Path, root: string, segments: ReadonlyArray<string>): string =>
	Arr.reduce(segments, root, (at, segment) => path.join(at, segment))

/** The directories a spec file `depth` levels below the root lies under. */
const deepDirs = (depth: number): ReadonlyArray<string> =>
	Array.from({ length: depth }, (_, level) => `zz${level}`)

/** Where a tree lies: its root, the sibling outside it, and the root's real path. */
export type Place = Readonly<{ root: string; outside: string; realRoot: string }>

/** Lays out the tree: the base and drawn files under `root`, an outside file and directory beside it, the hazard. */
export const laidOut = (dir: ScratchDir, tree: Tree) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = path.join(dir, "root")
		const outside = path.join(dir, "outside")
		yield* fs.makeDirectory(path.join(outside, "dir"), { recursive: true })
		yield* fs.writeFileString(path.join(outside, "secret.json"), '{"secret":true}')
		yield* fs.makeDirectory(path.join(outside, "evil", "sub"), { recursive: true })
		yield* fs.writeFileString(path.join(outside, "evil", "sub", "b.yaml"), "Secret: TOPSECRET\n")
		yield* Effect.forEach(
			tree.files,
			(file) =>
				Effect.gen(function* () {
					yield* fs.makeDirectory(joined(path, root, file.dirs), { recursive: true })
					yield* fs.writeFileString(joined(path, root, relativeOf(file)), textOf(relativeOf(file)))
				}),
			{ discard: true }
		)
		yield* fs.writeFileString(path.join(root, "notes.txt"), "not a spec\n")
		const fifo = (at: string) => Effect.asVoid(finished(ChildProcess.make("mkfifo", [at])))
		const hazard = tree.hazard
		switch (hazard.kind) {
			case "a link to a member":
				yield* fs.symlink(path.join(root, "a.json"), path.join(root, "zz-alias.json"))
				break
			case "a directory link inside the root":
				yield* fs.symlink(path.join(root, "sub"), path.join(root, "zzsubs"))
				break
			case "a spec-named link to an outside file":
				yield* fs.symlink(path.join(outside, "secret.json"), path.join(root, "zz-escape.json"))
				break
			case "a spec-named link to an outside directory":
				yield* fs.symlink(path.join(outside, "dir"), path.join(root, "zz-linked.json"))
				break
			case "a directory link to outside, not spec-named":
				yield* fs.symlink(path.join(outside, "dir"), path.join(root, "zz_modules"))
				break
			case "skipped entries: dangling, escaping and special":
				yield* fs.symlink(path.join(root, "missing"), path.join(root, "zz-dangling"))
				yield* fs.symlink(path.join(outside, "secret.json"), path.join(root, "zz-escape.txt"))
				yield* fifo(path.join(root, "zz-pipe"))
				break
			case "a spec-named FIFO":
				yield* fifo(path.join(root, "zz-pipe.json"))
				break
			case "directory links closing a cycle":
				yield* fs.symlink(root, path.join(root, "sub", "zz-up"))
				yield* fs.symlink(path.join(root, "sub"), path.join(root, "sub", "zz-self"))
				break
			case "a spec file deep below the root": {
				const deep = joined(path, root, deepDirs(hazard.depth))
				yield* fs.makeDirectory(deep, { recursive: true })
				yield* fs.writeFileString(path.join(deep, "deep.json"), "{}")
				break
			}
			case "none":
			case "pairs beside the root":
			case "a pair under a member's URI":
			case "a member swapped for an outside link at its open":
			case "a parent swapped for an outside link at its member's open":
			case "a parent swapped out and back around its member's open":
			case "a ../ path":
				break
		}
		const realRoot = yield* fs.realPath(root)
		const place: Place = { root, outside, realRoot }
		return place
	})

/** What a load gives: the set's retrieval URIs in order, or the refusal it ends with. */
export type Loaded =
	| Readonly<{ kind: "set"; uris: ReadonlyArray<string> }>
	| Readonly<{ kind: "refused"; code: string; scope: string; hint: Option.Option<string> }>

/** The file URL of a path. */
const urlOf = (path: Path.Path, at: string) =>
	Effect.map(Effect.orDie(path.toFileUrl(at)), (url) => url.href)

/** The pairs a tree's hazard loads beside its root: files outside the root under their own retrieval URIs. */
const pairsOf = (place: Place, tree: Tree) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const hazard = tree.hazard
		switch (hazard.kind) {
			case "pairs beside the root":
				return Array.from({ length: hazard.count }, (_, at): DocumentPair => ({
					path: path.join(place.outside, "secret.json"),
					uri: `https://example.com/doc-${at}.json`
				}))
			case "a pair under a member's URI": {
				const uri = yield* urlOf(path, path.join(place.realRoot, "a.json"))
				return [
					{
						path: path.join(place.outside, "secret.json"),
						uri: hazard.spelled ? Str.replace(fileScheme, "FILE:")(uri) : uri
					}
				]
			}
			case "none":
			case "a link to a member":
			case "a directory link inside the root":
			case "a spec-named link to an outside file":
			case "a spec-named link to an outside directory":
			case "a directory link to outside, not spec-named":
			case "skipped entries: dangling, escaping and special":
			case "a spec-named FIFO":
			case "directory links closing a cycle":
			case "a spec file deep below the root":
			case "a member swapped for an outside link at its open":
			case "a parent swapped for an outside link at its member's open":
			case "a parent swapped out and back around its member's open":
			case "a ../ path":
				return []
		}
	})

/**
 * What the specification gives a tree: the pairs first, then every spec-named file under the root once, by its real
 * path's file URL, in the walk's order (names sorted at each level), links inside the root read as their targets and
 * entered once, a cycle ending where it closes, anything not spec-named that is no directory inside the root skipped;
 * an entry inside the root is that member, never a second one. A spec-named link out of the root is refused as
 * outside-root at its own path; a spec-named FIFO as unreadable-root at its path; a pair under a member's URI (spelled
 * alike or not) as a duplicate naming the member's real path; a member swapped for an outside link at its open as
 * unreadable, a parent swapped out at its member's open, or swapped back after it, as outside-root; a ../ path as
 * outside-root.
 */
export const expectedOf = (place: Place, tree: Tree) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const members = [
			...Arr.map(tree.files, relativeOf),
			...(tree.hazard.kind === "a spec file deep below the root"
				? [Arr.append(deepDirs(tree.hazard.depth), "deep.json")]
				: [])
		]
		const rootUris = yield* Effect.forEach(Arr.sort(members, walkOrder), (relative) =>
			urlOf(path, joined(path, place.realRoot, relative))
		)
		const pairs = yield* pairsOf(place, tree)
		const set = (uris: ReadonlyArray<string>): Loaded => ({ kind: "set", uris })
		const refused = (code: string, hint: Option.Option<string>): Loaded => ({
			kind: "refused",
			code,
			scope: "document",
			hint
		})
		const hazard = tree.hazard
		switch (hazard.kind) {
			case "none":
			case "a link to a member":
			case "a directory link inside the root":
			case "a directory link to outside, not spec-named":
			case "skipped entries: dangling, escaping and special":
			case "directory links closing a cycle":
			case "a spec file deep below the root":
				return set(rootUris)
			case "pairs beside the root":
				return set([...Arr.map(pairs, (pair) => pair.uri), ...rootUris])
			case "a spec-named link to an outside file":
				return refused(
					"REF-16/outside-root",
					Option.some(path.join(place.realRoot, "zz-escape.json"))
				)
			case "a spec-named link to an outside directory":
				return refused(
					"REF-16/outside-root",
					Option.some(path.join(place.realRoot, "zz-linked.json"))
				)
			case "a spec-named FIFO":
				return refused(
					"REF-16/unreadable-root",
					Option.some(path.join(place.realRoot, "zz-pipe.json"))
				)
			case "a pair under a member's URI":
				return refused("REF-16/duplicate-uri", Option.some(path.join(place.realRoot, "a.json")))
			case "a member swapped for an outside link at its open":
				return refused("DOC-14/unreadable", Option.none())
			case "a parent swapped for an outside link at its member's open":
			case "a parent swapped out and back around its member's open":
			case "a ../ path":
				return refused("REF-16/outside-root", Option.none())
		}
	})

/**
 * The file system the load runs on: the real one, or for a swap hazard one whose first open of the swapped member
 * swaps a path for a link out of the root first (and, for a swap back, restores it once the open has returned).
 */
const swapping = (place: Place, tree: Tree) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const fired = yield* Ref.make(false)
		const sub = path.join(place.realRoot, "sub")
		const held = path.join(place.outside, "held")
		const swap = (
			target: string,
			before: Effect.Effect<void>,
			after: Effect.Effect<void>
		): FileSystem.FileSystem => ({
			...fs,
			open: (file, options) =>
				Effect.gen(function* () {
					const first = file === target && !(yield* Ref.getAndSet(fired, true))
					if (first) {
						yield* before
					}
					const opened = yield* fs.open(file, options)
					if (first) {
						yield* after
					}
					return opened
				})
		})
		const hazard = tree.hazard
		switch (hazard.kind) {
			case "a member swapped for an outside link at its open": {
				const target = path.join(place.realRoot, "a.json")
				return swap(
					target,
					Effect.orDie(
						Effect.andThen(
							fs.remove(target),
							fs.symlink(path.join(place.outside, "secret.json"), target)
						)
					),
					Effect.void
				)
			}
			case "a parent swapped for an outside link at its member's open":
				return swap(
					path.join(sub, "b.yaml"),
					Effect.orDie(
						Effect.andThen(
							fs.rename(sub, held),
							fs.symlink(path.join(place.outside, "evil", "sub"), sub)
						)
					),
					Effect.void
				)
			case "a parent swapped out and back around its member's open":
				return swap(
					path.join(sub, "b.yaml"),
					Effect.orDie(
						Effect.andThen(
							fs.rename(sub, held),
							fs.symlink(path.join(place.outside, "evil", "sub"), sub)
						)
					),
					Effect.orDie(Effect.andThen(fs.remove(sub), fs.rename(held, sub)))
				)
			case "none":
			case "a link to a member":
			case "a directory link inside the root":
			case "a spec-named link to an outside file":
			case "a spec-named link to an outside directory":
			case "a directory link to outside, not spec-named":
			case "skipped entries: dangling, escaping and special":
			case "a spec-named FIFO":
			case "directory links closing a cycle":
			case "a spec file deep below the root":
			case "pairs beside the root":
			case "a pair under a member's URI":
			case "a ../ path":
				return fs
		}
	})

/** What the loader gives the tree: the set it makes (or resolveUnderRoot's answer for a ../ path), or its refusal. */
export const actualOf = (place: Place, tree: Tree) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const pairs = yield* pairsOf(place, tree)
		const fileSystem = yield* swapping(place, tree)
		const entryUri = yield* urlOf(path, path.join(place.realRoot, "a.json"))
		const entry =
			tree.hazard.kind === "pairs beside the root" && tree.hazard.entry
				? { entry: fixedDocumentUri(entryUri) }
				: {}
		const exit = yield* Effect.exit(
			tree.hazard.kind === "a ../ path"
				? Effect.as(resolveUnderRoot(place.root, "../outside/secret.json"), [])
				: Effect.map(makeDocumentSet(pairs, { ...entry, refRoot: place.root }), (made) =>
						Arr.map(Arr.fromIterable(made.documents.keys()), String)
					)
		).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
		return Exit.match(exit, {
			onSuccess: (uris): Loaded => ({ kind: "set", uris }),
			onFailure: (cause): Loaded =>
				Option.match(Cause.findErrorOption(cause), {
					onNone: () => ({ kind: "refused", code: "a defect", scope: "", hint: Option.none() }),
					onSome: (refusal) => ({
						kind: "refused",
						code: refusal.diagnostic.code,
						scope: refusal.diagnostic.scope,
						hint: Option.fromNullishOr(refusal.diagnostic.hint)
					})
				})
		})
	})

/** The expectation read in the fields the refusal's hazard fixes: a swap's hint is the loader's to choose. */
export const comparable = (expected: Loaded, actual: Loaded): Loaded =>
	expected.kind === "refused" && actual.kind === "refused" && Option.isNone(expected.hint)
		? { ...actual, hint: Option.none() }
		: actual

/** The scheme of a file URL, which a respelling writes in upper case. */
const fileScheme = regex("^file:", "u")

/** The entry's file name at the end of its URL, which a respelling writes after a dot segment. */
const entryName = regex("a\\.json$", "u")

/**
 * A member checked against the entry: its retrieval URI (the entry's exactly, the entry's after a dot segment, the
 * entry's with its scheme in upper case, or another), and its file (the entry's own, or another).
 */
export type EntryCase = Readonly<{
	uri: "exact" | "a dot segment" | "upper scheme" | "another URI"
	file: "the entry's" | "another"
}>

const drawnEntryCases: Gen<EntryCase> = (s) => ({
	uri: s.draw(element<EntryCase["uri"]>(["exact", "a dot segment", "upper scheme", "another URI"])),
	file: s.draw(element<EntryCase["file"]>(["the entry's", "another"]))
})

/** The situation an entry case is, by its two choices. */
const featureOf = (entryCase: EntryCase): EntryFeature =>
	`${entryCase.uri} over ${entryCase.file} file`

/** The entry cases each situation names, as the arm that reaches it. */
const caseOf = (uri: EntryCase["uri"], file: EntryCase["file"]) =>
	[featureOf({ uri, file }), constant<EntryCase>({ uri, file })] as const

/** Members drawn against the entry, aimed at each pending situation by its own case. */
export const entryCases: Aimed<EntryCase, EntryFeature> = aimed(drawnEntryCases, [
	caseOf("exact", "the entry's"),
	caseOf("exact", "another"),
	caseOf("a dot segment", "the entry's"),
	caseOf("upper scheme", "another"),
	caseOf("another URI", "another")
])

/**
 * What setMembers gives a member against the entry, as the specification says: the entry's own file under its exact URI
 * is the entry and no member; any other file under that URI, or any spelling of it, is refused as a duplicate naming
 * the member's path; another URI is a member.
 */
export const membersOf = (dir: ScratchDir, entryCase: EntryCase) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const entryPath = path.join(dir, "a.json")
		const otherPath = path.join(dir, "other.json")
		yield* fs.writeFileString(entryPath, '{"openapi":"3.1.0"}')
		yield* fs.writeFileString(otherPath, '{"other":true}')
		const entryUri = yield* urlOf(path, entryPath)
		const memberPath = entryCase.file === "the entry's" ? entryPath : otherPath
		const uri = ((): string => {
			switch (entryCase.uri) {
				case "exact":
					return entryUri
				case "a dot segment":
					return Str.replace(entryName, "./a.json")(entryUri)
				case "upper scheme":
					return Str.replace(fileScheme, "FILE:")(entryUri)
				case "another URI":
					return "https://example.com/other.json"
			}
		})()
		const exit = yield* Effect.exit(
			Effect.flatMap(makeDocumentSet([{ path: memberPath, uri }], {}), (set) =>
				setMembers(
					{ document: fixedDocumentUri(entryUri), source: { _tag: "File", path: entryPath } },
					set
				)
			)
		)
		const expected =
			entryCase.uri === "another URI"
				? { kind: "members", documents: [uri] }
				: entryCase.uri === "exact" && entryCase.file === "the entry's"
					? { kind: "members", documents: [] }
					: { kind: "refused", code: "REF-16/duplicate-uri", hint: memberPath }
		const actual = Exit.match(exit, {
			onSuccess: (found) => ({
				kind: "members",
				documents: Arr.map(found, (member) => String(member.document))
			}),
			onFailure: (cause) =>
				Option.match(Cause.findErrorOption(cause), {
					onNone: () => ({ kind: "refused", code: "a defect", hint: "" }),
					onSome: (refusal) => ({
						kind: "refused",
						code: refusal.diagnostic.code,
						hint: refusal.diagnostic.hint ?? ""
					})
				})
		})
		return { expected, actual }
	})

export type EntryFeature = `${EntryCase["uri"]} over ${EntryCase["file"]} file`

export const entryFeatures = (entryCase: EntryCase): ReadonlyArray<EntryFeature> => [
	featureOf(entryCase)
]
