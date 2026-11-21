/**
 * What the properties of output-dry-run.test.ts read: worlds of one generated send, each run by the send harness
 * (test/support/send.ts sendIn) as the generated entry runs it, under two schemes, a bearer `bearerAuth` and a header
 * apiKey `apiKey` (`X-Key`); the requirements, refused values, bodies, redacted names and echoes the properties draw;
 * and what the design says each run prints (design 4.6 DM3-8, D-OUT3, 7.5, M3-DR1, hater m3 HB1 and its security
 * review).
 */

import {
	type Aimed,
	aimed,
	array,
	boolean,
	constant,
	element,
	finite,
	type FiniteSpace,
	type Gen,
	increasing,
	int,
	map,
	oneOf,
	option,
	type Space,
	subarray
} from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
	Option,
	Predicate,
	Record as Rec,
	Redacted,
	Ref,
	Result,
	Stream,
	String as Str
} from "effect"
import { HttpBody, HttpClientRequest } from "effect/http"
import type * as Auth from "#runtime-src/runtime/auth.ts"
import { parseJson } from "#runtime-src/runtime/json.ts"
import * as Multipart from "#runtime-src/runtime/multipart.ts"
import type * as Output from "#runtime-src/runtime/output.ts"
import { plainWorld, type Sent, type SendWorld } from "#test/support/send.ts"

/** The bearer scheme's configured credential. */
export const BEARER = "tok-DRY-RUN-SECRET"

/** The apiKey scheme's configured credential. */
const KEY = "key-DRY-RUN-SECRET"

/** The secret file's value a body carries, recorded by the run before it sends. */
export const PASSWORD = "pw-DRY-RUN-SECRET"

/** The two schemes of every world, by name. */
export type Scheme = "bearerAuth" | "apiKey"

const SCHEMES: Arr.NonEmptyReadonlyArray<Scheme> = ["bearerAuth", "apiKey"]

const security: Auth.SecurityTable = {
	schemes: {
		apiKey: { in: "header", kind: "apiKey", name: "X-Key" },
		bearerAuth: { kind: "http", scheme: "bearer" }
	}
}

/** Each scheme's environment variable and the value a configured run gives it. */
const CONFIGURED: Readonly<Record<Scheme, readonly [variable: string, value: string]>> = {
	bearerAuth: ["EXAMPLE_BEARER_AUTH", BEARER],
	apiKey: ["EXAMPLE_API_KEY", KEY]
}

/** The header line a dry run prints where a scheme's credential would go: its placeholder in the scheme's place. */
const PRINTED: Readonly<Record<Scheme, string>> = {
	bearerAuth: "authorization: Bearer <redacted:bearerAuth>",
	apiKey: "x-key: <redacted:apiKey>"
}

/** The bearer scheme's placeholder, the one a dry run of a bearer operation writes. */
const WRITTEN = "<redacted:bearerAuth>"

/** The bare placeholder, which a redacted value that is no placeholder of the run prints as. */
const BARE = "<redacted>"

/** The secret file's placeholder, under the label the run recorded it with. */
const RECORDED_PLACEHOLDER = "<redacted:password-file>"

/** What the run recorded before it sent: the secret file's value. */
const recorded = [
	{ kind: "secret", label: "password-file", value: Redacted.make(PASSWORD) }
] as const

const operation = (
	method: string,
	requirement: ReadonlyArray<ReadonlyArray<Scheme>>
): Output.OperationMeta => ({
	media: { request: [], responses: { "200": ["application/json"] } },
	method,
	operationId: "items-call",
	pathTemplate: "/items",
	security: requirement
})

/** A send of `request` for `operation` under the two schemes, every other part of its world plainWorld's. */
const worldOf = (
	meta: Output.OperationMeta,
	request: HttpClientRequest.HttpClientRequest
): SendWorld => ({ ...plainWorld(meta, request), security })

/** The bearer-secured GET most worlds send. */
const bearerGet = (): SendWorld =>
	worldOf(operation("GET", [["bearerAuth"]]), HttpClientRequest.get("/items"))

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** `size` bytes of one letter: content whose every byte a summary counts and none it prints. */
const filled = (size: number): Uint8Array => new Uint8Array(size).fill(0x46)

/** The request line of a GET of the operation's path, with no query. */
const GET_LINE = "GET https://api.example.com/v1/items HTTP/1.1"

/** The headers every send carries before its credentials, in send order. */
const FIXED_HEADERS: ReadonlyArray<string> = [
	"accept: application/json",
	"user-agent: example/1.2.3"
]

/** A dry run's print of a request with no body: its request line, its header lines, and the blank line. */
const printOf = (requestLine: string, headers: ReadonlyArray<string>): string =>
	`${Arr.join(Arr.prepend(headers, requestLine), "\n")}\n\n`

/** The lines of a text. */
const linesOf = (text: string): ReadonlyArray<string> => Str.split("\n")(text)

/** What a dry run prints after its blank line: the body. */
export const bodyOf = (stdout: string): Option.Option<string> =>
	Option.map(Str.indexOf("\n\n")(stdout), (at) => Str.slice(at + 2)(stdout))

/** What a run showed: how it ended, its two streams, its prompts, and how many requests it sent. */
export type Seen = Readonly<{
	exit: "Success" | "Failure"
	stdout: string
	stderr: string
	prompts: number
	requests: number
}>

export const seenOf = (sent: Sent): Seen => ({
	exit: sent.exit._tag,
	stdout: sent.stdout,
	stderr: sent.stderr,
	prompts: sent.prompts,
	requests: sent.requests.length
})

/** A requirement's alternatives: `{}`, each scheme alone, and both in either order. */
const ALTERNATIVES = [
	[],
	["bearerAuth"],
	["apiKey"],
	["bearerAuth", "apiKey"],
	["apiKey", "bearerAuth"]
] as const

/** A dry run's credential world: the operation's requirement, the schemes configured, and whether it runs on a terminal. */
export type Preview = Readonly<{
	requirement: ReadonlyArray<ReadonlyArray<Scheme>>
	configured: ReadonlyArray<Scheme>
	terminal: boolean
}>

/** Every requirement of at most two alternatives, under every set of configured schemes, on a terminal and off one. */
export const previews: FiniteSpace<Preview> = finite((s) => ({
	requirement: s.draw(array(element(ALTERNATIVES), { min: 0, max: 2 })),
	configured: s.draw(subarray(SCHEMES)),
	terminal: s.draw(boolean)
}))

export const previewWorld = (preview: Preview): SendWorld => ({
	...worldOf(operation("GET", preview.requirement), HttpClientRequest.get("/items")),
	env: Rec.fromEntries(Arr.map(preview.configured, (scheme) => CONFIGURED[scheme])),
	tty: preview.terminal,
	dryRun: true
})

const isConfigured =
	(preview: Preview) =>
	(alternative: ReadonlyArray<Scheme>): boolean =>
		Arr.isReadonlyArrayNonEmpty(alternative) &&
		Arr.every(alternative, (scheme) => Arr.contains(preview.configured, scheme))

/** With no alternative configured: none when no requirement or a `{}` allows anonymous access, else the first. */
const unconfigured = (requirement: ReadonlyArray<ReadonlyArray<Scheme>>): ReadonlyArray<Scheme> =>
	Arr.match(requirement, {
		onEmpty: () => [],
		onNonEmpty: (alternatives) =>
			Arr.some(alternatives, Arr.isReadonlyArrayEmpty) ? [] : Arr.headNonEmpty(alternatives)
	})

/**
 * The alternative a dry run shows (design 4.6, D-OUT3, 6.5 Run-time choice): the first that names a scheme and has
 * every scheme configured, else `unconfigured`'s.
 */
const shownAlternative = (preview: Preview): ReadonlyArray<Scheme> =>
	Option.getOrElse(Arr.findFirst(preview.requirement, isConfigured(preview)), () =>
		unconfigured(preview.requirement)
	)

/**
 * What a dry run of the world shows: the request line, the fixed headers and the shown alternative's placeholders in its
 * order, an empty body; nothing on stderr, no prompt, nothing sent, and a success, configured or not.
 */
export const expectedPreview = (preview: Preview): Seen => ({
	exit: "Success",
	stdout: printOf(
		GET_LINE,
		Arr.appendAll(
			FIXED_HEADERS,
			Arr.map(shownAlternative(preview), (scheme) => PRINTED[scheme])
		)
	),
	stderr: "",
	prompts: 0,
	requests: 0
})

export type PreviewFeature =
	| "a configured alternative"
	| "a configured alternative after one that is not"
	| "a configured alternative past {}"
	| "the first alternative, unconfigured"
	| "anonymous access"
	| "two schemes at once"
	| "a terminal"

export const PREVIEW_FEATURES: ReadonlyArray<PreviewFeature> = [
	"a configured alternative",
	"a configured alternative after one that is not",
	"a configured alternative past {}",
	"the first alternative, unconfigured",
	"anonymous access",
	"two schemes at once",
	"a terminal"
]

const when = <F extends string>(holds: boolean, feature: F): ReadonlyArray<F> =>
	holds ? [feature] : []

export const previewFeatures = (preview: Preview): ReadonlyArray<PreviewFeature> => {
	const configuredAt = Arr.findFirstIndex(preview.requirement, isConfigured(preview))
	const before = Option.match(configuredAt, {
		onNone: () => [],
		onSome: (at) => Arr.take(preview.requirement, at)
	})
	const shown = shownAlternative(preview)
	return [
		...when(Option.isSome(configuredAt), "a configured alternative"),
		...when(
			Arr.some(before, Arr.isReadonlyArrayNonEmpty),
			"a configured alternative after one that is not"
		),
		...when(Arr.some(before, Arr.isReadonlyArrayEmpty), "a configured alternative past {}"),
		...when(
			Option.isNone(configuredAt) && Arr.isReadonlyArrayNonEmpty(shown),
			"the first alternative, unconfigured"
		),
		...when(Option.isNone(configuredAt) && Arr.isReadonlyArrayEmpty(shown), "anonymous access"),
		...when(shown.length === 2, "two schemes at once"),
		...when(preview.terminal, "a terminal")
	]
}

/** How a configured value is one the real run refuses (design 6.5: a header value is a token of Latin-1 text). */
export type Flaw =
	| "a CR"
	| "a LF"
	| "a NUL"
	| "a code point above U+00FF"
	| "an astral code point"
	| "leading whitespace"
	| "trailing whitespace"

export const FLAWS: Arr.NonEmptyReadonlyArray<Flaw> = [
	"a CR",
	"a LF",
	"a NUL",
	"a code point above U+00FF",
	"an astral code point",
	"leading whitespace",
	"trailing whitespace"
]

/** The text a refused value carries after its flaw: a header it would inject, which no output may show. */
export const INJECTED = "X-Evil: 1"

/** A value with the flaw: the flaw where it stands, the value's text around it, the injected header after it. */
const flawed = (flaw: Flaw): string => {
	switch (flaw) {
		case "a CR":
			return `Q7Z9\r${INJECTED}`
		case "a LF":
			return `Q7Z9\n${INJECTED}`
		case "a NUL":
			return `Q7Z9\u0000${INJECTED}`
		case "a code point above U+00FF":
			return `Q7Z9Ā${INJECTED}`
		case "an astral code point":
			return `Q7Z9\u{1F511}${INJECTED}`
		case "leading whitespace":
			return ` Q7Z9${INJECTED}`
		case "trailing whitespace":
			return `Q7Z9${INJECTED} `
	}
}

/** A configured credential the real run refuses: its scheme, and its flaw. */
export type Refusal = Readonly<{ scheme: Scheme; flaw: Flaw }>

/** Every flaw, in each scheme's configured credential. */
export const refusals: FiniteSpace<Refusal> = finite((s) => ({
	scheme: s.draw(element(SCHEMES)),
	flaw: s.draw(element(FLAWS))
}))

/** A real run of the refused world; the property runs it again as a dry run. */
export const refusedWorld = (refusal: Refusal): SendWorld => {
	const [variable] = CONFIGURED[refusal.scheme]
	return {
		...worldOf(operation("GET", [[refusal.scheme]]), HttpClientRequest.get("/items")),
		env: { [variable]: flawed(refusal.flaw) }
	}
}

/** A secret a drawn text carries: the recorded secret-file value, or the configured bearer credential. */
export type Secret = "recorded" | "credential"

/**
 * A stretch of a drawn text: maybe a secret, then plain text. Plain text follows every secret, so no two secrets touch:
 * how touching occurrences merge is the scrub's own law (redact.test.ts), and a streamed scrub's cuts decide it.
 */
export type Segment = Readonly<{ secret: Option.Option<Secret>; plain: string }>

/** A drawn text, one segment or more. */
export type Text = Arr.NonEmptyReadonlyArray<Segment>

/** Plain text, from characters neither secret begins with, so no plain run is part of one. */
const PLAIN: Arr.NonEmptyReadonlyArray<string> = [
	"id",
	"name",
	"{",
	"}",
	":",
	",",
	" ",
	'"',
	"1",
	"\n"
]

const SECRETS: Arr.NonEmptyReadonlyArray<Secret> = ["recorded", "credential"]

const segment = (secret: Option.Option<Secret>, plain: string): Segment => ({ secret, plain })

const segments: Gen<Segment> = (s) => ({
	secret: s.draw(option(element(SECRETS))),
	plain: Arr.join(s.draw(array(element(PLAIN), { min: 1, max: 2 })), "")
})

const texts: Gen<Text> = (s) => [s.draw(segments), ...s.draw(array(segments, { min: 0, max: 3 }))]

const SECRET_TEXT: Readonly<Record<Secret, string>> = { recorded: PASSWORD, credential: BEARER }

const SECRET_PLACEHOLDER: Readonly<Record<Secret, string>> = {
	recorded: RECORDED_PLACEHOLDER,
	credential: WRITTEN
}

const segmentText =
	(spelled: Readonly<Record<Secret, string>>) =>
	(stretch: Segment): string =>
		`${Option.match(stretch.secret, { onNone: () => "", onSome: (secret) => spelled[secret] })}${stretch.plain}`

const textOf = (text: Text): string => Arr.join(Arr.map(text, segmentText(SECRET_TEXT)), "")

/** A text as a dry run prints it (redact.ts scrub): each secret its placeholder. */
const shownText = (text: Text): string =>
	Arr.join(Arr.map(text, segmentText(SECRET_PLACEHOLDER)), "")

/** A text body's print, its last line ended (output.ts endWithNewline). */
const endedLine = (text: string): string => (Str.endsWith("\n")(text) ? text : `${text}\n`)

/** Where a streamed text is cut into chunks: a cut at or past its end cuts nothing. */
const cuts: Gen<ReadonlyArray<number>> = increasing(1, 64, { min: 0, max: 3 })

/** A text cut into the chunks a stream delivers it in. */
const chunksOf = (text: string, at: ReadonlyArray<number>): ReadonlyArray<Uint8Array> => {
	const inside = Arr.filter(at, (cut) => cut < text.length)
	const starts = Arr.prepend(inside, 0)
	const ends = Arr.append(inside, text.length)
	return Arr.map(Arr.zip(starts, ends), ([start, end]) => bytes(Str.slice(start, end)(text)))
}

/** A media type a body prints as text (output.ts printsAsText: text-family or sequential), and one it does not. */
type TextMedia = "application/json" | "text/plain" | "application/x-ndjson"

type BinaryMedia = "application/octet-stream" | "image/png"

const TEXT_MEDIA: Arr.NonEmptyReadonlyArray<TextMedia> = [
	"application/json",
	"text/plain",
	"application/x-ndjson"
]

const BINARY_MEDIA: Arr.NonEmptyReadonlyArray<BinaryMedia> = [
	"application/octet-stream",
	"image/png"
]

/** A media type a multipart part prints as text (output.ts isText: text-family alone). */
type PartTextMedia = "application/json" | "text/plain"

const PART_TEXT_MEDIA: Arr.NonEmptyReadonlyArray<PartTextMedia> = ["application/json", "text/plain"]

/** A part of a multipart body: a text part, a file, or a binary part with no filename. */
export type Part =
	| Readonly<{
			kind: "text"
			name: string
			media: PartTextMedia
			text: Text
			cuts: ReadonlyArray<number>
	  }>
	| Readonly<{
			kind: "file"
			name: string
			filename: string
			media: PartTextMedia | BinaryMedia
			size: number
	  }>
	| Readonly<{ kind: "binary"; name: string; media: BinaryMedia; size: number }>

/** A request body as a generated CLI builds one: in memory, from a file, from stdin, or multipart. */
export type Body =
	| Readonly<{ kind: "text in memory"; media: TextMedia; text: Text }>
	| Readonly<{
			kind: "text from a file"
			media: TextMedia
			text: Text
			cuts: ReadonlyArray<number>
	  }>
	| Readonly<{ kind: "stdin"; media: TextMedia | BinaryMedia }>
	| Readonly<{ kind: "binary in memory"; size: number }>
	| Readonly<{ kind: "binary from a file"; media: BinaryMedia; size: number }>
	| Readonly<{ kind: "multipart"; parts: Arr.NonEmptyReadonlyArray<Part> }>

const NAMES: Arr.NonEmptyReadonlyArray<string> = ["meta", "note", "file"]

const FILENAMES: Arr.NonEmptyReadonlyArray<string> = ["photo.png", "dir/a.txt"]

const sizes: Gen<number> = int(1, 64)

const parts: Gen<Part> = oneOf<Part>([
	(s) => ({
		kind: "text",
		name: s.draw(element(NAMES)),
		media: s.draw(element(PART_TEXT_MEDIA)),
		text: s.draw(texts),
		cuts: s.draw(cuts)
	}),
	(s) => ({
		kind: "file",
		name: s.draw(element(NAMES)),
		filename: s.draw(element(FILENAMES)),
		media: s.draw(element([...PART_TEXT_MEDIA, ...BINARY_MEDIA])),
		size: s.draw(sizes)
	}),
	(s) => ({
		kind: "binary",
		name: s.draw(element(NAMES)),
		media: s.draw(element(BINARY_MEDIA)),
		size: s.draw(sizes)
	})
])

const bodies: Space<Body> = oneOf<Body>([
	(s) => ({ kind: "text in memory", media: s.draw(element(TEXT_MEDIA)), text: s.draw(texts) }),
	(s) => ({
		kind: "text from a file",
		media: s.draw(element(TEXT_MEDIA)),
		text: s.draw(texts),
		cuts: s.draw(cuts)
	}),
	(s) => ({ kind: "stdin", media: s.draw(element([...TEXT_MEDIA, ...BINARY_MEDIA])) }),
	map(sizes, (size): Body => ({ kind: "binary in memory", size })),
	(s) => ({
		kind: "binary from a file",
		media: s.draw(element(BINARY_MEDIA)),
		size: s.draw(sizes)
	}),
	(s) => ({
		kind: "multipart",
		parts: [s.draw(parts), ...s.draw(array(parts, { min: 0, max: 2 }))]
	})
])

export type BodyFeature =
	| "a text body in memory"
	| "a text body from a file"
	| "a sequential body"
	| "a text body from stdin"
	| "a binary body from stdin"
	| "a binary body in memory"
	| "a binary body from a file"
	| "a multipart text part"
	| "a multipart file part"
	| "a multipart binary part"
	| "a recorded value cut across chunks"
	| "a credential cut across chunks"

export const BODY_FEATURES: ReadonlyArray<BodyFeature> = [
	"a text body in memory",
	"a text body from a file",
	"a sequential body",
	"a text body from stdin",
	"a binary body from stdin",
	"a binary body in memory",
	"a binary body from a file",
	"a multipart text part",
	"a multipart file part",
	"a multipart binary part",
	"a recorded value cut across chunks",
	"a credential cut across chunks"
]

/** Each secret's span in its text, half-open. */
const secretSpansOf = (
	text: Text
): ReadonlyArray<readonly [secret: Secret, start: number, end: number]> =>
	Arr.flatten(
		Arr.mapAccum(text, 0, (start, stretch) => {
			const end = start + segmentText(SECRET_TEXT)(stretch).length
			return [
				end,
				Option.match(stretch.secret, {
					onNone: () => [],
					onSome: (secret) => [[secret, start, start + SECRET_TEXT[secret].length] as const]
				})
			]
		})[1]
	)

/** The features of a text and the cuts its stream is delivered with. */
const textFeatures = (text: Text, at: ReadonlyArray<number>): ReadonlyArray<BodyFeature> => {
	const cutInside = (kind: Secret) =>
		Arr.some(
			secretSpansOf(text),
			([secret, start, end]) => secret === kind && Arr.some(at, (cut) => start < cut && cut < end)
		)
	return [
		...when(cutInside("recorded"), "a recorded value cut across chunks"),
		...when(cutInside("credential"), "a credential cut across chunks")
	]
}

const partFeatures = (part: Part): ReadonlyArray<BodyFeature> => {
	switch (part.kind) {
		case "text":
			return Arr.prepend(textFeatures(part.text, part.cuts), "a multipart text part")
		case "file":
			return ["a multipart file part"]
		case "binary":
			return ["a multipart binary part"]
	}
}

const isTextMedia = (media: TextMedia | BinaryMedia): media is TextMedia =>
	Arr.contains(TEXT_MEDIA, media)

export const bodyFeatures = (body: Body): ReadonlyArray<BodyFeature> => {
	switch (body.kind) {
		case "text in memory":
			return [
				"a text body in memory",
				...when(body.media === "application/x-ndjson", "a sequential body"),
				...textFeatures(body.text, [])
			]
		case "text from a file":
			return [
				"a text body from a file",
				...when(body.media === "application/x-ndjson", "a sequential body"),
				...textFeatures(body.text, body.cuts)
			]
		case "stdin":
			return isTextMedia(body.media) ? ["a text body from stdin"] : ["a binary body from stdin"]
		case "binary in memory":
			return ["a binary body in memory"]
		case "binary from a file":
			return ["a binary body from a file"]
		case "multipart":
			return Arr.dedupe(Arr.flatMap(body.parts, partFeatures))
	}
}

/** Cuts inside each secret of a text. */
const cutText = (text: Text): ReadonlyArray<number> =>
	Arr.map(secretSpansOf(text), ([, start, end]) => start + Math.floor((end - start) / 2))

const recordedThen = (plain: string): Segment => segment(Option.some("recorded"), plain)

const credentialThen = (plain: string): Segment => segment(Option.some("credential"), plain)

const plainOf = (plain: string): Segment => segment(Option.none(), plain)

const textPart = (text: Text): Part => ({
	kind: "text",
	name: "note",
	media: "text/plain",
	text,
	cuts: cutText(text)
})

const fileBody = (text: Text, media: TextMedia): Body => ({
	kind: "text from a file",
	media,
	text,
	cuts: cutText(text)
})

/** Bodies, aimed at each pending situation by one built to reach it. */
export const aimedBodies: Aimed<Body, BodyFeature> = aimed(bodies, [
	[
		"a text body in memory",
		constant<Body>({
			kind: "text in memory",
			media: "application/json",
			text: [plainOf("{"), recordedThen("}")]
		})
	],
	[
		"a text body from a file",
		constant(fileBody([plainOf("id"), credentialThen(" ")], "text/plain"))
	],
	[
		"a sequential body",
		constant(fileBody([plainOf("{"), recordedThen("}\n")], "application/x-ndjson"))
	],
	["a text body from stdin", constant<Body>({ kind: "stdin", media: "application/json" })],
	[
		"a binary body from stdin",
		constant<Body>({ kind: "stdin", media: "application/octet-stream" })
	],
	["a binary body in memory", constant<Body>({ kind: "binary in memory", size: 7 })],
	[
		"a binary body from a file",
		constant<Body>({ kind: "binary from a file", media: "image/png", size: 7 })
	],
	[
		"a multipart text part",
		constant<Body>({
			kind: "multipart",
			parts: [textPart([plainOf("name"), recordedThen(" "), credentialThen("1")])]
		})
	],
	[
		"a multipart file part",
		constant<Body>({
			kind: "multipart",
			parts: [{ kind: "file", name: "file", filename: "photo.png", media: "image/png", size: 7 }]
		})
	],
	[
		"a multipart binary part",
		constant<Body>({
			kind: "multipart",
			parts: [{ kind: "binary", name: "file", media: "application/octet-stream", size: 3 }]
		})
	],
	[
		"a recorded value cut across chunks",
		constant(fileBody([plainOf("id"), recordedThen("1")], "text/plain"))
	],
	["a credential cut across chunks", constant(fileBody([credentialThen(",")], "application/json"))]
])

const BOUNDARY = "BOUNDARY"

const partOf = (part: Part): Multipart.Part => {
	switch (part.kind) {
		case "text":
			return {
				body: Stream.fromIterable(chunksOf(textOf(part.text), part.cuts)),
				contentType: part.media,
				name: part.name
			}
		case "file":
			return {
				body: Stream.make(filled(part.size)),
				contentType: part.media,
				filename: part.filename,
				name: part.name
			}
		case "binary":
			return { body: filled(part.size), contentType: part.media, name: part.name }
	}
}

/** The body's request, its stdin a stream that records whether anything read it. */
const bodyRequest = (body: Body, read: Ref.Ref<boolean>) => {
	const post = HttpClientRequest.post("/items")
	const streamed = (stream: Stream.Stream<Uint8Array>, media: string, length: number) =>
		Effect.succeed(HttpClientRequest.setBody(post, HttpBody.stream(stream, media, length)))
	switch (body.kind) {
		case "text in memory":
			return Effect.succeed(HttpClientRequest.bodyText(post, textOf(body.text), body.media))
		case "text from a file": {
			const text = textOf(body.text)
			return streamed(
				Stream.fromIterable(chunksOf(text, body.cuts)),
				body.media,
				bytes(text).length
			)
		}
		case "stdin":
			return Effect.succeed(
				HttpClientRequest.setBody(
					post,
					HttpBody.stream(
						Stream.fromEffect(Effect.as(Ref.set(read, true), bytes("stdin"))),
						body.media
					)
				)
			)
		case "binary in memory":
			return Effect.succeed(
				HttpClientRequest.bodyUint8Array(post, filled(body.size), "application/octet-stream")
			)
		case "binary from a file":
			return streamed(Stream.make(filled(body.size)), body.media, body.size)
		case "multipart":
			return Effect.map(
				Multipart.formData(Arr.map(body.parts, partOf), Option.some(BOUNDARY)),
				(multipart) => HttpClientRequest.setBody(post, multipart)
			)
	}
}

/** A dry run of the body, sent by a run that configured the bearer credential and recorded the secret file's value. */
export const bodyWorld = (body: Body, read: Ref.Ref<boolean>) =>
	Effect.map(bodyRequest(body, read), (request): SendWorld => ({
		...worldOf(operation("POST", [["bearerAuth"]]), request),
		env: { EXAMPLE_BEARER_AUTH: BEARER },
		recorded,
		dryRun: true
	}))

const partHead = (part: Part): string => {
	const disposition = `Content-Disposition: form-data; name="${part.name}"`
	return part.kind === "file"
		? `${disposition}; filename="${part.filename}"\r\nContent-Type: ${part.media}`
		: `${disposition}\r\nContent-Type: ${part.media}`
}

/** A part's content as a dry run prints it: a text part scrubbed, a file or binary part summarized by its size. */
const partShown = (part: Part): string => {
	switch (part.kind) {
		case "text":
			return shownText(part.text)
		case "file":
			return `<file ${part.filename}, ${part.size} bytes>`
		case "binary":
			return `<binary part, ${part.size} bytes>`
	}
}

/**
 * What a dry run prints for a body (design 4.6 DM3-8, output.ts dryRunBody): a text body its text with every secret
 * its placeholder; a body from stdin `<body from stdin>` for a text media type, `<binary body from stdin>` for any other,
 * never read; a binary body `<binary body, N bytes>`; a multipart body its delimiters and part heads as written, each
 * text part scrubbed, a file part `<file <filename>, N bytes>` and a binary part `<binary part, N bytes>`. Its last line
 * is ended.
 */
export const expectedBody = (body: Body): string => {
	switch (body.kind) {
		case "text in memory":
		case "text from a file":
			return endedLine(shownText(body.text))
		case "stdin":
			return isTextMedia(body.media) ? "<body from stdin>\n" : "<binary body from stdin>\n"
		case "binary in memory":
		case "binary from a file":
			return `<binary body, ${body.size} bytes>\n`
		case "multipart":
			return `${Arr.join(
				Arr.map(
					body.parts,
					(part) => `--${BOUNDARY}\r\n${partHead(part)}\r\n\r\n${partShown(part)}\r\n`
				),
				""
			)}--${BOUNDARY}--\r\n`
	}
}

/** A value a request carries under a name a dry run may redact. */
export type Carried =
	| "a canary"
	| "the run's placeholder"
	| "the run's placeholder after Bearer"
	| "another scheme's placeholder"

const CANARY = "canary-Q1"

const CARRIED: Readonly<Record<Carried, string>> = {
	"a canary": CANARY,
	"the run's placeholder": WRITTEN,
	"the run's placeholder after Bearer": "Bearer <redacted:bearerAuth>",
	"another scheme's placeholder": "<redacted:apiKey>"
}

const CARRIED_VALUES: Arr.NonEmptyReadonlyArray<Carried> = [
	"a canary",
	"the run's placeholder",
	"the run's placeholder after Bearer",
	"another scheme's placeholder"
]

/** A pair of a Cookie header: a name and a value, or a bare value with no `=`. */
export type CookiePair =
	| Readonly<{ kind: "pair"; name: string; carried: Carried }>
	| Readonly<{ kind: "bare" }>

/**
 * A query parameter: a `Redacted` value under any name; a plain value under a name the run redacts (`sig`,
 * `Signature`: Effect's UrlParams.CurrentRedactedNames); or a plain value under a name it does not, one whose query
 * wire form is itself.
 */
export type QueryEntry =
	| Readonly<{ held: "Redacted"; name: "sig" | "note"; carried: Carried }>
	| Readonly<{ held: "plain"; name: "sig" | "Signature"; carried: Carried }>
	| Readonly<{ held: "plain"; name: "note"; carried: "a canary" | "the run's placeholder" }>

/** A header the request carries: under a name the run redacts (`x-api-key`, Effect's default), or under a plain one. */
export type CarriedHeader = Readonly<{ name: "x-api-key" | "x-trace"; carried: Carried }>

/** What a bearer GET carries beside its own headers: a header, a Cookie's pairs (none, no Cookie), and query parameters. */
export type Decorated = Readonly<{
	header: Option.Option<CarriedHeader>
	cookie: ReadonlyArray<CookiePair>
	query: ReadonlyArray<QueryEntry>
}>

const carriedGen: Gen<Carried> = element(CARRIED_VALUES)

const queryEntries: Gen<QueryEntry> = oneOf<QueryEntry>([
	(s) => ({
		held: "Redacted",
		name: s.draw(element(["sig", "note"])),
		carried: s.draw(carriedGen)
	}),
	(s) => ({
		held: "plain",
		name: s.draw(element(["sig", "Signature"])),
		carried: s.draw(carriedGen)
	}),
	(s) => ({
		held: "plain",
		name: "note",
		carried: s.draw(element(["a canary", "the run's placeholder"]))
	})
])

const cookiePairs: Gen<CookiePair> = oneOf<CookiePair>([
	(s) => ({ kind: "pair", name: s.draw(element(["a", "session"])), carried: s.draw(carriedGen) }),
	constant<CookiePair>({ kind: "bare" })
])

const decorations: Space<Decorated> = (s) => ({
	header: s.draw(
		option((h): CarriedHeader => ({
			name: h.draw(element(["x-api-key", "x-trace"])),
			carried: h.draw(carriedGen)
		}))
	),
	cookie: s.draw(array(cookiePairs, { min: 0, max: 3 })),
	query: s.draw(array(queryEntries, { min: 0, max: 3 }))
})

const cookieText = (pair: CookiePair): string =>
	pair.kind === "bare" ? CANARY : `${pair.name}=${CARRIED[pair.carried]}`

/** The bearer GET carrying the decoration, its query parameters, then its Cookie, then its header. */
export const decoratedWorld = (decorated: Decorated): SendWorld => {
	const withQuery = Arr.reduce(decorated.query, HttpClientRequest.get("/items"), (request, entry) =>
		HttpClientRequest.appendUrlParam(
			request,
			entry.name,
			entry.held === "Redacted" ? Redacted.make(CARRIED[entry.carried]) : CARRIED[entry.carried]
		)
	)
	const withCookie = Arr.isReadonlyArrayNonEmpty(decorated.cookie)
		? HttpClientRequest.setHeader(
				withQuery,
				"cookie",
				Arr.join(Arr.map(decorated.cookie, cookieText), "; ")
			)
		: withQuery
	const request = Option.match(decorated.header, {
		onNone: () => withCookie,
		onSome: (header) =>
			HttpClientRequest.setHeader(withCookie, header.name, CARRIED[header.carried])
	})
	return { ...worldOf(operation("GET", [["bearerAuth"]]), request), dryRun: true }
}

/** A value under a redacted name as a dry run prints it: itself when it is exactly one of `kept`, else bare. */
const redactedUnless = (carried: Carried, kept: ReadonlyArray<Carried>): string =>
	Arr.contains(kept, carried) ? CARRIED[carried] : BARE

const queryShown = (entry: QueryEntry): string => {
	switch (entry.held) {
		case "Redacted":
			return `${entry.name}=${BARE}`
		case "plain":
			return entry.name === "note"
				? `note=${CARRIED[entry.carried]}`
				: `${entry.name}=${redactedUnless(entry.carried, ["the run's placeholder"])}`
	}
}

const cookieShown = (pair: CookiePair): string =>
	pair.kind === "bare"
		? BARE
		: `${pair.name}=${redactedUnless(pair.carried, ["the run's placeholder"])}`

const headerShown = (header: CarriedHeader): string =>
	header.name === "x-api-key"
		? `x-api-key: ${redactedUnless(header.carried, ["the run's placeholder", "the run's placeholder after Bearer"])}`
		: `x-trace: ${CARRIED[header.carried]}`

/**
 * What a dry run prints for the decorated GET (design 4.6, 7.5): a `Redacted` query value as `<redacted>`; a plain
 * value under a redacted name as `<redacted>` unless it is exactly the run's own placeholder; a value under a redacted
 * header name as `<redacted>` unless it is exactly a placeholder form of the run's own (`<redacted:bearerAuth>`, after
 * `Bearer` or `Basic`); a Cookie pair by pair, a pair kept only when its value is exactly the run's placeholder and a
 * bare pair `<redacted>`; and every value under a plain name as it is. The bearer scheme's placeholder follows the
 * fixed headers.
 */
export const expectedDecorated = (decorated: Decorated): string => {
	const query = Arr.match(decorated.query, {
		onEmpty: () => "",
		onNonEmpty: (entries) => `?${Arr.join(Arr.map(entries, queryShown), "&")}`
	})
	const cookie = Arr.match(decorated.cookie, {
		onEmpty: (): ReadonlyArray<string> => [],
		onNonEmpty: (pairs) => [`cookie: ${Arr.join(Arr.map(pairs, cookieShown), "; ")}`]
	})
	return printOf(`GET https://api.example.com/v1/items${query} HTTP/1.1`, [
		...cookie,
		...Option.toArray(Option.map(decorated.header, headerShown)),
		...FIXED_HEADERS,
		PRINTED.bearerAuth
	])
}

export type DecoratedFeature =
	| "a redacted header kept as a placeholder form"
	| "a redacted header hidden"
	| "a plain header shown"
	| "a cookie pair kept"
	| "a cookie pair hidden"
	| "a bare cookie pair"
	| "another scheme's placeholder hidden"
	| "a Redacted query value"
	| "a query value under a redacted name hidden"
	| "a query placeholder kept"
	| "a plain query value shown"

export const DECORATED_FEATURES: ReadonlyArray<DecoratedFeature> = [
	"a redacted header kept as a placeholder form",
	"a redacted header hidden",
	"a plain header shown",
	"a cookie pair kept",
	"a cookie pair hidden",
	"a bare cookie pair",
	"another scheme's placeholder hidden",
	"a Redacted query value",
	"a query value under a redacted name hidden",
	"a query placeholder kept",
	"a plain query value shown"
]

const headerFeatures = (header: CarriedHeader): ReadonlyArray<DecoratedFeature> => {
	if (header.name === "x-trace") {
		return ["a plain header shown"]
	}
	return header.carried === "the run's placeholder" ||
		header.carried === "the run's placeholder after Bearer"
		? ["a redacted header kept as a placeholder form"]
		: [
				"a redacted header hidden",
				...when(
					header.carried === "another scheme's placeholder",
					"another scheme's placeholder hidden"
				)
			]
}

const pairFeatures = (pair: CookiePair): ReadonlyArray<DecoratedFeature> => {
	if (pair.kind === "bare") {
		return ["a bare cookie pair"]
	}
	return pair.carried === "the run's placeholder"
		? ["a cookie pair kept"]
		: [
				"a cookie pair hidden",
				...when(
					pair.carried === "another scheme's placeholder",
					"another scheme's placeholder hidden"
				)
			]
}

const queryFeatures = (entry: QueryEntry): ReadonlyArray<DecoratedFeature> => {
	switch (entry.held) {
		case "Redacted":
			return ["a Redacted query value"]
		case "plain":
			if (entry.name === "note") {
				return ["a plain query value shown"]
			}
			return entry.carried === "the run's placeholder"
				? ["a query placeholder kept"]
				: [
						"a query value under a redacted name hidden",
						...when(
							entry.carried === "another scheme's placeholder",
							"another scheme's placeholder hidden"
						)
					]
	}
}

export const decoratedFeatures = (decorated: Decorated): ReadonlyArray<DecoratedFeature> =>
	Arr.dedupe([
		...Arr.flatMap(Option.toArray(decorated.header), headerFeatures),
		...Arr.flatMap(decorated.cookie, pairFeatures),
		...Arr.flatMap(decorated.query, queryFeatures)
	])

const only = (decorated: Partial<Decorated>): Space<Decorated> =>
	constant<Decorated>({ header: Option.none(), cookie: [], query: [], ...decorated })

/** Decorations, aimed at each pending situation by one built to reach it. */
export const aimedDecorations: Aimed<Decorated, DecoratedFeature> = aimed(decorations, [
	[
		"a redacted header kept as a placeholder form",
		only({
			header: Option.some({ name: "x-api-key", carried: "the run's placeholder after Bearer" })
		})
	],
	[
		"a redacted header hidden",
		only({ header: Option.some({ name: "x-api-key", carried: "a canary" }) })
	],
	["a plain header shown", only({ header: Option.some({ name: "x-trace", carried: "a canary" }) })],
	[
		"a cookie pair kept",
		only({
			cookie: [
				{ kind: "pair", name: "a", carried: "the run's placeholder" },
				{ kind: "pair", name: "session", carried: "a canary" }
			]
		})
	],
	[
		"a cookie pair hidden",
		only({ cookie: [{ kind: "pair", name: "session", carried: "a canary" }] })
	],
	["a bare cookie pair", only({ cookie: [{ kind: "bare" }] })],
	[
		"another scheme's placeholder hidden",
		only({ cookie: [{ kind: "pair", name: "a", carried: "another scheme's placeholder" }] })
	],
	[
		"a Redacted query value",
		only({ query: [{ held: "Redacted", name: "note", carried: "a canary" }] })
	],
	[
		"a query value under a redacted name hidden",
		only({ query: [{ held: "plain", name: "sig", carried: "a canary" }] })
	],
	[
		"a query placeholder kept",
		only({ query: [{ held: "plain", name: "Signature", carried: "the run's placeholder" }] })
	],
	[
		"a plain query value shown",
		only({ query: [{ held: "plain", name: "note", carried: "a canary" }] })
	]
])

/** Where a run prints a one-character credential's surroundings. */
export type OutputPath = "a dry run" | "a verbose send" | "a JSON error"

export const OUTPUT_PATHS: Arr.NonEmptyReadonlyArray<OutputPath> = [
	"a dry run",
	"a verbose send",
	"a JSON error"
]

/** The letters of the runtime's own output: its placeholders, its fixed headers, its request line and its errors. */
const LETTERS: Arr.NonEmptyReadonlyArray<string> = [
	"a",
	"e",
	"r",
	"d",
	"c",
	"t",
	"B",
	"A",
	"u",
	"h",
	"o",
	"i",
	"n",
	"x",
	"p",
	"l",
	"m",
	"s",
	"j"
]

/** A one-character credential, shorter than every placeholder, configured for the bearer scheme, and a path it prints on. */
export type OneCharacter = Readonly<{ path: OutputPath; credential: string }>

/** Every letter of the runtime's own output as the credential, on each path. */
export const oneCharacters: FiniteSpace<OneCharacter> = finite((s) => ({
	path: s.draw(element(OUTPUT_PATHS)),
	credential: s.draw(element(LETTERS))
}))

/** The world of a one-character run: a dry run of a JSON POST, a verbose GET answered 200, or a GET refused 400 under JSON errors. */
export const oneCharacterWorld = (one: OneCharacter): SendWorld => {
	switch (one.path) {
		case "a dry run":
			return {
				...worldOf(
					operation("POST", [["bearerAuth"]]),
					HttpClientRequest.post("/items").pipe(
						HttpClientRequest.bodyText('{"name":"a"}', "application/json")
					)
				),
				env: { EXAMPLE_BEARER_AUTH: one.credential },
				dryRun: true
			}
		case "a verbose send":
			return { ...bearerGet(), env: { EXAMPLE_BEARER_AUTH: one.credential }, verbose: true }
		case "a JSON error":
			return {
				...bearerGet(),
				env: { EXAMPLE_BEARER_AUTH: one.credential, EXAMPLE_ERROR_FORMAT: "json" },
				reply: () =>
					new Response(`{"error":"bad token ${one.credential}","hint":"${WRITTEN}"}`, {
						headers: { "content-type": "application/json" },
						status: 400
					})
			}
	}
}

/** A failed run's JSON error, the fields the properties read: its keys, `kind` and `matched` are the runtime's own vocabulary, which it never scrubs. */
export type ErrorFields = Readonly<{
	body: string
	kind: string
	message: string
	operation: string
	status: number
}>

/** A field of a parsed JSON value, when the value is an object holding it and the field is what `refine` admits. */
const fieldOf = <A>(
	value: unknown,
	key: string,
	refine: (field: unknown) => field is A
): Option.Option<A> => {
	if (!Predicate.hasProperty(value, key)) {
		return Option.none()
	}
	const field = value[key]
	return refine(field) ? Option.some(field) : Option.none()
}

const isAnything = (field: unknown): field is unknown => field !== undefined

/** The error a JSON error line holds, read from its parsed value: none when the value is not one. */
const errorFieldsOf = (parsed: unknown): Option.Option<ErrorFields> =>
	Option.flatMap(fieldOf(parsed, "error", isAnything), (error) =>
		Option.all({
			body: fieldOf(error, "body", Predicate.isString),
			kind: fieldOf(error, "kind", Predicate.isString),
			message: fieldOf(error, "message", Predicate.isString),
			operation: fieldOf(error, "operation", Predicate.isString),
			status: fieldOf(error, "status", Predicate.isNumber)
		})
	)

/** A JSON error line's error: its text parsed, then read; none when the line is not one. */
export const errorLineOf = (line: string): Option.Option<ErrorFields> =>
	Option.flatMap(Result.getSuccess(parseJson(line)), errorFieldsOf)

/** The placeholders a one-character run emits: its scheme's, and the bare one. */
const TOKENS: Arr.NonEmptyReadonlyArray<string> = [WRITTEN, BARE]

/**
 * What of a printed text lies outside the run's placeholders and should not: each character of the credential, and
 * each angle bracket, which only a placeholder holds. Removing every placeholder whole leaves neither when no
 * placeholder spells the credential out inside another (hater m3 HB1).
 */
export const exposedIn = (text: string, credential: string): ReadonlyArray<string> =>
	Arr.filter(
		Str.split("")(Arr.reduce(TOKENS, text, (rest, token) => Str.replaceAll(token, "")(rest))),
		(character) => character === credential || character === "<" || character === ">"
	)

/** The `> ` and `< ` blocks of a verbose run's stderr, each line without its direction mark. */
export const verboseBlocks = (stderr: string): string =>
	Arr.join(
		Arr.flatMap(linesOf(stderr), (line) =>
			Str.startsWith("> ")(line) || Str.startsWith("< ")(line) ? [Str.slice(2)(line)] : []
		),
		"\n"
	)

/** How a server echoes the configured bearer credential in its error body: bare, or in placeholder-shaped text. */
export type Echo =
	| "bare"
	| "inside a placeholder"
	| "inside an open placeholder"
	| "after the scheme's label"
	| "beside the scheme's placeholder"

export const ECHOES: Arr.NonEmptyReadonlyArray<Echo> = [
	"bare",
	"inside a placeholder",
	"inside an open placeholder",
	"after the scheme's label",
	"beside the scheme's placeholder"
]

const echoText = (echo: Echo): string => {
	switch (echo) {
		case "bare":
			return BEARER
		case "inside a placeholder":
			return `<redacted:${BEARER}>`
		case "inside an open placeholder":
			return `<redacted:${BEARER} tail>`
		case "after the scheme's label":
			return `<redacted:bearerAuth${BEARER}>`
		case "beside the scheme's placeholder":
			return `${WRITTEN}${BEARER}`
	}
}

/** An error body echoing the credential, under the text or the JSON error format. */
export type Echoed = Readonly<{ echo: Echo; json: boolean }>

/** Every echo, under each error format. */
export const echoes: FiniteSpace<Echoed> = finite((s) => ({
	echo: s.draw(element(ECHOES)),
	json: s.draw(boolean)
}))

/** The bearer GET refused 400 with a body that echoes the credential. */
export const echoedWorld = (echoed: Echoed): SendWorld => ({
	...bearerGet(),
	env: echoed.json
		? { EXAMPLE_BEARER_AUTH: BEARER, EXAMPLE_ERROR_FORMAT: "json" }
		: { EXAMPLE_BEARER_AUTH: BEARER },
	reply: () =>
		new Response(`{"echo":"${echoText(echoed.echo)}","hint":"${WRITTEN}"}`, {
			headers: { "content-type": "application/json" },
			status: 400
		})
})
