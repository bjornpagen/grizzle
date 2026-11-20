import { regex } from "arkregex"
import { Effect, FileSystem, Path, Schema } from "effect"
import type { Digest } from "effect/crypto"
import { HttpClient, HttpClientResponse } from "effect/http"
import { sha256Hex } from "#model/digest.ts"

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(regex("^[0-9a-f]{64}$", "u"))))

const Twin = Schema.Struct({ sha256: Sha256, sourceUrl: Schema.NonEmptyString })

/** A repository at one commit: `owner/repo@<40 hex digits>`. */
const Commit = Schema.String.pipe(
	Schema.check(Schema.isPattern(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+@[0-9a-f]{40}$", "u")))
)

/**
 * A specification a public source publishes, fetched by its pin (design 8.2): `pinnedRef` is
 * `owner/repo@<commit>`, or `unpinned` for a source that cannot be pinned (such sources stay in the
 * `extended` tier), and `twin` is the same document in the other format.
 */
const Fetched = Schema.Struct({
	kind: Schema.Literal("fetched"),
	pinnedRef: Schema.NonEmptyString,
	sourceUrl: Schema.NonEmptyString,
	twin: Schema.optionalKey(Twin)
})

/**
 * A specification no public source publishes, because a tool writes it from another repository's
 * code: its bytes are committed at `path`, under the corpus root, and `producedBy` says how they
 * were written. `tool` and `input` are the tool's and the input's commits, `command` runs in
 * `directory` of the input and writes `output` there (both relative to the input's root), and
 * `changes` are the edits made to either beyond those commits, in plain words, none when the
 * commits alone wrote it.
 */
const Committed = Schema.Struct({
	kind: Schema.Literal("committed"),
	path: Schema.NonEmptyString,
	producedBy: Schema.Struct({
		changes: Schema.Array(Schema.NonEmptyString),
		command: Schema.NonEmptyString,
		directory: Schema.String,
		input: Commit,
		output: Schema.NonEmptyString,
		tool: Commit
	})
})

/** One specification of the corpus (design 8.2): its bytes' size, format, sha256 and source. */
export const CorpusEntry = Schema.Struct({
	bytes: Schema.Int,
	format: Schema.Literals(["json", "yaml"]),
	id: Schema.NonEmptyString,
	infoLicense: Schema.optionalKey(Schema.NonEmptyString),
	license: Schema.NonEmptyString,
	licenseSha256: Schema.optionalKey(Sha256),
	sha256: Sha256,
	source: Schema.Union([Fetched, Committed]),
	tier: Schema.Literals(["ci", "extended"])
})

/**
 * The corpus manifest: a version and one entry per pinned spec.
 */
export const Corpus = Schema.Struct({
	specs: Schema.Array(CorpusEntry),
	version: Schema.Literal(1)
})

/** A spec's bytes, fetched or committed, hash to another sha256 than its entry's. */
export class CorpusHashMismatch extends Schema.TaggedError<
	CorpusHashMismatch,
	{ readonly brand: unique symbol }
>()("CorpusHashMismatch", {
	actual: Schema.String,
	expected: Schema.String,
	source: Schema.String
}) {}

/** A source URL off the one allowed scheme, host, port and credential, refused before any request. */
export class CorpusSourceRefused extends Schema.TaggedError<
	CorpusSourceRefused,
	{ readonly brand: unique symbol }
>()("CorpusSourceRefused", { sourceUrl: Schema.String }) {}

/** The request for a pinned source failed or answered other than 2xx. */
export class CorpusFetchFailed extends Schema.TaggedError<
	CorpusFetchFailed,
	{ readonly brand: unique symbol }
>()("CorpusFetchFailed", { cause: Schema.Defect(), sourceUrl: Schema.String }) {}

/** The cache directory or a cached file could not be read or written. */
export class CorpusCacheFailed extends Schema.TaggedError<
	CorpusCacheFailed,
	{ readonly brand: unique symbol }
>()("CorpusCacheFailed", { cause: Schema.Defect(), path: Schema.String }) {}

export interface Pin {
	readonly sha256: string
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
					onFailure: (cause) => CorpusFetchFailed.make({ cause, sourceUrl }),
					onSuccess: (buffer) => new Uint8Array(buffer)
				})
			)
		: Effect.fail(CorpusSourceRefused.make({ sourceUrl }))

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
		const cacheFailed = (cause: unknown) => CorpusCacheFailed.make({ cause, path: target })
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
			return yield* CorpusHashMismatch.make({
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
const committedAt = (sha256: string, path: string, root: string) =>
	Effect.gen(function* committed() {
		const fs = yield* FileSystem.FileSystem
		const paths = yield* Path.Path
		const target = paths.join(root, path)
		const bytes = yield* fs
			.readFile(target)
			.pipe(Effect.mapError((cause) => CorpusCacheFailed.make({ cause, path: target })))
		const actual = yield* sha256Hex(bytes)
		if (actual !== sha256) {
			return yield* CorpusHashMismatch.make({ actual, expected: sha256, source: path })
		}

		const found: Located = { document: `file:///${path}`, path: target }

		return found
	})

/**
 * An entry's bytes, by its source: a fetched entry's through the pinned cache (`fetchPinned`),
 * named by its source URL, or a committed entry's under the corpus root `root`.
 */
export const locate = <R>(
	entry: typeof CorpusEntry.Type,
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
