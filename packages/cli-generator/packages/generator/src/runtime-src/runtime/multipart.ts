import { regex } from "arkregex"
import type { FileSystem, Stdio } from "effect"
import { Array as Arr, Bytes, Effect, Option, pipe, Stream, String as Str } from "effect"
import { Base64, Hex } from "effect/encoding"
import { HttpBody } from "effect/http"
import { UsageError } from "#domain/errors.ts"
import type { StdinClaim } from "#runtime/input.ts"
import { stdinOrFile } from "#runtime/input.ts"
import { encoder } from "#runtime/redact.ts"

/**
 * Per-part encoding facts from an OpenAPI Encoding Object, already resolved by the caller.
 * `contentEncoding` is `base64` only (R34): the writer refuses any other value.
 */
export interface PartEncoding {
	readonly contentEncoding?: "base64"
	readonly contentType?: string
	readonly headers?: readonly (readonly [name: string, value: string])[]
}

/**
 * A part with a body. `name` is required in `multipart/form-data` and ignored in `multipart/mixed`.
 */
export interface LeafPart extends PartEncoding {
	readonly body: Stream.Stream<Uint8Array, unknown> | Uint8Array
	readonly filename?: string
	readonly name?: string
}

/**
 * A part whose body is itself a multipart body: the one permitted nesting level.
 */
export interface NestedPart {
	readonly headers?: readonly (readonly [name: string, value: string])[]
	readonly kind: "form-data" | "mixed"
	readonly name?: string
	readonly parts: readonly LeafPart[]
}

export type Part = LeafPart | NestedPart

type Kind = NestedPart["kind"]

const crlf = "\r\n"

/**
 * Every lone CR or lone LF, which a CRLF pair does not contain.
 */
const loneNewline = regex("\r(?!\n)|(?<!\r)\n", "gu")

const isNested = (part: Part): part is NestedPart => "parts" in part

/**
 * 16 CSPRNG bytes as hex after a fixed prefix: 54 characters, inside RFC 2046's limit of 70.
 */
const randomBoundary = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(16))

	return `----EffectFormBoundary${Hex.encode(bytes)}`
}

/**
 * The WHATWG multipart/form-data escape: LF `%0A`, CR `%0D`, quote `%22`. A name's lone CR or LF
 * becomes CRLF first; a filename is never normalized.
 */
const escapeQuoted = (value: string, isName: boolean): string =>
	pipe(
		isName ? Str.replace(loneNewline, crlf)(value) : value,
		Str.replaceAll("\n", "%0A"),
		Str.replaceAll("\r", "%0D"),
		Str.replaceAll('"', "%22")
	)

const refuse = (message: string) => UsageError.make({ message })

const splitsHeader = (value: string): boolean =>
	Str.includes("\r")(value) || Str.includes("\n")(value) || Str.includes("\u0000")(value)

/**
 * The first reason a part cannot be written, or null. Refuses CR, LF and NUL in every header
 * name and value and content type (design 6.1) and an unnamed form-data part; the type admits no
 * content encoding but `base64` (R34). A reason never repeats a value.
 */
const encodingProblem = (encoding: PartEncoding): string | null => {
	for (const [name, value] of encoding.headers ?? []) {
		if (splitsHeader(name) || splitsHeader(value)) {
			return "a multipart part header contains a CR, LF or NUL character"
		}
	}

	return splitsHeader(encoding.contentType ?? "")
		? "a multipart part content type contains a CR, LF or NUL character"
		: null
}

const partsProblem = (kind: Kind, parts: readonly Part[]): string | null => {
	for (const part of parts) {
		const problem =
			kind === "form-data" && part.name === undefined
				? "a multipart/form-data part needs a name"
				: encodingProblem(part)

		if (problem !== null) {
			return problem
		}

		const nestedProblem = isNested(part) ? partsProblem(part.kind, part.parts) : null

		if (nestedProblem !== null) {
			return nestedProblem
		}
	}

	return null
}

const partHead = (
	boundary: string,
	kind: Kind,
	part: Part,
	nestedType: string | null
): Uint8Array => {
	let head = `--${boundary}\r\n`

	if (kind === "form-data" && part.name !== undefined) {
		head += `Content-Disposition: form-data; name="${escapeQuoted(part.name, true)}"`

		if (!isNested(part) && part.filename !== undefined) {
			head += `; filename="${escapeQuoted(part.filename, false)}"`
		}

		head += "\r\n"
	}

	for (const [name, value] of part.headers ?? []) {
		head += `${name}: ${value}\r\n`
	}

	if (!isNested(part) && part.contentEncoding !== undefined) {
		head += `Content-Transfer-Encoding: ${part.contentEncoding}\r\n`
	}

	const contentType = nestedType ?? (isNested(part) ? undefined : part.contentType)

	if (contentType !== undefined) {
		head += `Content-Type: ${contentType}\r\n`
	}

	return encoder.encode(`${head}\r\n`)
}

const bodyStream = (body: LeafPart["body"]): Stream.Stream<Uint8Array, unknown> =>
	body instanceof Uint8Array ? Stream.succeed(body) : body

/**
 * Streams `source` base64-encoded with padding and no line breaks. Only whole 3-byte groups are
 * encoded per chunk, so no chunk boundary falls inside a quantum; the 0 to 2 leftover bytes are
 * carried and encoded, padded, when the source ends.
 */
const base64Stream = (
	source: Stream.Stream<Uint8Array, unknown>
): Stream.Stream<Uint8Array, unknown> =>
	source.pipe(
		Stream.mapAccum(
			() => new Uint8Array(0),
			(carry: Uint8Array, chunk: Uint8Array) => {
				const joined = Bytes.concat([carry, chunk])

				const whole = joined.length - (joined.length % 3)

				return [
					joined.slice(whole),
					whole === 0 ? [] : [encoder.encode(Base64.encode(joined.subarray(0, whole)))]
				] as const
			},
			{
				onHalt: (carry) => (carry.length === 0 ? [] : [encoder.encode(Base64.encode(carry))])
			}
		)
	)

const leafBody = (part: LeafPart): Stream.Stream<Uint8Array, unknown> =>
	part.contentEncoding === "base64" ? base64Stream(bodyStream(part.body)) : bodyStream(part.body)

const nestedBoundary = (injected: Option.Option<string>, index: number): string =>
	Option.match(injected, { onNone: randomBoundary, onSome: (fixed) => `${fixed}-${index}` })

/**
 * The body as a re-runnable stream: running it again reopens every file part. `injected` is the
 * fixed boundary a nested part derives its own from, none for a CSPRNG one. `terminator` is the
 * text after the close delimiter: CRLF at the top level, nothing inside a part.
 */
const encode = (
	parts: readonly Part[],
	kind: Kind,
	boundary: string,
	injected: Option.Option<string>,
	terminator: string
): Stream.Stream<Uint8Array, unknown> =>
	Stream.fromIterable(Arr.map(parts, (part, index) => [part, index] as const)).pipe(
		Stream.flatMap(([part, index]) => {
			if (isNested(part)) {
				const inner = nestedBoundary(injected, index)

				return Stream.succeed(
					partHead(boundary, kind, part, `multipart/${part.kind}; boundary=${inner}`)
				).pipe(
					Stream.concat(encode(part.parts, part.kind, inner, Option.none(), "")),
					Stream.concat(Stream.succeed(encoder.encode(crlf)))
				)
			}

			return Stream.succeed(partHead(boundary, kind, part, null)).pipe(
				Stream.concat(leafBody(part)),
				Stream.concat(Stream.succeed(encoder.encode(crlf)))
			)
		}),
		Stream.concat(Stream.succeed(encoder.encode(`--${boundary}--${terminator}`)))
	)

const write = (
	kind: Kind,
	parts: readonly Part[],
	fixed: Option.Option<string>
): Effect.Effect<HttpBody.Stream, UsageError> => {
	const problem = partsProblem(kind, parts)

	if (problem !== null) {
		return Effect.fail(refuse(problem))
	}

	const boundary = Option.getOrElse(fixed, randomBoundary)

	return Effect.succeed(
		HttpBody.stream(
			encode(parts, kind, boundary, fixed, crlf),
			`multipart/${kind}; boundary=${boundary}`
		)
	)
}

/**
 * A `multipart/form-data` request body as one `HttpBody.stream`. Refuses before any bytes exist.
 * `fixed` is a fixed boundary for tests, a nested part then taking `<boundary>-<index>`; production
 * callers pass none and get CSPRNG boundaries.
 */
export const formData = (
	parts: readonly Part[],
	fixed: Option.Option<string>
): Effect.Effect<HttpBody.Stream, UsageError> => write("form-data", parts, fixed)

/**
 * A `multipart/mixed` request body, for 3.2 positional parts. `fixed` is as for `formData`.
 */
export const mixed = (
	parts: readonly Part[],
	fixed: Option.Option<string>
): Effect.Effect<HttpBody.Stream, UsageError> => write("mixed", parts, fixed)

/**
 * `-` names stdin, so its part uses the part name; otherwise the basename of the path. A path with
 * no basename (a trailing separator) also uses the part name.
 */
/**
 * A path separator, POSIX or Windows.
 */
const pathSeparator = regex("[/\\\\]", "u")

export const partFilename = (path: string, partName: string): string => {
	if (path === "-") {
		return partName
	}

	const base = Arr.lastNonEmpty(Str.split(pathSeparator)(path))

	return base === "" ? partName : base
}

/**
 * 3.2 positional parts: element `i` takes `prefixEncoding[i]`, later elements take `itemEncoding`.
 */
export const positionalParts = (
	bodies: readonly LeafPart["body"][],
	encodings: {
		readonly itemEncoding?: PartEncoding
		readonly prefixEncoding?: readonly PartEncoding[]
	}
): readonly LeafPart[] =>
	Arr.map(bodies, (body, index) => ({
		...Option.getOrUndefined(
			Option.orElse(Arr.get(encodings.prefixEncoding ?? [], index), () =>
				Option.fromUndefinedOr(encodings.itemEncoding)
			)
		),
		body
	}))

const partUsage = (flag: string, cause: string) =>
	UsageError.make({ flag, message: `--${flag}: ${cause}` })

/**
 * A file part's path, checked before any request as `--body-file`'s is: it exists, is a regular
 * file and is readable. A pipe or device has no size to trust and goes through `-`. Failures name
 * the flag, never the path or the file-system cause.
 */
const checkedPath = (
	fs: FileSystem.FileSystem,
	flag: string,
	path: string
): Effect.Effect<void, UsageError> => {
	const unreadable = () => partUsage(flag, "cannot read the file")

	return fs.stat(path).pipe(
		Effect.mapError(unreadable),
		Effect.filterOrFail(
			(info) => info.type === "File",
			() => partUsage(flag, `is not a regular file; for a pipe use --${flag} -`)
		),
		Effect.andThen(fs.access(path, { readable: true }).pipe(Effect.mapError(unreadable)))
	)
}

/**
 * The bytes of a file part named by `--<flag> <path|->`. `-` takes the invocation's one stdin
 * claim before any read, so a second claimant is refused with a `UsageError` naming both flags.
 * A path is checked first (it exists, is a regular file, is readable), so a bad one is a
 * `UsageError` naming the flag before any request.
 */
export const fileBody = (
	flag: string,
	path: string
): Effect.Effect<
	Stream.Stream<Uint8Array, unknown>,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => stdinOrFile(flag, path, (fs) => Effect.as(checkedPath(fs, flag, path), fs.stream(path)))
