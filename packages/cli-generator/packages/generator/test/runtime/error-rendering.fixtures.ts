/** What error-rendering.test.ts's property reads: drawn errors, the run's record and scrubbed values, and how they render. */

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
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Exit,
	Formatter,
	Layer,
	Option,
	Record,
	Redacted,
	Ref,
	Runtime,
	Sink,
	Stdio,
	String as Str
} from "effect"
import {
	ApiResponseError,
	CredentialMissing,
	TransportError,
	UsageError
} from "#runtime-src/domain/errors.ts"
import * as Output from "#runtime-src/runtime/output.ts"
import { RunCredentials, type ScrubEntry } from "#runtime-src/runtime/redact.ts"

/** The run's recorded values: a bearer credential and a secret file's text, each a canary no other text holds. */
const CREDENTIAL = "tok-ER1-SECRET"

const SECRET_FILE = "pw-ER1-SECRET"

const RECORDED: ReadonlyArray<ScrubEntry> = [
	{
		definition: { kind: "http", scheme: "bearer" },
		scheme: "bearer",
		value: Redacted.make(CREDENTIAL)
	},
	{ kind: "secret", label: "password-file", value: Redacted.make(SECRET_FILE) }
]

/** A part of a text a server or a person sent: plain words, a line break or tab, a control character, or a canary. */
export type Part =
	| Readonly<{ kind: "word"; text: string }>
	| Readonly<{ kind: "break"; text: "\n" | "\t" }>
	| Readonly<{ kind: "control"; text: string }>
	| Readonly<{ kind: "credential" }>
	| Readonly<{ kind: "secret file" }>

const part: Gen<Part> = weighted<Part>([
	[5, map(element(["no", "such", "user", "a/b", "é"]), (text): Part => ({ kind: "word", text }))],
	[1, map(element<"\n" | "\t">(["\n", "\t"]), (text): Part => ({ kind: "break", text }))],
	[
		1,
		map(element(["\u001B", "\u0000", "\u009B", "‮", "​"]), (text): Part => ({
			kind: "control",
			text
		}))
	],
	[1, constant<Part>({ kind: "credential" })],
	[1, constant<Part>({ kind: "secret file" })]
])

const textGen: Gen<ReadonlyArray<Part>> = array(part, { min: 0, max: 6 })

/** An error the runtime raises by design, or a defect no class names. */
export type Raised =
	| Readonly<{
			kind: "ApiResponseError"
			operation: string
			status: number
			matched: string
			body: ReadonlyArray<Part>
			requestId: Option.Option<ReadonlyArray<Part>>
			retryAfter: Option.Option<number>
	  }>
	| Readonly<{ kind: "TransportError"; reason: "connect" | "dns" | "tls" | "timeout" | "aborted" }>
	| Readonly<{ kind: "CredentialMissing"; operation: string; alternatives: ReadonlyArray<string> }>
	| Readonly<{ kind: "UsageError"; message: ReadonlyArray<Part> }>
	| Readonly<{ kind: "defect"; message: ReadonlyArray<Part> }>

const OPERATIONS: Arr.NonEmptyReadonlyArray<string> = ["users.get", "items-call", "pets.update"]

const apiGen: Gen<Raised> = (s) => {
	const status = s.draw(element([400, 401, 403, 404, 409, 500, 503]))
	return {
		kind: "ApiResponseError",
		operation: s.draw(element(OPERATIONS)),
		status,
		matched: s.draw(
			element([String(status), `${Math.floor(status / 100)}XX`, "default", "undeclared"])
		),
		body: s.draw(textGen),
		requestId: s.draw(option(map(array(part, { min: 1, max: 4 }), (parts) => parts))),
		retryAfter: s.draw(option(int(1, 120)))
	}
}

const transport: Gen<Raised> = map(
	element<"connect" | "dns" | "tls" | "timeout" | "aborted">([
		"connect",
		"dns",
		"tls",
		"timeout",
		"aborted"
	]),
	(reason): Raised => ({ kind: "TransportError", reason })
)

const missing: Gen<Raised> = (s): Raised => ({
	kind: "CredentialMissing",
	operation: s.draw(element(OPERATIONS)),
	alternatives: s.draw(
		array(element(["bearerAuth", "apiKey", "bearerAuth+apiKey"]), { min: 1, max: 2 })
	)
})

const usage: Gen<Raised> = map(array(part, { min: 1, max: 4 }), (message): Raised => ({
	kind: "UsageError",
	message
}))

const defect: Gen<Raised> = map(array(part, { min: 1, max: 4 }), (message): Raised => ({
	kind: "defect",
	message
}))

/** Each kind's errors. */
const raisedOf = (kind: Raised["kind"]): Gen<Raised> => {
	switch (kind) {
		case "ApiResponseError":
			return apiGen
		case "TransportError":
			return transport
		case "CredentialMissing":
			return missing
		case "UsageError":
			return usage
		case "defect":
			return defect
	}
}

const raisedGen: Gen<Raised> = oneOf<Raised>([apiGen, transport, missing, usage, defect])

/** How the run renders: the format its record holds (or none recorded), and the request `send` recorded, if any. */
export type Rendering = Readonly<{
	format: Option.Option<"text" | "json">
	sent: Option.Option<Readonly<{ method: string; idempotencyKey: boolean }>>
}>

const rendering: Gen<Rendering> = (s) => ({
	format: s.draw(option(element<"text" | "json">(["text", "json"]))),
	sent: s.draw(
		option((t) => ({
			method: t.draw(element(["GET", "PUT", "DELETE", "POST", "PATCH"])),
			idempotencyKey: t.draw(element([false, true]))
		}))
	)
})

export type Failing = Readonly<{ raised: Raised; rendering: Rendering }>

const failings: Gen<Failing> = (s) => ({
	raised: s.draw(raisedGen),
	rendering: s.draw(rendering)
})

const textOf = (parts: ReadonlyArray<Part>): string =>
	Arr.join(
		Arr.map(parts, (one) => {
			switch (one.kind) {
				case "word":
				case "break":
				case "control":
					return one.text
				case "credential":
					return CREDENTIAL
				case "secret file":
					return SECRET_FILE
			}
		}),
		""
	)

/**
 * A text as the design prints it (7.4, 7.5): every recorded value its placeholder (values that touch one run, under the
 * first one's), every control and format character gone, line breaks and tabs kept, or folded to one space where the
 * text must stay on one line.
 */
const printed = (parts: ReadonlyArray<Part>, oneLine: boolean): string => {
	const kept = Arr.flatMap(parts, (one, at): ReadonlyArray<string> => {
		const touching = Option.exists(
			Arr.get(parts, at - 1),
			(before) => at > 0 && (before.kind === "credential" || before.kind === "secret file")
		)
		switch (one.kind) {
			case "word":
			case "break":
				return [one.text]
			case "control":
				return []
			case "credential":
				return touching ? [] : ["<redacted:bearer>"]
			case "secret file":
				return touching ? [] : ["<redacted:password-file>"]
		}
	})
	const joined = Arr.join(kept, "")
	return oneLine ? Str.replaceAll(lineBreaks, " ")(joined) : joined
}

const lineBreaks = regex("[\\n\\t]+", "gu")

const terminal = regex("[.!?]$", "u")

/** The error the raised kind is, as the runtime constructs it. */
const failureOf = (
	raised: Raised
): Effect.Effect<never, ApiResponseError | TransportError | CredentialMissing | UsageError> => {
	switch (raised.kind) {
		case "ApiResponseError":
			return Effect.fail(
				ApiResponseError.make({
					body: textOf(raised.body),
					matched: raised.matched,
					operation: raised.operation,
					status: raised.status,
					...Option.match(raised.requestId, {
						onNone: () => ({}),
						onSome: (parts) => ({ requestId: textOf(parts) })
					}),
					...Option.match(raised.retryAfter, {
						onNone: () => ({}),
						onSome: (seconds) => ({ retryAfterSeconds: seconds })
					})
				})
			)
		case "TransportError":
			return Effect.fail(
				TransportError.make({
					reason: raised.reason,
					url: "https://api.example.com/users?api_key=REDACTED"
				})
			)
		case "CredentialMissing":
			return Effect.fail(
				CredentialMissing.make({ alternatives: raised.alternatives, operation: raised.operation })
			)
		case "UsageError":
			return Effect.fail(UsageError.make({ message: textOf(raised.message) }))
		case "defect":
			return Effect.die(new Error(textOf(raised.message)))
	}
}

/** What the final catch printed on stderr, and the exit code the run ends with. */
export const renderedOf = (failing: Failing) =>
	Effect.scoped(
		Effect.gen(function* () {
			const err: Array<string> = []
			const decoder = new TextDecoder()
			const record = yield* Ref.make<Output.RunRecordState>({
				...Option.match(failing.rendering.format, {
					onNone: () => ({}),
					onSome: (format) => ({ format })
				}),
				...Option.match(failing.rendering.sent, {
					onNone: () => ({}),
					onSome: (sent) => ({ sent })
				})
			})
			const context = yield* Layer.build(
				Layer.mergeAll(
					Stdio.layerTest({
						stderr: () =>
							Sink.forEachArray((chunks: ReadonlyArray<string | Uint8Array>) =>
								Effect.sync(() => {
									for (const chunk of chunks) {
										err.push(typeof chunk === "string" ? chunk : decoder.decode(chunk))
									}
								})
							)
					}),
					Layer.effect(RunCredentials)(Ref.make(RECORDED)),
					Layer.succeed(Output.RunRecord, record)
				)
			)
			const exit = yield* Effect.exit(
				Output.finalCatch([])(failureOf(failing.raised)).pipe(Effect.provideContext(context))
			)
			return {
				stderr: Arr.join(err, ""),
				exitCode: Exit.isSuccess(exit) ? 0 : Runtime.getErrorExitCode(Cause.squash(exit.cause))
			}
		})
	)

/** The one-line `{"error":{...}}` object of fields in the order given. */
const jsonObject = (fields: ReadonlyArray<readonly [string, string | number]>): string =>
	`{"error":${Formatter.formatJson(Record.fromEntries(fields))}}`

/** The methods D-AD7 retries without an Idempotency-Key. */
const IDEMPOTENT: ReadonlyArray<string> = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]

const RETRY_HINT = "The request is idempotent, so running the command again is safe."

/**
 * What design 7.4 prints for a failing run, and its exit: the error's message line (`Error: ...`); for an API response
 * error, the capped Retry-After sentence when retrying stopped at the cap; the retry hint for an exchange failure after
 * a request D-AD7 would retry; the request id's line; the body when it is not empty. As JSON, one `{"error":{...}}`
 * object, keys alphabetical, the hint a second sentence of the message. A defect prints one line and exits 70.
 */
export const expectedOf = (failing: Failing) => {
	const { raised } = failing
	const json = Option.contains(failing.rendering.format, "json")
	const exchange = raised.kind === "ApiResponseError" || raised.kind === "TransportError"
	const hint =
		exchange &&
		Option.exists(
			failing.rendering.sent,
			(sent) => sent.idempotencyKey || Arr.contains(IDEMPOTENT, sent.method)
		)
	const exitCode = ((): number => {
		switch (raised.kind) {
			case "ApiResponseError":
				return raised.status === 401 || raised.status === 403 ? 3 : 1
			case "TransportError":
				return 4
			case "CredentialMissing":
				return 3
			case "UsageError":
				return 2
			case "defect":
				return 70
		}
	})()
	const message = ((): string => {
		switch (raised.kind) {
			case "ApiResponseError":
				return `${raised.operation} returned ${raised.status} (matched ${raised.matched})`
			case "TransportError":
				return `request to https://api.example.com/users?api_key=REDACTED failed: ${raised.reason}`
			case "CredentialMissing":
				return `${raised.operation} needs a credential: ${Arr.join(raised.alternatives, " or ")}`
			case "UsageError":
			case "defect":
				return printed(raised.message, true)
		}
	})()
	if (raised.kind === "defect") {
		return {
			stderr: json
				? `${jsonObject([
						["kind", "Internal"],
						["message", `${message}; internal error, please report`]
					])}\n`
				: `Error: ${message}\ninternal error, please report\n`,
			exitCode
		}
	}
	const api = raised.kind === "ApiResponseError" ? Option.some(raised) : Option.none()
	const capped = Option.flatMap(api, (one) => one.retryAfter)
	const requestId = Option.flatMap(api, (one) =>
		Option.map(one.requestId, (parts) => printed(parts, true))
	)
	const body = Option.match(api, { onNone: () => "", onSome: (one) => printed(one.body, false) })
	if (json) {
		const sentence = hint
			? `${terminal.test(message) ? message : `${message}.`} ${RETRY_HINT}`
			: message
		const fields: ReadonlyArray<readonly [string, Option.Option<string | number>]> = [
			["body", body === "" ? Option.none() : Option.some(body)],
			["kind", Option.some(raised.kind)],
			["matched", Option.map(api, (one) => one.matched)],
			["message", Option.some(sentence)],
			[
				"operation",
				raised.kind === "ApiResponseError" || raised.kind === "CredentialMissing"
					? Option.some(raised.operation)
					: Option.none()
			],
			["requestId", requestId],
			["retryAfter", capped],
			["status", Option.map(api, (one) => one.status)]
		]
		return {
			stderr: `${jsonObject(Arr.flatMap(fields, ([key, value]) => Option.match(value, { onNone: () => [], onSome: (present) => [[key, present] as const] })))}\n`,
			exitCode
		}
	}
	const lines = [
		`Error: ${message}`,
		...Option.toArray(
			Option.map(
				capped,
				(seconds) =>
					`Retrying stopped: the server's Retry-After of ${seconds} second${seconds === 1 ? "" : "s"} exceeds the --timeout cap.`
			)
		),
		...(hint ? [RETRY_HINT] : []),
		...Option.toArray(Option.map(requestId, (id) => `Request ID: ${id}`)),
		...(body === "" ? [] : [body])
	]
	return { stderr: `${Arr.join(lines, "\n")}\n`, exitCode }
}

type Kind = Raised["kind"]

const KINDS: ReadonlyArray<Kind> = [
	"ApiResponseError",
	"TransportError",
	"CredentialMissing",
	"UsageError",
	"defect"
]

export type FailingFeature =
	| `${Kind}, ${"text" | "json"}`
	| "a retry hint"
	| "a capped Retry-After"
	| "a request id"
	| "a recorded value in the body"

export const failingFeatures = (failing: Failing): ReadonlyArray<FailingFeature> => {
	const { raised } = failing
	const format = Option.contains(failing.rendering.format, "json") ? "json" : "text"
	const api = raised.kind === "ApiResponseError" ? Option.some(raised) : Option.none()
	const hint =
		(raised.kind === "ApiResponseError" || raised.kind === "TransportError") &&
		Option.exists(
			failing.rendering.sent,
			(sent) => sent.idempotencyKey || Arr.contains(IDEMPOTENT, sent.method)
		)
	return [
		`${raised.kind}, ${format}`,
		...(hint ? (["a retry hint"] as const) : []),
		...(Option.exists(api, (one) => Option.isSome(one.retryAfter))
			? (["a capped Retry-After"] as const)
			: []),
		...(Option.exists(api, (one) => Option.isSome(one.requestId))
			? (["a request id"] as const)
			: []),
		...(Option.exists(api, (one) =>
			Arr.some(one.body, (piece) => piece.kind === "credential" || piece.kind === "secret file")
		)
			? (["a recorded value in the body"] as const)
			: [])
	]
}

/** Every kind in each format, and the parts an API response error's rendering may carry, as required situations. */
export const FAILING_SITUATIONS: ReadonlyArray<FailingFeature> = [
	...Arr.flatMap(KINDS, (kind) => [`${kind}, text` as const, `${kind}, json` as const]),
	"a retry hint",
	"a capped Retry-After",
	"a request id",
	"a recorded value in the body"
]

const withKind =
	(kind: Kind, format: "text" | "json"): Gen<Failing> =>
	(s) => ({
		raised: s.draw(raisedOf(kind)),
		rendering: { ...s.draw(rendering), format: Option.some(format) }
	})

/** Failings, aimed at each pending situation by one built to reach it. */
export const aimedFailings: Aimed<Failing, FailingFeature> = aimed(failings, [
	...Arr.flatMap(KINDS, (kind) => [
		[`${kind}, text` as const, withKind(kind, "text")] as const,
		[`${kind}, json` as const, withKind(kind, "json")] as const
	]),
	[
		"a retry hint",
		map(withKind("ApiResponseError", "text"), (failing): Failing => ({
			...failing,
			rendering: {
				...failing.rendering,
				sent: Option.some({ method: "GET", idempotencyKey: false })
			}
		}))
	],
	[
		"a capped Retry-After",
		map(apiGen, (one): Failing => ({
			raised: one.kind === "ApiResponseError" ? { ...one, retryAfter: Option.some(30) } : one,
			rendering: { format: Option.none(), sent: Option.none() }
		}))
	],
	[
		"a request id",
		map(apiGen, (one): Failing => ({
			raised:
				one.kind === "ApiResponseError"
					? { ...one, requestId: Option.some([{ kind: "word", text: "req_123" }]) }
					: one,
			rendering: { format: Option.none(), sent: Option.none() }
		}))
	],
	[
		"a recorded value in the body",
		map(apiGen, (one): Failing => ({
			raised:
				one.kind === "ApiResponseError"
					? { ...one, body: [{ kind: "word", text: "got" }, { kind: "credential" }] }
					: one,
			rendering: { format: Option.none(), sent: Option.none() }
		}))
	]
])
