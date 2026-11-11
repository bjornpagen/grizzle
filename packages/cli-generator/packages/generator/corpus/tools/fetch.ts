import { regex } from "arkregex"
import { Effect, FileSystem, Path, Schema } from "effect"
import type { Digest } from "effect/crypto"
import { HttpClient, HttpClientResponse } from "effect/http"
import { sha256Hex } from "#model/digest.ts"

const Sha256 = Schema.String.pipe(Schema.check(Schema.isPattern(regex("^[0-9a-f]{64}$", "u"))))

const Twin = Schema.Struct({ sha256: Sha256, sourceUrl: Schema.NonEmptyString })

/**
 * One pinned specification (design 8.2). `pinnedRef` is `owner/repo@<commit>`, or `unpinned` for a
 * source that cannot be pinned (such sources stay in the `extended` tier).
 */
export const CorpusEntry = Schema.Struct({
	bytes: Schema.Int,
	format: Schema.Literals(["json", "yaml"]),
	id: Schema.NonEmptyString,
	infoLicense: Schema.optionalKey(Schema.NonEmptyString),
	license: Schema.NonEmptyString,
	licenseSha256: Schema.optionalKey(Sha256),
	pinnedRef: Schema.NonEmptyString,
	sha256: Sha256,
	sourceUrl: Schema.NonEmptyString,
	tier: Schema.Literals(["ci", "extended"]),
	twin: Schema.optionalKey(Twin)
})

/**
 * The corpus manifest: a version and one entry per pinned spec.
 */
export const Corpus = Schema.Struct({
	specs: Schema.Array(CorpusEntry),
	version: Schema.Literal(1)
})

/** The fetched bytes hash to another sha256 than the pin. */
export class CorpusHashMismatch extends Schema.TaggedError<
	CorpusHashMismatch,
	{ readonly brand: unique symbol }
>()("CorpusHashMismatch", {
	actual: Schema.String,
	expected: Schema.String,
	sourceUrl: Schema.String
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
				sourceUrl: pin.sourceUrl
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
