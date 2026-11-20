/** What the properties of response.test.ts read: drawn response tables, responses, scrubbed values and transport failures. */

import {
	array,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	option,
	string,
	uniqueArray,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Option,
	Record,
	Redacted,
	Runtime,
	String as Str
} from "effect"
import { HttpClientError, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/http"
import type { Credential } from "#runtime-src/runtime/auth.ts"
import type { ScrubEntry } from "#runtime-src/runtime/redact.ts"
import {
	classify,
	isBodiless,
	mapClientError,
	matchResponse,
	type ResponseTable
} from "#runtime-src/runtime/response.ts"

/** The characters a request id loses, as the design states them: controls, format characters, surrogates, U+2028/9. */
const UNSAFE: Arr.NonEmptyReadonlyArray<string> = [
	"\u0000",
	"\u0001",
	"\t",
	"\n",
	"\u001B",
	"\u007F",
	"\u0085",
	"\u009B",
	"­",
	"​",
	"‎",
	"‮",
	" ",
	" ",
	"﻿",
	"\uD800"
]

const unsafeText = regex("[\\p{Cc}\\p{Cf}\\p{Cs}\\u2028\\u2029]", "gu")

/** Characters a request id keeps: plain, wide and astral, never a letter a secret uses. */
const SAFE: Arr.NonEmptyReadonlyArray<string> = ["r", "-", "1", "é", "😀", "[", " ", "q"]

/** A run's recorded value and the label its placeholder carries: a bearer credential, or a secret file's text. */
export type Recorded = Readonly<{ kind: "credential" | "secret file"; value: string }>

/** Secret values: capital letters and digits, some holding characters a request id loses inside them. */
const secretValue: Gen<string> = oneOf([
	map(
		string(characterOf(["S", "E", "C", "R", "T", "K", "N", "0", "9"]), { min: 6, max: 12 }),
		(body) => `CANARY${body}`
	),
	map(element(["­", "\u0085", "\u0001"]), (inner) => `CANARY${inner}SECRET`)
])

const recorded: Gen<Recorded> = (s) => ({
	kind: s.draw(element<Recorded["kind"]>(["credential", "secret file"])),
	value: s.draw(secretValue)
})

/** A part of a request id: kept text, a character it loses, or a recorded value, maybe split by lost characters. */
export type IdPart =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "lost"; text: string }>
	| Readonly<{ kind: "recorded"; which: number; split: Option.Option<readonly [number, string]> }>

/** A recorded value of the run's `records`, maybe split by a character the request id loses. */
const recordedPart =
	(records: number): Gen<IdPart> =>
	(s) => ({
		kind: "recorded",
		which: s.draw(int(0, 9)) % records,
		split: s.draw(option(map(int(1, 5), (at) => [at, s.draw(element(UNSAFE))] as const)))
	})

const keptPart: Gen<IdPart> = map(
	string(characterOf(SAFE), { min: 1, max: 6 }),
	(text): IdPart => ({ kind: "text", text })
)

const lostPart: Gen<IdPart> = map(element(UNSAFE), (text): IdPart => ({ kind: "lost", text }))

const idPart = (records: number): Gen<IdPart> =>
	records > 0
		? weighted<IdPart>([
				[4, keptPart],
				[2, lostPart],
				[2, recordedPart(records)]
			])
		: weighted<IdPart>([
				[4, keptPart],
				[2, lostPart]
			])

/** Statuses a server answers with: every class, the codes a table declares and ones it does not. */
const STATUSES: Arr.NonEmptyReadonlyArray<number> = [
	100, 200, 201, 204, 302, 304, 400, 401, 403, 404, 409, 429, 500, 503
]

const KEYS: Arr.NonEmptyReadonlyArray<string> = [
	"200",
	"201",
	"404",
	"401",
	"500",
	"2XX",
	"4XX",
	"5XX",
	"3XX",
	"default"
]

/** A response a run receives, and the table of the operation it answers. */
export type Answer = Readonly<{
	keys: ReadonlyArray<string>
	requestIdHeader: Option.Option<string>
	status: number
	head: boolean
	contentType: Option.Option<string>
	requestId: Option.Option<ReadonlyArray<IdPart>>
	location: Option.Option<string>
	records: ReadonlyArray<Recorded>
}>

export const answers: Gen<Answer> = (s) => {
	const drawn = s.draw(array(recorded, { min: 0, max: 2 }))
	const stripped = (one: Recorded) => Str.replaceAll(unsafeText, "")(one.value)
	const records = Arr.filter(
		drawn,
		(one, at) =>
			!Arr.some(
				drawn,
				(other, before) =>
					before < at &&
					(Str.includes(stripped(one))(stripped(other)) ||
						Str.includes(stripped(other))(stripped(one)))
			)
	)
	return {
		keys: s.draw(uniqueArray(element(KEYS), (key) => constant(key), { min: 0, max: 5 })),
		requestIdHeader: s.draw(option(element(["x-request-id", "X-Correlation-Id"]))),
		status: s.draw(element(STATUSES)),
		head: s.draw(
			weighted([
				[5, constant(false)],
				[1, constant(true)]
			])
		),
		contentType: s.draw(
			option(element(["application/json", "application/json; charset=utf-8", "Text/Plain"]))
		),
		requestId: s.draw(option(array(idPart(records.length), { min: 1, max: 5 }))),
		location: s.draw(
			option(
				element([
					"https://login.example.com/next?access_token=SECRET&state=ok",
					"/relative?api_key=SECRET"
				])
			)
		),
		records
	}
}

const labelOf = (record: Recorded): string =>
	record.kind === "credential" ? "bearer" : "password-file"

const entryOf = (record: Recorded): ScrubEntry =>
	record.kind === "credential"
		? ({
				definition: { kind: "http", scheme: "bearer" },
				scheme: "bearer",
				value: Redacted.make(record.value)
			} satisfies Credential)
		: { kind: "secret", label: "password-file", value: Redacted.make(record.value) }

/** The request id's text as the server sends it. */
const sentId = (answer: Answer, parts: ReadonlyArray<IdPart>): string =>
	Arr.join(
		Arr.map(parts, (part) => {
			switch (part.kind) {
				case "text":
				case "lost":
					return part.text
				case "recorded": {
					const value = Option.match(Arr.get(answer.records, part.which), {
						onNone: () => "",
						onSome: (one) => one.value
					})
					return Option.match(part.split, {
						onNone: () => value,
						onSome: ([at, inserted]) =>
							`${Str.slice(0, at)(value)}${inserted}${Str.slice(at)(value)}`
					})
				}
			}
		}),
		""
	)

/** A request id's text between the scrub's passes: kept text, or a placeholder the first pass wrote. */
type Scrubbed =
	| Readonly<{ kind: "text"; text: string }>
	| Readonly<{ kind: "placeholder"; text: string }>

/**
 * The request id the error carries, as the scrub's two passes leave it (design 7.4, audit S2). The first pass finds
 * each recorded value as sent; occurrences that touch become one placeholder, the first's. Lost characters then go.
 * The second pass finds the recorded values they had split, as the lost characters' removal leaves them; touching
 * occurrences again become one placeholder, and a placeholder of the first pass is never scanned again.
 */
const expectedId = (answer: Answer, parts: ReadonlyArray<IdPart>): string => {
	const placeholderOf = (which: number) =>
		Option.match(Arr.get(answer.records, which), {
			onNone: () => "",
			onSome: (one) => `<redacted:${labelOf(one)}>`
		})
	const first: Array<Scrubbed | Readonly<{ kind: "split"; which: number }>> = []
	let touching = false
	for (const part of parts) {
		const whole = part.kind === "recorded" && Option.isNone(part.split)
		if (part.kind === "text") {
			first.push({ kind: "text", text: part.text })
		} else if (part.kind === "recorded" && whole) {
			if (!touching) {
				first.push({ kind: "placeholder", text: placeholderOf(part.which) })
			}
		} else if (part.kind === "recorded") {
			first.push({ kind: "split", which: part.which })
		}
		touching = whole
	}
	let text = ""
	let joined = false
	for (const piece of first) {
		if (piece.kind === "split") {
			if (!joined) {
				text += placeholderOf(piece.which)
			}
			joined = true
		} else {
			text += piece.text
			joined = false
		}
	}
	return text
}

const request = (head: boolean) =>
	head
		? HttpClientRequest.head("https://api.example.com/users/1")
		: HttpClientRequest.get("https://api.example.com/users/1")

/** The response the answer describes, its headers as sent. */
const responseOf = (answer: Answer) => {
	const headers: Array<readonly [string, string]> = [
		...Option.match(answer.contentType, {
			onNone: () => [],
			onSome: (type) => [["content-type", type] as const]
		}),
		...Option.match(answer.location, {
			onNone: () => [],
			onSome: (at) => [["location", at] as const]
		}),
		...Option.match(Option.all([answer.requestIdHeader, answer.requestId]), {
			onNone: () => [],
			onSome: ([name, parts]) => [[Str.toUpperCase(name), sentId(answer, parts)] as const]
		})
	]
	return HttpClientResponse.fromWeb(
		request(answer.head),
		Object.defineProperties(new Response(null, { status: 200 }), {
			headers: { value: new ScriptedHeaders(headers) },
			status: { value: answer.status }
		})
	)
}

/** Headers iterated as scripted: a web `Headers` cannot hold the control and format characters a request id may. */
class ScriptedHeaders extends Headers {
	constructor(pairs: ReadonlyArray<readonly [string, string]>) {
		super()
		Object.defineProperty(this, Symbol.iterator, { value: () => pairs.values() })
	}
}

/** What classifying an answer gives, in the fields the specification states. */
export type Classified = Readonly<{
	matched: string
	bodiless: boolean
	outcome:
		| Readonly<{ kind: "passed" }>
		| Readonly<{
				kind: "failed"
				matched: string
				status: number
				operation: string
				mediaType: Option.Option<string>
				requestId: Option.Option<string>
				exitCode: number
				locationRedacted: boolean
		  }>
}>

const tableOf = (answer: Answer): ResponseTable => ({
	operation: "users-update",
	requestIdHeader: Option.getOrUndefined(answer.requestIdHeader),
	responses: Record.fromEntries(Arr.map(answer.keys, (key) => [key, ["application/json"]] as const))
})

/**
 * What the specification gives an answer: the explicit code, else its range, else default, else undeclared; no body for
 * a HEAD answer, a 1xx, a 204 or a 304; a 2xx passes; anything else fails with the matched key, the status, the media
 * type's essence, the request id (from the designated header only; its lost characters gone, each recorded value its
 * placeholder), exit 3 for a 401 or 403 and 1 otherwise, and a 3xx's Location with its credentials redacted.
 */
export const expectedOf = (answer: Answer): Classified => {
	const code = String(answer.status)
	const range = `${Math.floor(answer.status / 100)}XX`
	const matched = Arr.contains(answer.keys, code)
		? code
		: Arr.contains(answer.keys, range)
			? range
			: Arr.contains(answer.keys, "default")
				? "default"
				: "undeclared"
	const bodiless =
		answer.head || answer.status < 200 || answer.status === 204 || answer.status === 304
	if (answer.status >= 200 && answer.status < 300) {
		return { matched, bodiless, outcome: { kind: "passed" } }
	}
	return {
		matched,
		bodiless,
		outcome: {
			kind: "failed",
			matched,
			status: answer.status,
			operation: "users-update",
			mediaType: Option.map(answer.contentType, (type) =>
				Str.toLowerCase(Str.trim(Arr.getUnsafe(Str.split(";")(type), 0)))
			),
			requestId: Option.flatMap(answer.requestIdHeader, () =>
				Option.map(answer.requestId, (parts) => expectedId(answer, parts))
			),
			exitCode: answer.status === 401 || answer.status === 403 ? 3 : 1,
			locationRedacted:
				answer.status >= 300 && answer.status < 400 && Option.isSome(answer.location)
		}
	}
}

/** What the runtime gives an answer, read in the same fields. */
export const actualOf = (answer: Answer) =>
	Effect.gen(function* () {
		const table = tableOf(answer)
		const response = responseOf(answer)
		const exit = yield* Effect.exit(
			Effect.provideService(
				classify(table, response, Arr.map(answer.records, entryOf)),
				UrlParams.CurrentRedactedNames,
				["access_token", "api_key"]
			)
		)
		const classified: Classified = {
			matched: matchResponse(table.responses, answer.status),
			bodiless: isBodiless(response),
			outcome: Exit.match(exit, {
				onSuccess: (passed): Classified["outcome"] =>
					passed === response
						? { kind: "passed" }
						: {
								kind: "failed",
								matched: "another response",
								status: 0,
								operation: "",
								mediaType: Option.none(),
								requestId: Option.none(),
								exitCode: 0,
								locationRedacted: false
							},
				onFailure: (cause): Classified["outcome"] =>
					Option.match(Cause.findErrorOption(cause), {
						onNone: () => ({
							kind: "failed",
							matched: "a defect",
							status: 0,
							operation: "",
							mediaType: Option.none(),
							requestId: Option.none(),
							exitCode: 0,
							locationRedacted: false
						}),
						onSome: (error) => ({
							kind: "failed",
							matched: error.matched,
							status: error.status,
							operation: error.operation,
							mediaType: Option.fromUndefinedOr(error.mediaType),
							requestId: Option.fromUndefinedOr(error.requestId),
							exitCode: Runtime.getErrorExitCode(error),
							locationRedacted:
								Str.includes("REDACTED")(error.body) && !Str.includes("=SECRET")(error.body)
						})
					})
			})
		}
		return classified
	})

export type AnswerFeature =
	| "an explicit code"
	| "a range"
	| "default"
	| "undeclared"
	| "a bodiless answer"
	| "a 401 or 403"
	| "a 3xx with a Location"
	| "a request id with lost characters"
	| "a recorded value in the request id"
	| "a recorded value split by a lost character"
	| "a recorded value holding lost characters"
	| "a request id header not designated"
	| "a media type with parameters"

export const answerFeatures = (
	answer: Answer,
	classified: Classified
): ReadonlyArray<AnswerFeature> => {
	const when = (holds: boolean, feature: AnswerFeature): ReadonlyArray<AnswerFeature> =>
		holds ? [feature] : []
	const parts = Option.getOrElse(answer.requestId, (): ReadonlyArray<IdPart> => [])
	const failed = classified.outcome.kind === "failed"
	const recordedParts = Arr.flatMap(parts, (part) => (part.kind === "recorded" ? [part] : []))
	return [
		...when(
			Arr.contains(answer.keys, `${answer.status}`) &&
				classified.matched !== "undeclared" &&
				!Str.endsWith("XX")(classified.matched) &&
				classified.matched !== "default",
			"an explicit code"
		),
		...when(Str.endsWith("XX")(classified.matched), "a range"),
		...when(classified.matched === "default", "default"),
		...when(classified.matched === "undeclared" && failed, "undeclared"),
		...when(classified.bodiless, "a bodiless answer"),
		...when(answer.status === 401 || answer.status === 403, "a 401 or 403"),
		...when(
			answer.status >= 300 && answer.status < 400 && Option.isSome(answer.location),
			"a 3xx with a Location"
		),
		...when(
			failed &&
				Option.isSome(answer.requestIdHeader) &&
				Arr.some(parts, (part) => part.kind === "lost"),
			"a request id with lost characters"
		),
		...when(
			failed && Option.isSome(answer.requestIdHeader) && Arr.isReadonlyArrayNonEmpty(recordedParts),
			"a recorded value in the request id"
		),
		...when(
			failed &&
				Option.isSome(answer.requestIdHeader) &&
				Arr.some(recordedParts, (part) => Option.isSome(part.split)),
			"a recorded value split by a lost character"
		),
		...when(
			failed &&
				Option.isSome(answer.requestIdHeader) &&
				Arr.some(recordedParts, (part) =>
					Option.exists(Arr.get(answer.records, part.which), (one) => unsafeText.test(one.value))
				),
			"a recorded value holding lost characters"
		),
		...when(
			failed && Option.isNone(answer.requestIdHeader) && Option.isSome(answer.requestId),
			"a request id header not designated"
		),
		...when(Option.exists(answer.contentType, Str.includes(";")), "a media type with parameters")
	]
}

/** One link of a transport failure's cause chain. */
export type Link =
	| Readonly<{ kind: "timeout" }>
	| Readonly<{ kind: "abort" }>
	| Readonly<{ kind: "system"; code: string; message: string }>
	| Readonly<{ kind: "type error"; message: string }>

/** A client failure: a transport failure with its cause chain (closed into a cycle or not), or an invalid URL. */
export type ClientFailure =
	| Readonly<{ kind: "transport"; links: ReadonlyArray<Link>; cyclic: boolean }>
	| Readonly<{ kind: "invalid url" }>

const CODES: Arr.NonEmptyReadonlyArray<string> = [
	"ENOTFOUND",
	"EAI_AGAIN",
	"EAI_NODATA",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_HAS_EXPIRED",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
	"ECONNREFUSED",
	"ECONNRESET"
]

const MESSAGES: Arr.NonEmptyReadonlyArray<string> = [
	"failed",
	"fetch failed",
	"getaddrinfo ENOTFOUND api.example.com",
	"certificate has expired",
	"SSL routines",
	"a DNS lookup failed",
	"Tlsx is no word"
]

const link: Gen<Link> = weighted<Link>([
	[1, constant<Link>({ kind: "timeout" })],
	[1, constant<Link>({ kind: "abort" })],
	[
		4,
		(s): Link => ({
			kind: "system",
			code: s.draw(element(CODES)),
			message: s.draw(element(MESSAGES))
		})
	],
	[2, map(element(MESSAGES), (message): Link => ({ kind: "type error", message }))]
])

export const clientFailures: Gen<ClientFailure> = weighted<ClientFailure>([
	[
		8,
		(s): ClientFailure => ({
			kind: "transport",
			links: s.draw(array(link, { min: 1, max: 3 })),
			cyclic: s.draw(
				weighted([
					[3, constant(false)],
					[1, constant(true)]
				])
			)
		})
	],
	[1, constant<ClientFailure>({ kind: "invalid url" })]
])

const DNS_CODES: ReadonlyArray<string> = ["EAI_AGAIN", "EAI_NODATA", "ENOTFOUND"]

const TLS_CODES: ReadonlyArray<string> = [
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]

const tlsWords: Readonly<RegExp> = regex.as("certificate|\\bssl\\b|\\btls\\b", "iu")

const dnsWords: Readonly<RegExp> = regex.as("getaddrinfo|\\bdns\\b", "iu")

const tlsPrefix: Readonly<RegExp> = regex("^ERR_(?:SSL|TLS)", "u")

/** Whether a link says what each reason looks for, as the design's transport table names them. */
const linkSays = (one: Link): ReadonlyArray<"timeout" | "aborted" | "tls" | "dns"> => {
	switch (one.kind) {
		case "timeout":
			return ["timeout"]
		case "abort":
			return ["aborted"]
		case "system":
			return [
				...(Arr.contains(TLS_CODES, one.code) ||
				tlsPrefix.test(one.code) ||
				tlsWords.test(one.message)
					? ["tls" as const]
					: []),
				...(Arr.contains(DNS_CODES, one.code) || dnsWords.test(one.message) ? ["dns" as const] : [])
			]
		case "type error":
			return [
				...(tlsWords.test(one.message) ? ["tls" as const] : []),
				...(dnsWords.test(one.message) ? ["dns" as const] : [])
			]
	}
}

/** What a client failure becomes, as the design says: a transport reason by its strongest sign, or a defect. */
export const expectedReason = (failure: ClientFailure): string => {
	if (failure.kind === "invalid url") {
		return "a defect"
	}
	const said = Arr.flatMap(failure.links, linkSays)
	return Option.getOrElse(
		Arr.findFirst(["timeout", "aborted", "tls", "dns"] as const, (reason) =>
			Arr.contains(said, reason)
		),
		() => "connect"
	)
}

/** The cause chain a failure's links make, each the next one's cause, the last one's the first when it is cyclic. */
const causeOf = (links: ReadonlyArray<Link>, cyclic: boolean): unknown => {
	const made = Arr.map(links, (one): Error => {
		switch (one.kind) {
			case "timeout":
				return new Cause.TimeoutError("Operation request")
			case "abort":
				return new DOMException("The operation was aborted.", "AbortError")
			case "system":
				return Object.assign(new Error(one.message), { code: one.code })
			case "type error":
				return new TypeError(one.message)
		}
	})
	for (const [at, error] of made.entries()) {
		const next = made[at + 1] ?? (cyclic ? made[0] : undefined)
		if (next !== undefined) {
			Object.defineProperty(error, "cause", { value: next })
		}
	}
	return made[0]
}

const failedRequest = HttpClientRequest.get("https://api.example.com/users?api_key=SECRET&page=2")

/** What the runtime makes of a client failure: its transport reason and whether its URL hid the key, or a defect. */
export const actualReason = (failure: ClientFailure) =>
	Effect.map(
		Effect.exit(
			Effect.provideService(
				mapClientError(
					new HttpClientError.HttpClientError({
						reason:
							failure.kind === "transport"
								? new HttpClientError.TransportError({
										cause: causeOf(failure.links, failure.cyclic),
										request: failedRequest
									})
								: new HttpClientError.InvalidUrlError({ request: failedRequest })
					})
				),
				UrlParams.CurrentRedactedNames,
				["access_token", "api_key"]
			)
		),
		(exit) =>
			Exit.match(exit, {
				onSuccess: () => "no failure",
				onFailure: (cause) =>
					Option.match(Cause.findErrorOption(cause), {
						onNone: () => "a defect",
						onSome: (error) =>
							Str.includes("api_key=REDACTED")(error.url) &&
							Str.includes("page=2")(error.url) &&
							!Str.includes("SECRET")(error.url)
								? error.reason
								: `${error.reason} with its URL unredacted`
					})
			})
	)

export type FailureFeature =
	| "timeout"
	| "aborted"
	| "tls"
	| "dns"
	| "connect"
	| "a defect"
	| "a cyclic cause"
	| "a reason two links deep"

const REASONS: ReadonlyArray<FailureFeature> = [
	"timeout",
	"aborted",
	"tls",
	"dns",
	"connect",
	"a defect"
]

export const failureFeatures = (
	failure: ClientFailure,
	reason: string
): ReadonlyArray<FailureFeature> => {
	const named = Arr.filter(REASONS, (one) => one === reason)
	if (failure.kind === "invalid url") {
		return named
	}
	const firstSays = Option.match(Arr.head(failure.links), { onNone: () => [], onSome: linkSays })
	const deeper =
		Arr.isReadonlyArrayEmpty(firstSays) &&
		Arr.some(Arr.drop(failure.links, 1), (one) => Arr.isReadonlyArrayNonEmpty(linkSays(one)))
	const cyclic: ReadonlyArray<FailureFeature> = failure.cyclic ? ["a cyclic cause"] : []
	const deep: ReadonlyArray<FailureFeature> = deeper ? ["a reason two links deep"] : []
	return [...named, ...cyclic, ...deep]
}
