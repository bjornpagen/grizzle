import { regex } from "arkregex"
import { Array as Arr, Data, Effect, FileSystem, Option, Path, Result, String as Str } from "effect"
import type { Digest } from "effect/crypto"
import { HttpClient, HttpClientResponse } from "effect/http"
import { isSha256Hex, sha256Hex } from "#model/digest.ts"
import type { Sha256Hex } from "#model/digest.ts"
import { parseJson } from "#runtime/json.ts"
import type { InvalidJsonText } from "#runtime/json.ts"
import {
	array,
	check,
	integer,
	literal,
	member,
	members,
	optionalMember,
	refine,
	string,
	struct,
	union
} from "#runtime/read.ts"
import type { Reader, ReadIssues } from "#runtime/read.ts"

/** A specification's twin: the same document in the other format, by its sha256 and source URL. */
interface Twin {
	readonly sha256: Sha256Hex
	readonly sourceUrl: string
}

/**
 * A specification a public source publishes, fetched by its pin (design 8.2): `pinnedRef` is
 * `owner/repo@<commit>`, or `unpinned` for a source that cannot be pinned (such sources stay in the
 * `extended` tier), and `twin` is the same document in the other format, where one is pinned.
 */
interface Fetched {
	readonly kind: "fetched"
	readonly pinnedRef: string
	readonly sourceUrl: string
	readonly twin: Option.Option<Twin>
}

/**
 * How a committed specification was written: `tool` and `input` are the tool's and the input's
 * commits, each `owner/repo@<40 hex digits>`, `command` runs in `directory` of the input and writes
 * `output` there (both relative to the input's root), and `changes` are the edits made to either
 * beyond those commits, in plain words, none when the commits alone wrote it.
 */
interface ProducedBy {
	readonly changes: readonly string[]
	readonly command: string
	readonly directory: string
	readonly input: string
	readonly output: string
	readonly tool: string
}

/**
 * A specification no public source publishes, because a tool writes it from another repository's
 * code: its bytes are committed at `path`, under the corpus root, and `producedBy` says how they
 * were written.
 */
interface Committed {
	readonly kind: "committed"
	readonly path: string
	readonly producedBy: ProducedBy
}

/** The formats a specification is written in. */
const formats = ["json", "yaml"] as const

/** The corpus tiers (design 8.2): the run takes `ci` entries; a source without a license or a stable pin is `extended`. */
const tiers = ["ci", "extended"] as const

/** One specification of the corpus (design 8.2): its bytes' size, format, sha256 and source. */
export interface CorpusEntry {
	readonly bytes: number
	readonly format: (typeof formats)[number]
	readonly id: string
	readonly infoLicense: Option.Option<string>
	readonly license: string
	readonly licenseSha256: Option.Option<Sha256Hex>
	readonly sha256: Sha256Hex
	readonly source: Committed | Fetched
	readonly tier: (typeof tiers)[number]
}

/**
 * The corpus manifest: a version and one entry per pinned spec.
 */
interface Corpus {
	readonly specs: readonly CorpusEntry[]
	readonly version: 1
}

/** A string with at least one character. */
const nonEmptyReader: Reader<string> = check(string, Str.isNonEmpty, "a non-empty string")

const sha256Reader: Reader<Sha256Hex> = refine(
	string,
	isSha256Hex,
	"64 lowercase hexadecimal digits"
)

const commitPattern = regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}$", "u")

/** A repository at one commit: `owner/repo@<40 hex digits>`. */
const commitReader: Reader<string> = check(
	string,
	(text) => commitPattern.test(text),
	"a repository at one commit, owner/repo@<40 hex digits>"
)

const twinReader: Reader<Twin> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				sha256: member(object, "sha256", sha256Reader),
				sourceUrl: member(object, "sourceUrl", nonEmptyReader)
			},
			false
		)
	)

const fetchedReader: Reader<Fetched> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				kind: member(object, "kind", literal("fetched")),
				pinnedRef: member(object, "pinnedRef", nonEmptyReader),
				sourceUrl: member(object, "sourceUrl", nonEmptyReader),
				twin: optionalMember(object, "twin", twinReader)
			},
			false
		)
	)

const producedByReader: Reader<ProducedBy> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				changes: member(object, "changes", array(nonEmptyReader)),
				command: member(object, "command", nonEmptyReader),
				directory: member(object, "directory", string),
				input: member(object, "input", commitReader),
				output: member(object, "output", nonEmptyReader),
				tool: member(object, "tool", commitReader)
			},
			false
		)
	)

const committedReader: Reader<Committed> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				kind: member(object, "kind", literal("committed")),
				path: member(object, "path", nonEmptyReader),
				producedBy: member(object, "producedBy", producedByReader)
			},
			false
		)
	)

const corpusEntryReader: Reader<CorpusEntry> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				bytes: member(object, "bytes", integer),
				format: member(object, "format", union(Arr.map(formats, literal))),
				id: member(object, "id", nonEmptyReader),
				infoLicense: optionalMember(object, "infoLicense", nonEmptyReader),
				license: member(object, "license", nonEmptyReader),
				licenseSha256: optionalMember(object, "licenseSha256", sha256Reader),
				sha256: member(object, "sha256", sha256Reader),
				source: member(object, "source", union([fetchedReader, committedReader])),
				tier: member(object, "tier", union(Arr.map(tiers, literal)))
			},
			false
		)
	)

const corpusReader: Reader<Corpus> = (value) =>
	Result.flatMap(members(value), (object) =>
		struct(
			object,
			{
				specs: member(object, "specs", array(corpusEntryReader)),
				version: member(object, "version", literal(1))
			},
			false
		)
	)

/** The corpus manifest's text is no JSON text, or its value is no manifest: `cause` says which, and where. */
export class CorpusManifestUnreadable extends Data.TaggedError("CorpusManifestUnreadable")<{
	readonly cause: InvalidJsonText | ReadIssues
}> {}

/** The corpus manifest read from its text, `corpus/corpus.json`'s. */
export const readCorpus = (text: string): Result.Result<Corpus, CorpusManifestUnreadable> =>
	Result.mapError(
		Result.flatMap(parseJson(text), corpusReader),
		(cause) => new CorpusManifestUnreadable({ cause })
	)

/** A spec's bytes, fetched or committed, hash to another sha256 than its entry's. */
export class CorpusHashMismatch extends Data.TaggedError("CorpusHashMismatch")<{
	readonly actual: string
	readonly expected: string
	readonly source: string
}> {}

/** A source URL off the one allowed scheme, host, port and credential, refused before any request. */
export class CorpusSourceRefused extends Data.TaggedError("CorpusSourceRefused")<{
	readonly sourceUrl: string
}> {}

/** The request for a pinned source failed or answered other than 2xx. */
export class CorpusFetchFailed extends Data.TaggedError("CorpusFetchFailed")<{
	readonly cause: unknown
	readonly sourceUrl: string
}> {}

/** The cache directory or a cached file could not be read or written. */
export class CorpusCacheFailed extends Data.TaggedError("CorpusCacheFailed")<{
	readonly cause: unknown
	readonly path: string
}> {}

export interface Pin {
	readonly sha256: Sha256Hex
	readonly sourceUrl: string
}

export type SourceError = CorpusFetchFailed | CorpusSourceRefused

export type Source<R> = (sourceUrl: string) => Effect.Effect<Uint8Array, SourceError, R>

const allowedHost = "raw.githubusercontent.com"

const isAllowed = (sourceUrl: string): boolean => {
	if (!URL.canParse(sourceUrl)) {
		return false
	}

	const url = new URL(sourceUrl)

	return (
		url.protocol === "https:" &&
		url.hostname === allowedHost &&
		url.port === "" &&
		url.username === "" &&
		url.password === ""
	)
}

/**
 * Reads a commit-pinned file from unauthenticated `raw.githubusercontent.com`; any other scheme,
 * host, port or credential is refused before a request is made.
 */
export const githubSource: Source<HttpClient.HttpClient> = (sourceUrl) =>
	isAllowed(sourceUrl)
		? HttpClient.get(sourceUrl).pipe(
				Effect.flatMap(HttpClientResponse.filterStatusOk),
				Effect.flatMap((response) => response.arrayBuffer),
				Effect.mapBoth({
					onFailure: (cause) => new CorpusFetchFailed({ cause, sourceUrl }),
					onSuccess: (buffer) => new Uint8Array(buffer)
				})
			)
		: Effect.fail(new CorpusSourceRefused({ sourceUrl }))

/**
 * Returns the cache path `<cacheDir>/<sha256>` for the pinned bytes. A cached file is used only
 * when it still hashes to the pin; otherwise the bytes come from `source`, are verified before
 * anything is written, and land through a temporary file and a rename.
 */
export const fetchPinned = <R>(
	pin: Pin,
	cacheDir: string,
	source: Source<R>
): Effect.Effect<
	string,
	CorpusCacheFailed | CorpusHashMismatch | SourceError,
	FileSystem.FileSystem | Path.Path | Digest.Digest | R
> =>
	Effect.gen(function* fetch() {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const target = path.join(cacheDir, pin.sha256)
		const cacheFailed = (cause: unknown) => new CorpusCacheFailed({ cause, path: target })
		const present = yield* fs.exists(target).pipe(Effect.mapError(cacheFailed))

		if (present) {
			const cached = yield* fs.readFile(target).pipe(Effect.mapError(cacheFailed))

			const cachedSha256 = yield* sha256Hex(cached)

			if (cachedSha256 === pin.sha256) {
				return target
			}
		}

		const bytes = yield* source(pin.sourceUrl)
		const actual = yield* sha256Hex(bytes)

		if (actual !== pin.sha256) {
			return yield* new CorpusHashMismatch({
				actual,
				expected: pin.sha256,
				source: pin.sourceUrl
			})
		}

		yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(Effect.mapError(cacheFailed))

		const partial = yield* fs
			.makeTempFile({ directory: cacheDir, prefix: ".fetch-", suffix: ".partial" })
			.pipe(Effect.mapError(cacheFailed))

		yield* fs.writeFile(partial, bytes).pipe(
			Effect.andThen(fs.rename(partial, target)),
			Effect.tapError(() => Effect.ignore(fs.remove(partial, { force: true }))),
			Effect.mapError(cacheFailed)
		)

		return target
	})

/** Where an entry's bytes are on disk, and the URI its diagnostics name the document by. */
export interface Located {
	readonly document: string
	readonly path: string
}

/**
 * A committed entry's file under the corpus root, named `file:///<path>` as an author config is,
 * used only when its bytes hash to the entry's sha256.
 */
const committedAt = (sha256: Sha256Hex, path: string, root: string) =>
	Effect.gen(function* committed() {
		const fs = yield* FileSystem.FileSystem
		const paths = yield* Path.Path
		const target = paths.join(root, path)
		const bytes = yield* fs
			.readFile(target)
			.pipe(Effect.mapError((cause) => new CorpusCacheFailed({ cause, path: target })))
		const actual = yield* sha256Hex(bytes)
		if (actual !== sha256) {
			return yield* new CorpusHashMismatch({ actual, expected: sha256, source: path })
		}

		const found: Located = { document: `file:///${path}`, path: target }

		return found
	})

/**
 * An entry's bytes, by its source: a fetched entry's through the pinned cache (`fetchPinned`),
 * named by its source URL, or a committed entry's under the corpus root `root`.
 */
export const locate = <R>(
	entry: CorpusEntry,
	root: string,
	cacheDir: string,
	source: Source<R>
): Effect.Effect<
	Located,
	CorpusCacheFailed | CorpusHashMismatch | SourceError,
	FileSystem.FileSystem | Path.Path | Digest.Digest | R
> => {
	const from = entry.source

	return from.kind === "fetched"
		? Effect.map(
				fetchPinned({ sha256: entry.sha256, sourceUrl: from.sourceUrl }, cacheDir, source),
				(path): Located => ({ document: from.sourceUrl, path })
			)
		: committedAt(entry.sha256, from.path, root)
}
