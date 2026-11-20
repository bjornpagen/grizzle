import { regex } from "arkregex"
import {
	Array as Arr,
	Context,
	Data,
	Effect,
	FileSystem,
	Formatter,
	JsonPointer,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Schema,
	type SchemaAST,
	SchemaIssue,
	Stdio,
	Stream,
	String as Str
} from "effect"
import { Argument, CliError, Flag } from "effect/cli"
import { Base64, Base64Url } from "effect/encoding"
import { HttpBody } from "effect/http"
import { UsageError } from "#domain/errors.ts"
import { InvalidJsonText, type JsonReviver, parseJson, parseRevivedJson } from "#runtime/json.ts"
import type { MediaDeclaration } from "#runtime/negotiate.ts"
import * as Negotiate from "#runtime/negotiate.ts"
import type { Secret } from "#runtime/redact.ts"
import { RunCredentials, encoder } from "#runtime/redact.ts"
import { utf8Text } from "#runtime/utf8.ts"

/**
 * Writes one line to stderr and ignores a failure to write it: a diagnostic never fails the run.
 * The one stderr writer of the runtime.
 */
export const printStderr = (text: string): Effect.Effect<void, never, Stdio.Stdio> =>
	Effect.gen(function* printLine() {
		const stdio = yield* Stdio.Stdio

		yield* Stream.run(Stream.make(`${text}\n`), stdio.stderr())
	}).pipe(Effect.ignore)

const bodyFileName = "body-file"

/**
 * Whole request body as text; field flags override it.
 */
export const bodyFlag = Flag.String("body").pipe(
	Flag.optional,
	Flag.withDescription("Whole request body; field flags override it")
)

/**
 * Whole request body from a file, or from stdin when the value is `-`. `Flag.String` keeps `-`
 * literal, so no path fix-up is needed here.
 */
export const bodyFileFlag = Flag.String(bodyFileName).pipe(
	Flag.withMetavar("path|-"),
	Flag.optional,
	Flag.withDescription("Whole request body from a file or stdin")
)

/**
 * The invocation's single stdin claim (design 4.5, C1). `claim` succeeds once per layer and then
 * refuses every later claimant with a `UsageError` that names flags only.
 */
export class StdinClaim extends Context.Service<
	StdinClaim,
	{ readonly claim: (flag: string) => Effect.Effect<void, UsageError> }
>()("@bjornpagen/grizzle-cli-generator/runtime-src/runtime/input/StdinClaim") {}

/**
 * A fresh claim for one invocation. The root `services` layer provides it once.
 */
export const stdinClaimLayer: Layer.Layer<StdinClaim> = Layer.effect(
	StdinClaim,
	Effect.gen(function* build() {
		const holder = yield* Ref.make(Option.none<string>())

		return {
			claim: (flag) =>
				Ref.modify(holder, (held) =>
					Option.isSome(held) ? [held, held] : [Option.none<string>(), Option.some(flag)]
				).pipe(
					Effect.flatMap((first) =>
						Option.isSome(first)
							? Effect.fail(
									new UsageError({
										flag,
										message: `--${flag}: standard input is already read by --${first.value}`
									})
								)
							: Effect.void
					)
				)
		}
	})
)

const usage = (flag: string, cause: string): UsageError =>
	new UsageError({ flag, message: `--${flag}: ${cause}` })

const cannotReadIn = (flag: string): UsageError => usage(flag, "cannot read the file or stdin")

const cannotRead = (): UsageError => cannotReadIn(bodyFileName)

/**
 * A binary body past the `maxLength` its schema declares (MED-21): the API's own bound, named as the schema states it.
 */
const overLimit = (limit: number): UsageError =>
	usage(bodyFileName, `the body is over ${limit} bytes, the schema's maxLength`)

const notAFile = (): UsageError =>
	usage(bodyFileName, `is not a regular file; for a pipe use --${bodyFileName} -`)

/**
 * A body past the `maxLength` its schema declares stopped there.
 */
class OverLimit extends Data.TaggedError("OverLimit") {}

/**
 * A read whose source failed; the cause stays out of the message.
 */
export class ReadFailed extends Data.TaggedError("ReadFailed") {}

/**
 * `source` bounded to `limit` bytes: a source failure becomes `ReadFailed`, and the chunk that
 * crosses the limit becomes `OverLimit`.
 */
const bounded = (
	source: Stream.Stream<Uint8Array, unknown>,
	limit: number
): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
	source.pipe(
		Stream.mapError((): OverLimit | ReadFailed => new ReadFailed()),
		Stream.limitBytes(limit, (): Stream.Stream<Uint8Array, OverLimit | ReadFailed> =>
			Stream.fail(new OverLimit())
		)
	)

/**
 * Every byte of `source`, joined: a value the operator gives as a file or on stdin, read to its end. A source failure
 * becomes `ReadFailed`, which the caller maps to its own message.
 */
export const readAll = (
	source: Stream.Stream<Uint8Array, unknown>
): Effect.Effect<Uint8Array, ReadFailed> =>
	Stream.mkUint8Array(source.pipe(Stream.mapError(() => new ReadFailed())))

/**
 * Decodes `bytes` as UTF-8 by the runtime's one codec (`#runtime/utf8.ts`, grizzle-text's): bytes that are no UTF-8 fail
 * with `invalid`, and a byte order mark stays a character.
 */
export const decodeUtf8 = (
	bytes: Uint8Array,
	invalid: UsageError
): Effect.Effect<string, UsageError> =>
	Effect.fromOption(Option.fromUndefinedOr(utf8Text(bytes)), () => invalid)

/**
 * The source behind a `--<flag> <path|->` value: stdin for `-`, after claiming it for `flag`, or
 * whatever `openFile` returns for a path. Callers differ in what a path needs (`multipart.ts`
 * checks it first) and in what follows (collect or stream).
 */
export const stdinOrFile = (
	flag: string,
	path: string,
	openFile: (
		fs: FileSystem.FileSystem
	) => Effect.Effect<Stream.Stream<Uint8Array, unknown>, UsageError>
): Effect.Effect<
	Stream.Stream<Uint8Array, unknown>,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
	path === "-"
		? Effect.service(StdinClaim).pipe(
				Effect.flatMap((claim) => claim.claim(flag)),
				Effect.flatMap(() => Effect.service(Stdio.Stdio)),
				Effect.map((stdio) => stdio.stdin)
			)
		: Effect.flatMap(Effect.service(FileSystem.FileSystem), openFile)

/**
 * A path read whole, or stdin for `-` under the one stdin claim, failing in `flag`.
 */
const readFlagFile = (
	path: string,
	flag: string
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
	stdinOrFile(flag, path, (fs) => Effect.succeed(fs.stream(path))).pipe(
		Effect.flatMap((source) =>
			readAll(source).pipe(Effect.catchTag("ReadFailed", () => Effect.fail(cannotReadIn(flag))))
		)
	)

/**
 * Reads `--body-file` into memory whole, for a body the runtime parses (JSON, form): a file by path, or stdin for `-`
 * (which takes the one stdin claim). Failures name the flag, never the path or the file-system cause (design 4.6).
 */
export const readBodyFile = (
	path: string
): Effect.Effect<Uint8Array, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
	readFlagFile(path, bodyFileName)

/**
 * A body stream that counts the bytes it yields against its schema's `maxLength`, so a file that grows past its stat
 * size still stops there; the send step sees a `UsageError`.
 */
const limited = (
	body: HttpBody.HttpBody,
	limit: number
): Effect.Effect<HttpBody.HttpBody, UsageError> => {
	if (body._tag !== "Stream") {
		return Effect.succeed(body)
	}

	return (body.contentLength ?? 0) > limit
		? Effect.fail(overLimit(limit))
		: Effect.succeed(
				HttpBody.stream(
					bounded(body.stream, limit).pipe(
						Stream.catchTags({
							OverLimit: () => Stream.fail(overLimit(limit)),
							ReadFailed: () => Stream.fail(cannotRead())
						})
					),
					body.contentType,
					body.contentLength
				)
			)
}

/**
 * A regular file as a body. Only a regular file is accepted. It is opened once here, so a missing
 * read permission fails at flag time, then streamed with its size as `Content-Length`. A directory
 * is refused, and so is a pipe or device (a FIFO, `<(cmd)`): it has no size to trust, and the
 * platform file system reads by position, which a pipe refuses. Such input goes through `-`
 * instead. `limit` is the schema's `maxLength` the file is counted against; none streams it whole.
 */
const openFile = (
	path: string,
	limit: Option.Option<number>
): Effect.Effect<HttpBody.HttpBody, UsageError, FileSystem.FileSystem> =>
	Effect.gen(function* open() {
		const fs = yield* FileSystem.FileSystem
		const info = yield* fs.stat(path).pipe(Effect.mapError(cannotRead))

		if (info.type !== "File") {
			return yield* notAFile()
		}

		if (Option.isSome(limit) && info.size > BigInt(limit.value)) {
			return yield* overLimit(limit.value)
		}

		yield* fs.open(path, { flag: "r" }).pipe(Effect.scoped, Effect.mapError(cannotRead))

		const opened = HttpBody.file(path).pipe(
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.mapError(cannotRead)
		)

		return yield* Option.match(limit, {
			onNone: () => opened,
			onSome: (bound) => Effect.flatMap(opened, (body) => limited(body, bound))
		})
	})

/**
 * `--body-file -` as a chunked body with no length: stdin under the one stdin claim, streamed as
 * it arrives and never collected. A read failure is a `UsageError` naming the flag.
 */
const stdinBody: Effect.Effect<HttpBody.HttpBody, UsageError, Stdio.Stdio | StdinClaim> =
	Effect.service(StdinClaim).pipe(
		Effect.flatMap((claim) => claim.claim(bodyFileName)),
		Effect.flatMap(() => Effect.service(Stdio.Stdio)),
		Effect.map((stdio) => HttpBody.stream(stdio.stdin.pipe(Stream.mapError(cannotRead))))
	)

/**
 * A binary request body from `--body-file` only (design 6.3 Binary). A regular file streams through
 * its size as `Content-Length`; stdin (`-`) streams chunked under the one stdin claim, with no
 * `Content-Length`. Neither is held in memory. Where the body schema states a `maxLength` (`maxBytes`, MED-21), both
 * count their bytes against it as they stream, so a longer body fails the send with a `UsageError` naming
 * `--body-file` and that bound, never the content or the path; an unreadable stdin fails the same way. `--body` is
 * refused, and so is `--body` together with `--body-file`. With neither flag a required body is a `UsageError` naming
 * `--body-file` and an optional one is empty.
 */
export const binaryBody = (options: {
	readonly body: Option.Option<string>
	readonly bodyFile: Option.Option<string>
	readonly required: boolean
	readonly maxBytes?: number
}): Effect.Effect<
	HttpBody.HttpBody,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
	if (Option.isSome(options.body)) {
		return Effect.fail(
			usage(
				"body",
				Option.isSome(options.bodyFile)
					? `cannot be used with --${bodyFileName}`
					: `this request body is binary; use --${bodyFileName}`
			)
		)
	}

	if (Option.isNone(options.bodyFile)) {
		return options.required
			? Effect.fail(usage(bodyFileName, `this request needs a body; use --${bodyFileName}`))
			: Effect.succeed(HttpBody.empty)
	}

	const limit = Option.fromUndefinedOr(options.maxBytes)

	return options.bodyFile.value === "-"
		? Option.match(limit, {
				onNone: () => stdinBody,
				onSome: (bound) => Effect.flatMap(stdinBody, (body) => limited(body, bound))
			})
		: openFile(options.bodyFile.value, limit)
}

/**
 * A sequential request body (NDJSON, JSON Lines, JSON-seq; design 6.3 Sequential uploads) or a text
 * body, exactly as the operator gives it: `--body` is the text as given; a `--body-file` regular
 * file streams with its size as `Content-Length`; `-` streams stdin chunked under the one stdin
 * claim. The bytes are never parsed, re-framed, buffered whole or asserted against a schema. The
 * caller sets the declared media type as `Content-Type`. `--body` together with `--body-file` is
 * refused. With neither flag a required body is a `UsageError` and an optional one is empty.
 */
export const sequentialBody = (options: {
	readonly body: Option.Option<string>
	readonly bodyFile: Option.Option<string>
	readonly required: boolean
}): Effect.Effect<
	HttpBody.HttpBody,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
	if (Option.isSome(options.body)) {
		return Option.isSome(options.bodyFile)
			? Effect.fail(usage("body", `cannot be used with --${bodyFileName}`))
			: Effect.succeed(HttpBody.text(options.body.value))
	}

	if (Option.isNone(options.bodyFile)) {
		return options.required
			? Effect.fail(usage(bodyFileName, `this request needs a body; use --${bodyFileName}`))
			: Effect.succeed(HttpBody.empty)
	}

	const path = options.bodyFile.value

	return path === "-" ? stdinBody : openFile(path, Option.none())
}

/**
 * A JSON number kept as its source text. A field flag for an `integer` or `number` property passes
 * the operator's text this way; a merged body marks any number whose text `JSON.parse` would
 * change (digits past 2^53, `1.50`, `1e2`). `jsonText` writes it as its text, unchanged; a text
 * outside the JSON number grammar is refused before the writer meets it.
 */
export class JsonNumber {
	readonly text: string

	constructor(text: string) {
		this.text = text
	}
}

const jsonNumberGrammar: Readonly<RegExp> = regex(
	"^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?$",
	"u"
)

/**
 * Whether `text` is a JSON number (RFC 8259 section 6). A `JsonNumber` is sent as its text, so a
 * text outside this grammar is refused before it reaches the wire.
 */
export const isJsonNumberText = (text: string): boolean => jsonNumberGrammar.test(text)

/**
 * JSON `null` as the runtime carries it: a value of its own beside `JsonNumber`, so `undefined` is
 * the one absence a parameter, member or field has. Its JSON form is `null`.
 */
export class JsonNull {
	toJSON(): null {
		return null
	}
}

/**
 * The one JSON `null` every parse revives.
 */
export const jsonNull = new JsonNull()

/**
 * A JSON value the runtime writes: a scalar, a `JsonNumber`, `JsonNull`, or an array or object of
 * them. Both a parsed body and a serializer's value are one.
 */
export type JsonValue =
	| JsonNull
	| boolean
	| number
	| string
	| JsonNumber
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue }

/**
 * One step of writing a JSON text: a value still to write, or text already composed.
 */
type JsonStep = Readonly<{ value: JsonValue }> | Readonly<{ text: string }>

/**
 * A container's steps in order, each child after the separator and name before it, between its brackets.
 */
const childSteps = (value: JsonValue): Option.Option<readonly JsonStep[]> => {
	if (Arr.isArray<JsonValue>(value)) {
		return Option.some([
			{ text: "[" },
			...Arr.flatMap(value, (item, index): readonly JsonStep[] =>
				index === 0 ? [{ value: item }] : [{ text: "," }, { value: item }]
			),
			{ text: "]" }
		])
	}

	if (Predicate.isObject(value) && !(value instanceof JsonNumber) && !(value instanceof JsonNull)) {
		return Option.some([
			{ text: "{" },
			...Arr.flatMap(Rec.toEntries(value), ([key, member], index): readonly JsonStep[] => [
				{ text: `${index === 0 ? "" : ","}${Formatter.formatJson(key)}:` },
				{ value: member }
			]),
			{ text: "}" }
		])
	}

	return Option.none()
}

/**
 * A scalar's JSON text: a `JsonNumber` as its digits, `JsonNull` as `null`, anything else as `Formatter.formatJson`
 * writes it.
 */
const leafText = (value: JsonValue): string => {
	if (value instanceof JsonNumber) {
		return value.text
	}

	return value instanceof JsonNull ? "null" : Formatter.formatJson(value)
}

/**
 * The compact JSON text of `value`, as `JSON.stringify` writes it, with a `JsonNumber` as its
 * digit text and `JsonNull` as `null`. Effect writes JSON only through `JSON.stringify`, which has
 * no raw number of its own, so the runtime composes the text and writes each name and leaf through
 * `Formatter.formatJson`; members keep their own-key order. The walk keeps its own stack, so no
 * nesting the parse admitted overflows it.
 */
export const jsonText = (value: JsonValue): string => {
	const parts: string[] = []
	const pending: JsonStep[] = [{ value }]
	for (let step = pending.pop(); step !== undefined; step = pending.pop()) {
		if ("text" in step) {
			parts.push(step.text)
		} else {
			const children = childSteps(step.value)
			if (Option.isSome(children)) {
				for (const child of Arr.reverse(children.value)) {
					pending.push(child)
				}
			} else {
				parts.push(leafText(step.value))
			}
		}
	}

	return Arr.join(parts, "")
}

/**
 * A field flag's value: a scalar, a number field's text as a `JsonNumber`, or a decoded JSON
 * value (an object, an array, `JsonNull`) for a property that is not flattened (design 4.5).
 */
export type FieldValue =
	| JsonNull
	| boolean
	| number
	| string
	| JsonNumber
	| readonly FieldValue[]
	| { readonly [key: string]: FieldValue }

/**
 * Text encodings a base64 body property takes (RFC 4648 section 4 and 5), padding kept for both.
 */
export type FieldEncoding = "base64" | "base64url"

/**
 * A field flag whose value is a path, or `-` for stdin, to a file the runtime reads and encodes
 * into the property at its pointer. `flag` is the flag's name, the only thing a failure names.
 */
export class FileField {
	readonly encoding: FieldEncoding
	readonly flag: string
	readonly path: string

	constructor(options: {
		readonly encoding: FieldEncoding
		readonly flag: string
		readonly path: string
	}) {
		this.encoding = options.encoding
		this.flag = options.flag
		this.path = options.path
	}
}

/**
 * A secret-file field flag's value (design 13.1 R4): a path, or `-` for stdin, to the value of a
 * `format: password` string property. The runtime reads it whole, holds it `Redacted` until the
 * body is serialized, and records it so every error path scrubs it. `flag` is the flag's name: the
 * only thing a failure names, and the label its placeholder carries.
 */
export class SecretField {
	readonly flag: string
	readonly path: string

	constructor(options: { readonly flag: string; readonly path: string }) {
		this.flag = options.flag
		this.path = options.path
	}
}

const secretFileNote = "Read the value from a file or stdin (-); it is never echoed"

/**
 * A secret flag's help: the property's description, when it has one, then the secret-file note.
 */
const secretHelp = (description: Option.Option<string>): string =>
	Option.match(description, {
		onNone: () => secretFileNote,
		onSome: (text) => `${text} ${secretFileNote}`
	})

/**
 * A secret-file field flag, `--<prop>-file <path|->`. `Flag.String` keeps `-` literal; the value
 * is a path, so argv never holds the secret. Help shows the property's description, when it has
 * one, then the note that the value is read from a file or stdin.
 */
export const secretFileFlag = (name: string, description: Option.Option<string>) =>
	Flag.String(name).pipe(
		Flag.withMetavar("path|-"),
		Flag.optional,
		Flag.withDescription(secretHelp(description))
	)

/**
 * A multipart `format: password` part's flag, `--<part> <path|->` (ruling DR4): a file part, so
 * argv holds a path, never the secret. Help reads as `secretFileFlag`'s. The caller adds the
 * presence step (`Flag.optional`, or `Flag.atLeast` for a repeated part); a read failure names
 * the flag, never the path (`Multipart.fileBody`).
 */
export const secretPartFlag = (name: string, description: Option.Option<string>) =>
	Flag.String(name).pipe(Flag.withMetavar("path|-"), Flag.withDescription(secretHelp(description)))

export type Fields = Readonly<
	Record<string, Option.Option<FieldValue | FileField | SecretField> | readonly FieldValue[]>
>

export type JsonNode =
	| JsonNull
	| boolean
	| number
	| string
	| JsonNumber
	| readonly JsonNode[]
	| { [key: string]: JsonNode }

/**
 * A JSON object whose members a merge writes.
 */
export type JsonObject = Record<string, JsonNode>

/**
 * Whether `value` is a revived JSON leaf: `JsonNull`, a boolean, a number, a string or a `JsonNumber`.
 */
const isJsonLeaf = (value: unknown): boolean =>
	value instanceof JsonNull ||
	Predicate.isBoolean(value) ||
	Predicate.isNumber(value) ||
	Predicate.isString(value) ||
	value instanceof JsonNumber

/**
 * Whether `value` is a revived JSON value: what a reviver returns at every level. The walk keeps its own stack, so no
 * nesting the parse admitted overflows it.
 */
const isJsonNode = (value: unknown): value is JsonNode => {
	const pending: unknown[] = [value]
	while (pending.length > 0) {
		const current = pending.pop()
		if (!isJsonLeaf(current)) {
			if (!Predicate.isObjectOrArray(current)) {
				return false
			}

			for (const child of Arr.isArray(current) ? current : Rec.values(current)) {
				pending.push(child)
			}
		}
	}

	return true
}

const int64Digits: Readonly<RegExp> = regex("^-?(?:0|[1-9]\\d*)$", "u")

/**
 * An `int64` field flag's value as a `JsonNumber`, checked against the same digit pattern a merged
 * body is. A non-digit text is a `UsageError` naming the flag only, never the text.
 */
export const jsonNumber = (digits: string, flag: string): Effect.Effect<JsonNumber, UsageError> =>
	int64Digits.test(digits)
		? Effect.succeed(new JsonNumber(digits))
		: Effect.fail(usage(flag, "an integer field is not a digit string"))

/**
 * A flag's `mapEffect` fails in `CliError`; the `UsageError` rides as the cause with its own
 * message.
 */
export const asCliError = (error: UsageError): CliError.CliError =>
	CliError.UserError.make({ cause: error, userMessage: error.message })

/**
 * The flag for an `int64` field: its digit string parsed to a `JsonNumber`, so a later merge writes
 * the digits unchanged. Help labels it `integer`. A non-digit value fails the flag with an error
 * that names `--name` and never the value.
 */
export const int64Flag = (name: string) =>
	Flag.String(name).pipe(
		Flag.withMetavar("integer"),
		Flag.mapEffect((raw) => jsonNumber(raw, name).pipe(Effect.mapError(asCliError)))
	)

/**
 * The scalar type an `integer` or `number` parameter's text is checked against (design 6.1).
 */
export type NumericKind = "integer" | "number"

const numericGrammar: Readonly<Record<NumericKind, (text: string) => boolean>> = {
	integer: (text: string) => int64Digits.test(text),
	number: isJsonNumberText
}

const numericCause: Readonly<Record<NumericKind, string>> = {
	integer: "is not an integer",
	number: "is not a JSON number"
}

/**
 * The one check behind `numericFlag` and `numericArgument`: the text unchanged, or a value-free
 * error built by `refuse` from the cause.
 */
const numericText =
	(kind: NumericKind, refuse: (cause: string) => UsageError) =>
	(text: string): Effect.Effect<string, CliError.CliError> =>
		numericGrammar[kind](text)
			? Effect.succeed(text)
			: Effect.fail(asCliError(refuse(numericCause[kind])))

/**
 * The flag for an `integer` or `number` parameter or field: its text checked against the JSON
 * integer or number grammar and returned unchanged, so `9007199254740993` and `1.50` reach the wire
 * as given. Help labels it with its `kind`. A text outside the grammar fails the flag with an error
 * that names `--name` and never the text.
 */
export const numericFlag = (name: string, kind: NumericKind) =>
	Flag.String(name).pipe(
		Flag.withMetavar(kind),
		Flag.mapEffect(numericText(kind, (cause) => usage(name, cause)))
	)

/**
 * The positional argument for an `integer` or `number` path parameter, checked and labelled as
 * `numericFlag` is. A text outside the grammar fails with an error that names `<name>` and never
 * the text.
 */
export const numericArgument = (name: string, kind: NumericKind) =>
	Argument.String(name).pipe(
		Argument.withMetavar(kind),
		Argument.mapEffect(
			numericText(kind, (cause) => new UsageError({ message: `<${name}>: ${cause}` }))
		)
	)

/**
 * The one stderr notice for a given deprecated parameter: it names the flag or argument, never a
 * value, and passes the value on unchanged. An absent optional flag is `None` and an absent
 * repeated one is empty; neither prints.
 */
const noticeDeprecated =
	(label: string) =>
	<A>(value: A): Effect.Effect<A, never, Stdio.Stdio> => {
		const absent =
			(Option.isOption(value) && Option.isNone(value)) || (Arr.isArray(value) && value.length === 0)

		return absent
			? Effect.succeed(value)
			: printStderr(`Notice: the parameter ${label} is deprecated`).pipe(Effect.as(value))
	}

/**
 * A deprecated parameter's flag (PRM-07): one stderr notice naming `--name` when the operator gives
 * the flag, however often, and none when it is absent; the value is unchanged. It applies outside
 * the `Flag.optional` or `Flag.atLeast` wrapper, which only then has settled whether a value was
 * given.
 */
export const deprecated =
	(name: string) =>
	<A>(self: Flag.Flag<A>): Flag.Flag<A> =>
		self.pipe(Flag.mapEffect(noticeDeprecated(`--${name}`)))

/**
 * The positional argument twin of `deprecated` for a deprecated path parameter: the notice names
 * `<name>`, never the value.
 */
export const deprecatedArgument =
	(name: string) =>
	<A>(self: Argument.Argument<A>): Argument.Argument<A> =>
		self.pipe(Argument.mapEffect(noticeDeprecated(`<${name}>`)))

const isObject = (value: JsonNode): value is JsonObject =>
	Predicate.isObject(value) &&
	!Arr.isArray<JsonNode>(value) &&
	!(value instanceof JsonNumber) &&
	!(value instanceof JsonNull)

/**
 * A fresh object with no prototype, so `__proto__`, `constructor` and `prototype` are ordinary own
 * keys.
 */
const bare = (): JsonObject => {
	const fresh: JsonObject = {}
	Reflect.setPrototypeOf(fresh, null)

	return fresh
}

/**
 * A copy of `source` with no prototype.
 */
const bareCopy = (source: object): JsonObject => Object.assign(bare(), source)

/**
 * The reviver of operator JSON: `null` as `JsonNull`, a number whose digits `JSON.parse` would change as its source
 * text, and an object, its members already revived, as a copy with no prototype.
 */
const revive: JsonReviver = (_key, value, context) => {
	if (value === null) {
		return jsonNull
	}

	if (Predicate.isNumber(value)) {
		return context.source !== undefined && String(value) !== context.source
			? new JsonNumber(context.source)
			: value
	}

	return Predicate.isObject(value) && !Arr.isArray(value) ? bareCopy(value) : value
}

/**
 * The reviver of a JSON field value: it keeps only integers whose digits `JSON.parse` would
 * change, since `1.50` and `1e2` decode to the same number. A number that overflows (`1e400`)
 * decodes to Infinity, which `JSON.stringify` would send as `null`; it throws here, and the
 * parse's failure turns that into a value-free one.
 */
const reviveIntegers: JsonReviver = (key, value, context) => {
	if (Predicate.isNumber(value) && !Number.isFinite(value)) {
		throw new RangeError("a JSON number is not finite")
	}

	return Predicate.isNumber(value) &&
		context.source !== undefined &&
		!int64Digits.test(context.source)
		? value
		: revive(key, value, context)
}

/**
 * Decodes operator JSON text whose values `reviver` revives, read as the revived node every level of it is.
 */
const revivedDecoder =
	(reviver: JsonReviver) =>
	(text: string): Effect.Effect<JsonNode, InvalidJsonText> =>
		Effect.fromResult(
			parseRevivedJson(text, reviver).pipe(
				Result.filterOrFail(isJsonNode, () => new InvalidJsonText())
			)
		)

const decodeRevived = revivedDecoder(revive)

const decodeIntegers = revivedDecoder(reviveIntegers)

const decodePlain = (text: string): Effect.Effect<unknown, InvalidJsonText> =>
	Effect.fromResult(parseJson(text))

/**
 * The one parse behind `jsonFlag` and `jsonArgument`: the decoded value, or the value-free error
 * `failure` builds.
 */
const parsedJson =
	(failure: () => CliError.CliError) =>
	(raw: string): Effect.Effect<JsonNode, CliError.CliError> =>
		Effect.mapError(decodeIntegers(raw), failure)

/**
 * The flag for a JSON-valued field: its text parsed with the number-preserving parse `mergeBody`
 * uses (digits past 2^53 stay a `JsonNumber`, objects have no prototype). A text that is not JSON,
 * holds a number that is not finite, or nests deeper than the engine's parse can follow fails the flag with an error
 * that names `--name` and never the text.
 */
export const jsonFlag = (name: string) =>
	Flag.String(name).pipe(
		Flag.mapEffect(parsedJson(() => asCliError(usage(name, "is not valid JSON"))))
	)

/**
 * The positional argument twin of `jsonFlag` for an object-schema path parameter: its text parsed
 * the same way. A text that is not JSON fails with an error that names `<name>` and never the text.
 */
export const jsonArgument = (name: string) =>
	Argument.String(name).pipe(
		Argument.mapEffect(
			parsedJson(() => asCliError(new UsageError({ message: `<${name}>: is not valid JSON` })))
		)
	)

const segmentsOf = (pointer: string): Option.Option<Arr.NonEmptyReadonlyArray<string>> =>
	Str.startsWith("/")(pointer)
		? Option.some(
				Arr.map(Str.split("/")(Str.slice(1)(pointer)), (token) => JsonPointer.unescapeToken(token))
			)
		: Option.none()

const setAt = (
	root: JsonObject,
	pointer: string,
	value: JsonNode
): Effect.Effect<void, UsageError> =>
	Option.match(segmentsOf(pointer), {
		onNone: () => Effect.fail(usage("body", "a field has no valid body pointer")),
		onSome: (segments) => {
			let node = root
			for (const segment of Arr.initNonEmpty(segments)) {
				const next = Option.filter(Rec.get(node, segment), isObject)

				if (Option.isSome(next)) {
					node = next.value
				} else {
					const fresh = bare()

					node[segment] = fresh
					node = fresh
				}
			}

			node[Arr.lastNonEmpty(segments)] = value

			return Effect.void
		}
	})

const supplied = (value: Fields[string]): Option.Option<FieldValue | FileField | SecretField> => {
	if (Option.isOption(value)) {
		return value
	}

	return Arr.isReadonlyArrayNonEmpty(value) ? Option.some(value) : Option.none()
}

/**
 * A field value that is a JSON object.
 */
const isFieldObject = (value: FieldValue): value is Readonly<Record<string, FieldValue>> =>
	Predicate.isObject(value) &&
	!Arr.isArray<FieldValue>(value) &&
	!(value instanceof JsonNumber) &&
	!(value instanceof JsonNull)

/**
 * Whether every `JsonNumber` of a field value is a JSON number, walked with an explicit stack, so a deep value cannot
 * overflow it. A `JsonNumber` is checked against the JSON number grammar only: whether it is an integer is the flag's
 * check (`int64Flag`, `numericFlag`).
 */
const hasValidNumbers = (root: FieldValue): boolean => {
	const pending: FieldValue[] = [root]

	for (let value = pending.pop(); value !== undefined; value = pending.pop()) {
		if (value instanceof JsonNumber) {
			if (!isJsonNumberText(value.text)) {
				return false
			}
		} else if (Arr.isArray<FieldValue>(value) || isFieldObject(value)) {
			for (const child of Arr.isArray<FieldValue>(value) ? value : Rec.values(value)) {
				pending.push(child)
			}
		}
	}

	return true
}

/**
 * A container of a field value with the empty copy its members are written into.
 */
type Copying =
	| Readonly<{ _tag: "Array"; source: readonly FieldValue[]; target: JsonNode[] }>
	| Readonly<{ _tag: "Object"; source: { readonly [key: string]: FieldValue }; target: JsonObject }>

/**
 * A container's empty copy (an array, or an object with no prototype), its members left to `pending`, or a scalar
 * itself.
 */
const copyOf = (value: FieldValue, pending: Copying[]): JsonNode => {
	if (Arr.isArray<FieldValue>(value)) {
		const target: JsonNode[] = []
		pending.push({ _tag: "Array", source: value, target })

		return target
	}

	if (!isFieldObject(value)) {
		return value
	}

	const target = bare()
	pending.push({ _tag: "Object", source: value, target })

	return target
}

/**
 * A field value as it enters the body: a deep copy whose objects have no prototype, so a later
 * field flag that writes `__proto__` beneath it sets an own key, as it does everywhere else. The copy keeps its own
 * stack, so a deep value cannot overflow it.
 */
const toNode = (root: FieldValue): JsonNode => {
	const pending: Copying[] = []
	const top = copyOf(root, pending)

	for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
		if (item._tag === "Array") {
			for (const child of item.source) {
				item.target.push(copyOf(child, pending))
			}
		} else {
			for (const [key, child] of Rec.toEntries(item.source)) {
				item.target[key] = copyOf(child, pending)
			}
		}
	}

	return top
}

const encodeBytes = (bytes: Uint8Array, encoding: FieldEncoding): string =>
	encoding === "base64url" ? Base64Url.encodePadded(bytes) : Base64.encode(bytes)

const readEncoded = (
	field: FileField
): Effect.Effect<string, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
	readFlagFile(field.path, field.flag).pipe(
		Effect.map((bytes) => encodeBytes(bytes, field.encoding))
	)

const decodeText = (bytes: Uint8Array, flag: string): Effect.Effect<string, UsageError> =>
	decodeUtf8(bytes, usage(flag, "is not valid UTF-8"))

/**
 * Records `secret` for the run when `RunCredentials` is present. It is optional so `mergeBody` and
 * `structuredBody` keep their requirements for callers that pass no secret field; every emitted
 * entry provides it, because `finalCatch` and `send` require it.
 */
const record = (secret: Secret): Effect.Effect<void> =>
	Effect.serviceOption(RunCredentials).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () => Effect.void,
				onSome: (recorded) => Ref.update(recorded, (entries) => [...entries, secret])
			})
		)
	)

/**
 * One trailing `\r?\n`.
 */
const lineEnd: Readonly<RegExp> = regex("\r?\n$", "u")

/**
 * Strips one trailing `\r?\n`: the line end `echo value > file` writes. The one rule for a secret
 * read from a file, shared by credential files (`auth.ts`) and secret-file field flags; a second
 * line end is the value's own.
 */
export const stripLineEnd = (text: string): string => Str.replace(lineEnd, "")(text)

/**
 * A secret-file value: the text, read whole and UTF-8, with one trailing line end stripped (as a
 * credential file), recorded for the run before anything else can fail, and held `Redacted` until
 * the merge writes it.
 */
const readSecret = (
	field: SecretField
): Effect.Effect<Redacted.Redacted, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
	readFlagFile(field.path, field.flag).pipe(
		Effect.flatMap((bytes) => decodeText(bytes, field.flag)),
		Effect.map((text) => Redacted.make(stripLineEnd(text))),
		Effect.tap((value) => record({ kind: "secret", label: field.flag, value }))
	)

const sourceOf = (options: {
	readonly body: Option.Option<string>
	readonly bodyFile: Option.Option<string>
}): Effect.Effect<
	Option.Option<{ readonly bytes: Uint8Array; readonly flag: string }>,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> => {
	if (Option.isSome(options.body)) {
		return Option.isSome(options.bodyFile)
			? Effect.fail(usage("body", `cannot be used with --${bodyFileName}`))
			: Effect.succeedSome({ bytes: encoder.encode(options.body.value), flag: "body" })
	}

	return Option.isSome(options.bodyFile)
		? readBodyFile(options.bodyFile.value).pipe(
				Effect.map((bytes) => Option.some({ bytes, flag: bodyFileName }))
			)
		: Effect.succeedNone
}

/**
 * The body members that admit one value, by RFC 6901 pointer from the body root, each as its JSON text: the request
 * sends them as it sends a constant parameter, and no flag reads them.
 */
type Constants = Readonly<Record<string, string>>

interface BodyOptions {
	readonly body: Option.Option<string>
	readonly bodyFile: Option.Option<string>
	readonly constants: Constants
	readonly fields: Fields
	readonly required: boolean
	readonly schema: Schema.Top
}

/**
 * The parse options every body is checked under: a member no property of a closed object declares is an excess
 * property, and refused (SCH-13). The domain module writes a closed object (`additionalProperties: false`) as a plain
 * Struct and an open one as a Struct with a JSON rest, so this one option decides the closure; no default strips it.
 */
const closedObjects = { onExcessProperty: "error" } as const

/** What JSON a node of the schema expects where a value of another type stands, by the JSON Schema `type` it names. */
const expectedType = (ast: SchemaAST.AST): string => {
	switch (ast._tag) {
		case "String":
		case "TemplateLiteral":
			return "a string"
		case "Number":
			return "a number"
		case "Boolean":
			return "a boolean"
		case "Null":
			return "null"
		case "Arrays":
			return "an array"
		case "Objects":
		case "ObjectKeyword":
			return "an object"
		case "Literal":
			return `${Formatter.format(ast.literal)} (const)`
		case "Union":
		case "Enum":
			return "one of its alternatives"
		case "Declaration":
		case "Undefined":
		case "Void":
		case "Never":
		case "Unknown":
		case "Any":
		case "BigInt":
		case "Symbol":
		case "UniqueSymbol":
		case "Suspend":
			return "a value of another type"
	}
}

/**
 * A schema issue's first place and what fails there, as Standard Schema reads them, each leaf worded by the JSON Schema
 * keyword it breaks: a value of another `type`, a `required` member missing, a member `additionalProperties` refuses,
 * or `oneOf` alternatives matched more than once. A check's own words (`minimum`, `maxItems` and the like) stay
 * Effect's. The body's own value is never in it.
 */
const firstIssue = SchemaIssue.makeFormatterStandardSchemaV1({
	leafHook: (issue) => {
		switch (issue._tag) {
			case "InvalidType":
				return `expected ${expectedType(issue.ast)}`
			case "InvalidValue":
				return "a value the schema does not admit"
			case "MissingKey":
				return "a required member is missing (required)"
			case "UnexpectedKey":
				return "a member the schema does not admit (additionalProperties)"
			case "Forbidden":
				return "a value the schema forbids"
			case "OneOf":
				return "more than one alternative matches (oneOf)"
		}
	}
})

/**
 * Where a body the schema refuses fails first, and what the schema expects there: ` at <JSON pointer>: <expectation>`,
 * the pointer RFC 6901's, or `: <expectation>` at the body's root. The value is not printed: the parse reports no input,
 * so a secret in the body stays out of the message.
 */
const whereRefused = (issue: SchemaIssue.Issue): string =>
	Option.match(Arr.head(firstIssue(issue).issues), {
		onNone: () => "",
		onSome: (first) => {
			const path = Arr.map(first.path ?? [], (step) =>
				JsonPointer.escapeToken(
					typeof step === "object"
						? String(step.key)
						: typeof step === "symbol"
							? (step.description ?? "")
							: String(step)
				)
			)
			return Arr.isReadonlyArrayEmpty(path)
				? `: ${first.message}`
				: ` at /${Arr.join(path, "/")}: ${first.message}`
		}
	})

/**
 * What the merge of the body sources settled on: no body, the operator's bytes as given, or the
 * merged value with its text. Every variant that carries text was asserted against the schema.
 */
type Merged =
	| { readonly _tag: "Empty" }
	| { readonly _tag: "Verbatim"; readonly bytes: Uint8Array; readonly text: string }
	| { readonly _tag: "Merged"; readonly text: string; readonly value: JsonNode }

/**
 * The merge `mergeBody` and `structuredBody` share; `flag` names the source a failure blames, and
 * `parse` is the number-preserving parse that blames it.
 */
const mergeSources = (
	options: BodyOptions
): Effect.Effect<
	{
		readonly merged: Merged
		readonly parse: (text: string) => Effect.Effect<JsonNode, UsageError>
	},
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
	Effect.gen(function* merge() {
		const source = yield* sourceOf(options)
		const flag = Option.match(source, { onNone: () => "body", onSome: (found) => found.flag })
		const overrides = Arr.flatMap(Rec.toEntries(options.fields), ([pointer, field]) =>
			Option.toArray(Option.map(supplied(field), (value) => [pointer, value] as const))
		)
		const guarded =
			<A>(decode: (text: string) => Effect.Effect<A, InvalidJsonText>) =>
			(text: string): Effect.Effect<A, UsageError> =>
				Effect.mapError(decode(text), () => usage(flag, "is not valid JSON"))
		const parse = guarded(decodeRevived)
		const settled = (merged: Merged) => ({ merged, parse })
		const assert = (text: string) =>
			Effect.flatMap(guarded(decodePlain)(text), (value) =>
				Effect.mapError(
					Schema.decodeUnknownEffect(Schema.toType(options.schema), closedObjects)(value),
					(error) =>
						usage(flag, `the request body does not match its schema${whereRefused(error.issue)}`)
				)
			)

		if (Option.isNone(source) && overrides.length === 0 && !options.required) {
			return settled({ _tag: "Empty" })
		}

		if (Option.isSome(source) && overrides.length === 0) {
			const text = yield* decodeText(source.value.bytes, flag)

			yield* assert(text)

			return settled({ _tag: "Verbatim", bytes: source.value.bytes, text })
		}

		const base = Option.isSome(source)
			? yield* decodeText(source.value.bytes, flag).pipe(Effect.flatMap(parse))
			: bare()

		if (!isObject(base)) {
			return yield* usage(flag, "must be a JSON object to take field flags")
		}

		for (const [pointer, text] of Rec.toEntries(options.constants)) {
			const constant = yield* parse(text)
			yield* setAt(base, pointer, constant)
		}

		for (const [pointer, given] of overrides) {
			if (given instanceof SecretField) {
				const secret = yield* readSecret(given)

				yield* setAt(base, pointer, Redacted.value(secret))
				continue
			}

			const value = given instanceof FileField ? yield* readEncoded(given) : given
			if (!hasValidNumbers(value)) {
				return yield* usage(flag, "a number field is not a JSON number")
			}

			yield* setAt(base, pointer, toNode(value))
		}

		const text = jsonText(base)

		yield* assert(text)

		return settled({ _tag: "Merged", text, value: base })
	})

/**
 * The JSON request body from `--body` or `--body-file` and the field flags (design 4.5). Field
 * flags are keyed by RFC 6901 pointer from the body root and override the body; the objects they
 * touch have no prototype, so `__proto__`, `constructor` and `prototype` are ordinary own keys.
 * The merged value is asserted against `schema`, never decoded, and the merged value is what is
 * sent. Without a field flag the operator's bytes are sent verbatim. Otherwise the merged value
 * holds the body's constants, its members that admit one value, before the field flags are set; with
 * no input at all a required body is its constants alone (`{}` when it has none, still asserted) and
 * an optional one is empty. Failures name a flag and never a value or a path.
 */
export const mergeBody = (
	options: BodyOptions
): Effect.Effect<HttpBody.HttpBody, UsageError, FileSystem.FileSystem | Stdio.Stdio | StdinClaim> =>
	mergeSources(options).pipe(
		Effect.map(({ merged }) => {
			if (merged._tag === "Empty") {
				return HttpBody.empty
			}

			return HttpBody.uint8Array(
				merged._tag === "Verbatim" ? merged.bytes : encoder.encode(merged.text)
			)
		})
	)

/**
 * A structured request body (`application/x-www-form-urlencoded`) as the JSON value its encoder
 * takes, merged from the same sources by the same rules and failures as `mergeBody`. Numbers whose
 * text `JSON.parse` would change stay a `JsonNumber`, and objects have no prototype. With no input
 * an optional body is `undefined` and a required one is its constants alone (`{}` when it has none).
 */
export const structuredBody = (
	options: BodyOptions
): Effect.Effect<
	JsonNode | undefined,
	UsageError,
	FileSystem.FileSystem | Stdio.Stdio | StdinClaim
> =>
	mergeSources(options).pipe(
		Effect.flatMap(({ merged, parse }) => {
			if (merged._tag === "Empty") {
				return Effect.undefined
			}

			return merged._tag === "Merged" ? Effect.succeed(merged.value) : parse(merged.text)
		})
	)

/**
 * The `Content-Type` a declared request media key sends: the key itself, or any concrete string
 * when the key is a range (`image/*`), where the operator names the type.
 */
export type SentType<K> = K extends `${string}*${string}` ? string : K

/**
 * The request body alternative `--content-type` chose (design 6.6): the declared key, the
 * `Content-Type` it sends, and the body value for that key. A union over the keys of `V`, so the
 * key narrows the body.
 */
export type Chosen<V> = {
	readonly [P in keyof V & string]: {
		readonly body: V[P]
		readonly contentType: SentType<P>
		readonly key: P
	}
}[keyof V & string]

/**
 * The body flags of one request media key that do not apply to it, each mapped to whether the
 * operator supplied it.
 */
export type ForeignFlags = Readonly<Record<string, boolean>>

/**
 * One request body alternative as `selectBody` runs it: given the `Content-Type` the negotiation
 * chose, its key, the type it sends and its body.
 */
type Chooser = (contentType: string) => Effect.Effect<unknown, unknown, unknown>

/**
 * The effect a chooser returns.
 */
type Returned<F> = F extends (contentType: string) => infer R ? R : never

/**
 * Each alternative of `A` as the chooser it is, read through its own success, failure and
 * services: what lets the picked alternative keep its key's types.
 */
type Choosers<A> = {
	readonly [K in keyof A]: (
		contentType: string
	) => Effect.Effect<
		Effect.Success<Returned<A[K]>>,
		Effect.Error<Returned<A[K]>>,
		Effect.Services<Returned<A[K]>>
	>
}

/**
 * The alternative of an exact media key (`application/json`): it sends the key itself as its
 * `Content-Type`.
 */
export const exactBody =
	<const K extends string, A, E, R>(key: K, body: Effect.Effect<A, E, R>) =>
	(): Effect.Effect<{ readonly body: A; readonly contentType: K; readonly key: K }, E, R> =>
		Effect.map(body, (value) => ({ body: value, contentType: key, key }))

/**
 * The alternative of a range key (`image/*`): it sends the concrete type the operator named
 * inside the range as its `Content-Type`.
 */
export const rangeBody =
	<const K extends string, A, E, R>(key: K, body: Effect.Effect<A, E, R>) =>
	(
		contentType: string
	): Effect.Effect<{ readonly body: A; readonly contentType: string; readonly key: K }, E, R> =>
		Effect.map(body, (value) => ({ body: value, contentType, key }))

/**
 * The request body for the media key `--content-type` selects (design 6.6). `alternatives` maps
 * each declared request media key to its `exactBody` or `rangeBody`, each over its unevaluated body
 * effect, whose value type is that key's own; only the chosen one is run, so the others' flag
 * refusals never fire and stdin is read at most once. `foreign` lists, per key, the body flags that
 * do not apply to it: one the operator supplied is a `UsageError` (exit 2) before any alternative
 * runs, so no input is dropped silently. Returns the chosen key, the `Content-Type` to send, and
 * the body: one member of `Chosen`. A key the media declaration lists without an alternative is a
 * defect of the generated code, not of the operator.
 */
export const selectBody = <A extends Choosers<A>>(options: {
	readonly alternatives: A
	readonly chosen: Option.Option<string>
	readonly foreign?: NoInfer<{ readonly [P in keyof A & string]?: ForeignFlags }>
	readonly media: MediaDeclaration
}): Effect.Effect<
	Effect.Success<Returned<A[keyof A & string]>>,
	UsageError | Effect.Error<Returned<A[keyof A & string]>>,
	Effect.Services<Returned<A[keyof A & string]>>
> =>
	Effect.gen(function* select() {
		const picked = yield* Negotiate.selectRequestMedia(options.media, options.chosen)
		const declared: Readonly<Record<string, Chooser>> = options.alternatives
		const isAlternative = (key: string): key is keyof A & string => Rec.has(declared, key)
		const { contentType, key } = picked

		if (!isAlternative(key)) {
			return yield* Effect.die(
				new Error("selectBody: a declared request media key has no body alternative")
			)
		}

		const foreign: { readonly [key: string]: ForeignFlags | undefined } = options.foreign ?? {}
		const misplaced = Option.flatMap(
			Option.flatMap(Rec.get(foreign, key), Option.fromUndefinedOr),
			(flags) =>
				Option.map(
					Arr.findFirst(Rec.toEntries(flags), ([, given]) => given),
					([flag]) => flag
				)
		)

		if (Option.isSome(misplaced)) {
			return yield* new UsageError({
				flag: misplaced.value,
				message: `--${misplaced.value}: does not apply to --content-type ${key}`
			})
		}

		return yield* options.alternatives[key](contentType)
	})

/**
 * One option flag of a multipart part (design 6.3): its name, whether the operator gave it, and
 * whether a sent part needs it. `--<part>-content-type` is required when its part lists several
 * types (ENC-10).
 */
export type PartOption = readonly [flag: string, given: boolean, required: boolean]

/**
 * Checks a multipart part's option flags against whether the part is sent, before any request: an
 * option given without its part, and a required one missing while the part is sent, are each a
 * `UsageError` naming the option. A given option is never dropped silently.
 */
export const partOptions = (
	part: string,
	sent: boolean,
	options: readonly PartOption[]
): Effect.Effect<void, UsageError> => {
	for (const [flag, given, required] of options) {
		if (given && !sent) {
			return Effect.fail(usage(flag, `applies only with --${part}`))
		}

		if (required && sent && !given) {
			return Effect.fail(usage(flag, `this request needs it when --${part} is given`))
		}
	}

	return Effect.void
}
