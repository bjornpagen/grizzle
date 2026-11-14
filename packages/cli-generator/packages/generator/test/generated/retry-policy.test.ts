/**
 * A generated CLI retries a failed attempt only when the caller asked for retries and the attempt may be sent again
 * (design D-AD7):
 *
 * - `--retries <n>` is the run's whole budget; without it the run never retries, and no environment variable stands
 *   in for it.
 * - A retried outcome is a final status of 408, 429, 500, 502, 503 or 504, or a header timeout; any other status ends
 *   the run at once.
 * - An idempotent method is retried; `POST` only with a declared `Idempotency-Key` sent, which every attempt carries
 *   unchanged, or with `--retry-unsafe`.
 * - A body read once from stdin is never sent again: the run stops and names `unreplayableBody`. A file body is sent
 *   again byte for byte, under a `Content-Length`.
 * - A retry waits the response's `Retry-After`, else the backoff; a `Retry-After` longer than the effective timeout
 *   (`--timeout`, else `<PREFIX>_TIMEOUT`) is not waited, and the run stops naming the server's delay as `retryAfter`.
 *   With neither, or with `0`, an attempt is untimed and nothing caps a wait, so absent and zero timeouts are drawn
 *   beside small ones, and every `Retry-After` drawn is at most 3 seconds.
 * - Each retry prints one `Notice: retrying` line. The run exits 0 on a 2xx, 1 on another final status, 4 on a header
 *   timeout, and `--error-format json` names the final error's kind, status and capped delay.
 *
 * One package with a GET, a POST with a JSON body and an optional `Idempotency-Key`, a POST and a PUT of octet bodies.
 * A steered property draws the operation, the body's source, the flags and the server's sequence of answers. Oracle:
 * a model of the rules above run over that sequence, compared with every attempt the capture server recorded, the exit
 * code, the notices and the JSON error.
 *
 * Under the owner's swarm gate this suite has not been run yet, nor checked against plants.
 */
import { type Case as SearchCase, drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	option,
	weighted
} from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { jsonTextOf } from "@superstarter/json"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Layer,
	Option,
	Path,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import {
	type CaptureServer,
	captureServer,
	type ScriptedResponse
} from "#test/support/capture-server.ts"
import {
	buildPackage,
	type BuiltPackage,
	generateFixture,
	harnessLayer,
	runBin
} from "#test/support/cli-package.ts"
import { valuesOf, type WireRequest } from "#test/support/http.ts"
import { latin1Bytes } from "#test/support/wire.ts"

/** An object answer. */
const answered = {
	description: "Done.",
	content: { "application/json": { schema: { type: "object" } } }
} as const

const ID = { name: "id", in: "path", required: true, schema: { type: "string" } } as const

const OCTETS = {
	required: true,
	content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
} as const

/** A GET, a POST with a JSON body and an optional Idempotency-Key, and a POST and a PUT of octet bodies. */
const spec = jsonTextOf({
	openapi: "3.1.0",
	info: { title: "Retry policy", version: "1.0.0" },
	paths: {
		"/items/{id}": {
			get: { operationId: "items-get", parameters: [ID], responses: { "200": answered } }
		},
		"/orders/{id}": {
			post: {
				operationId: "orders-create",
				parameters: [
					ID,
					{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }
				],
				requestBody: {
					required: true,
					content: {
						"application/json": {
							schema: { type: "object", properties: { note: { type: "string" } } }
						}
					}
				},
				responses: { "200": answered }
			}
		},
		"/uploads/{id}": {
			post: {
				operationId: "uploads-create",
				parameters: [ID],
				requestBody: OCTETS,
				responses: { "200": answered }
			}
		},
		"/blobs/{id}": {
			put: {
				operationId: "blobs-replace",
				parameters: [ID],
				requestBody: OCTETS,
				responses: { "200": answered }
			}
		}
	}
})

/** The author config, binding the capture server's origin. */
const configOf = (bound: string): string =>
	jsonTextOf({
		package: { name: "retry-policy", version: "1.0.0" },
		binName: "retry",
		envPrefix: "RETRY",
		acceptedOrigins: [bound],
		allowInsecure: true
	})

/** An operation of the box. */
type Operation = "items" | "orders" | "uploads" | "blobs"

const POINTERS: Readonly<Record<Operation, string>> = {
	items: "/paths/~1items~1{id}/get",
	orders: "/paths/~1orders~1{id}/post",
	uploads: "/paths/~1uploads~1{id}/post",
	blobs: "/paths/~1blobs~1{id}/put"
}

const METHODS: Readonly<Record<Operation, string>> = {
	items: "GET",
	orders: "POST",
	uploads: "POST",
	blobs: "PUT"
}

/** What a run sends: no body, a JSON note with or without an Idempotency-Key, or octets from stdin or a file. */
type Send =
	| Readonly<{ kind: "item" }>
	| Readonly<{ kind: "order"; key: Option.Option<string> }>
	| Readonly<{ kind: "upload"; from: "stdin" | "a file" }>
	| Readonly<{ kind: "blob" }>

const operationOf = (send: Send): Operation => {
	switch (send.kind) {
		case "item":
			return "items"
		case "order":
			return "orders"
		case "upload":
			return "uploads"
		case "blob":
			return "blobs"
	}
}

/** The note an order sends, and the octets an upload or a blob sends. */
const NOTE = '{"note":"again"}'

/** 64 KiB of a pattern that repeats no line, so a re-send that drops or reorders a span is told apart. */
const octetBody = (): Uint8Array =>
	Uint8Array.from({ length: 64 * 1024 }, (_, index) => (index * 31 + 7) % 251)

/** One answer the server gives an attempt. */
type Answer =
	| Readonly<{ kind: "ok" }>
	| Readonly<{ kind: "status"; status: number; retryAfter: Option.Option<number> }>
	| Readonly<{ kind: "slow" }>

/** Where the effective timeout comes from, if anywhere. */
type Timeout = Readonly<{ seconds: number; from: "the flag" | "the variable" }>

/** One run: what it sends, its flags and environment, and the server's answers, the last one repeating. */
type Case = Readonly<{
	send: Send
	unsafe: boolean
	retries: Option.Option<number>
	retriesVariable: boolean
	timeout: Option.Option<Timeout>
	answers: Arr.NonEmptyReadonlyArray<Answer>
}>

const RETRIED_STATUSES: Arr.NonEmptyReadonlyArray<number> = [408, 429, 500, 502, 503, 504]

/** How an attempt ended, as the model sees it. */
type Ended =
	| Readonly<{ kind: "success" }>
	| Readonly<{ kind: "status"; status: number; retryAfter: Option.Option<number> }>
	| Readonly<{ kind: "timeout" }>

/** The effective timeout in seconds, none for an untimed attempt: no timeout given, or `0`. */
const timedSeconds = (timeout: Option.Option<Timeout>): Option.Option<number> =>
	Option.filter(
		Option.map(timeout, (given) => given.seconds),
		(seconds) => seconds > 0
	)

/** How an answer ends an attempt: a slow answer times out under a timeout, and succeeds when untimed. */
const endedBy = (answer: Answer, timeout: Option.Option<Timeout>): Ended => {
	switch (answer.kind) {
		case "ok":
			return { kind: "success" }
		case "status":
			return answer
		case "slow":
			return Option.isSome(timedSeconds(timeout)) ? { kind: "timeout" } : { kind: "success" }
	}
}

const isRetriedOutcome = (ended: Ended): boolean =>
	ended.kind === "timeout" ||
	(ended.kind === "status" && Arr.contains(RETRIED_STATUSES, ended.status))

/** Whether the run's method is retried: an idempotent one, a POST carrying its key, or any under `--retry-unsafe`. */
const methodRetried = (c: Case): boolean => {
	if (c.unsafe) {
		return true
	}
	switch (c.send.kind) {
		case "item":
		case "blob":
			return true
		case "order":
			return Option.isSome(c.send.key)
		case "upload":
			return false
	}
}

const isOneShot = (send: Send): boolean => send.kind === "upload" && send.from === "stdin"

/** What the model says a run does: its attempts' answers, its retries, whether it named a one-shot body, its end. */
type Modelled = Readonly<{
	attempts: number
	retried: number
	unreplayable: boolean
	ended: Ended
	capped: Option.Option<number>
}>

/** The answer the server gives the attempt at `index`: its sequence's, the last repeating. */
const answerAt = (answers: Arr.NonEmptyReadonlyArray<Answer>, index: number): Answer =>
	Option.getOrElse(Arr.get(answers, index), () => Arr.lastNonEmpty(answers))

/** The retry rules run over the server's answers. */
const modelled = (c: Case): Modelled => {
	const budget = Option.getOrElse(c.retries, () => 0)
	const step = (index: number): Modelled => {
		const ended = endedBy(answerAt(c.answers, index), c.timeout)
		const stop = (unreplayable: boolean, capped: Option.Option<number>): Modelled => ({
			attempts: index + 1,
			retried: index,
			unreplayable,
			ended,
			capped
		})
		if (!methodRetried(c) || !isRetriedOutcome(ended) || index === budget) {
			return stop(false, Option.none())
		}
		if (isOneShot(c.send)) {
			return stop(true, Option.none())
		}
		const serverDelay = ended.kind === "status" ? ended.retryAfter : Option.none<number>()
		if (
			Option.isSome(serverDelay) &&
			Option.exists(timedSeconds(c.timeout), (seconds) => serverDelay.value > seconds)
		) {
			return stop(false, serverDelay)
		}
		return step(index + 1)
	}
	return step(0)
}

/** The JSON error a run's end names, none for a success. */
type ErrorObject = Readonly<{
	kind: string
	status: Option.Option<number>
	retryAfter: Option.Option<number>
}>

/** One attempt as the oracle compares it. */
type Attempt = Readonly<{
	method: string
	key: ReadonlyArray<string>
	sameBody: boolean
	framing: Option.Option<"length" | "chunked" | "none">
}>

/** What the oracle compares of a run. */
type Outcome = Readonly<{
	exitCode: number
	attempts: ReadonlyArray<Attempt>
	retryNotices: number
	unreplayable: boolean
	error: Option.Option<ErrorObject>
}>

/** The body bytes a run sends. */
const bodyOf = (send: Send): Uint8Array => {
	switch (send.kind) {
		case "item":
			return new Uint8Array(0)
		case "order":
			return latin1Bytes(NOTE)
		case "upload":
		case "blob":
			return octetBody()
	}
}

/** The framing the contract fixes for a send: none without a body, a length for JSON and a file; stdin's is open. */
const framingOf = (send: Send): Option.Option<"length" | "chunked" | "none"> => {
	switch (send.kind) {
		case "item":
			return Option.some("none")
		case "order":
		case "blob":
			return Option.some("length")
		case "upload":
			return send.from === "a file" ? Option.some("length") : Option.none()
	}
}

const keyOf = (send: Send): ReadonlyArray<string> =>
	send.kind === "order" ? Option.toArray(send.key) : []

/** The exit code a run's end gives: 0 for a success, 1 for a final status, 4 for a header timeout. */
const exitCodeOf = (ended: Ended): number => {
	switch (ended.kind) {
		case "success":
			return 0
		case "status":
			return 1
		case "timeout":
			return 4
	}
}

/** The JSON error a run's end names: none for a success, the server's capped delay on a final status. */
const errorOfEnd = (ended: Ended, capped: Option.Option<number>): Option.Option<ErrorObject> => {
	switch (ended.kind) {
		case "success":
			return Option.none()
		case "status":
			return Option.some({
				kind: "ApiResponseError",
				status: Option.some(ended.status),
				retryAfter: capped
			})
		case "timeout":
			return Option.some({
				kind: "TransportError",
				status: Option.none(),
				retryAfter: Option.none()
			})
	}
}

/** The run the model gives. */
const expectedOf = (c: Case): Outcome => {
	const model = modelled(c)
	const attempt: Attempt = {
		method: METHODS[operationOf(c.send)],
		key: keyOf(c.send),
		sameBody: true,
		framing: framingOf(c.send)
	}
	return {
		exitCode: exitCodeOf(model.ended),
		attempts: Array.from({ length: model.attempts }, () => attempt),
		retryNotices: model.retried,
		unreplayable: model.unreplayable,
		error: errorOfEnd(model.ended, model.capped)
	}
}

const ErrorLine = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({
			kind: Schema.String,
			status: Schema.optionalKey(Schema.Int),
			retryAfter: Schema.optionalKey(Schema.Int)
		})
	})
)

const decodeErrorLine = Schema.decodeUnknownOption(ErrorLine)

/** The one JSON error object stderr holds, none when no line is one. */
const errorOf = (lines: ReadonlyArray<string>): Option.Option<ErrorObject> =>
	Option.map(
		Arr.findFirst(lines, (line) => decodeErrorLine(line)),
		({ error }) => ({
			kind: error.kind,
			status: Option.fromNullishOr(error.status),
			retryAfter: Option.fromNullishOr(error.retryAfter)
		})
	)

/** A recorded attempt as the oracle compares it. */
const attemptOf =
	(c: Case) =>
	(request: WireRequest): Attempt => ({
		method: request.method,
		key: valuesOf(request.headers, "idempotency-key"),
		sameBody: Buffer.from(request.body).equals(bodyOf(c.send)),
		framing: Option.map(framingOf(c.send), () => {
			if (Arr.isReadonlyArrayNonEmpty(valuesOf(request.headers, "content-length"))) {
				return "length"
			}
			return Arr.contains(valuesOf(request.headers, "transfer-encoding"), "chunked")
				? "chunked"
				: "none"
		})
	})

const doneObject = (): Uint8Array => latin1Bytes('{"done":true}')

/** The server's response to an answer. */
const responseOf = (answer: Answer): ScriptedResponse => {
	switch (answer.kind) {
		case "ok":
			return {
				status: 200,
				headers: [["Content-Type", "application/json"]],
				delay: Duration.zero,
				body: { kind: "complete", bytes: doneObject() }
			}
		case "status":
			return {
				status: answer.status,
				headers: Option.match(answer.retryAfter, {
					onNone: () => [],
					onSome: (seconds) => [["Retry-After", String(seconds)]]
				}),
				delay: Duration.zero,
				body: { kind: "complete", bytes: new Uint8Array(0) }
			}
		case "slow":
			return {
				status: 200,
				headers: [["Content-Type", "application/json"]],
				delay: Duration.seconds(2),
				body: { kind: "complete", bytes: doneObject() }
			}
	}
}

/** A situation a case reaches. */
type Feature =
	| "a retried status retried"
	| "the budget spent"
	| "a status never retried"
	| "a POST not retried"
	| "--retry-unsafe"
	| "an Idempotency-Key"
	| "a one-shot body"
	| "a file body sent again"
	| "a Retry-After waited"
	| "a Retry-After past the timeout"
	| "a header timeout"
	| "no --retries"
	| "the retries variable ignored"
	| "the timeout variable"
	| "a zero timeout"

const FEATURES: Arr.NonEmptyReadonlyArray<Feature> = [
	"a retried status retried",
	"the budget spent",
	"a status never retried",
	"a POST not retried",
	"--retry-unsafe",
	"an Idempotency-Key",
	"a one-shot body",
	"a file body sent again",
	"a Retry-After waited",
	"a Retry-After past the timeout",
	"a header timeout",
	"no --retries",
	"the retries variable ignored",
	"the timeout variable",
	"a zero timeout"
]

const when = (holds: boolean, feature: Feature): ReadonlyArray<Feature> => (holds ? [feature] : [])

/** The features a case reaches. */
const caseFeatures = (c: Case): ReadonlyArray<Feature> => {
	const model = modelled(c)
	const firstEnded = endedBy(Arr.headNonEmpty(c.answers), c.timeout)
	const waited = Arr.some(
		Array.from({ length: model.retried }, (_, index) => index),
		(index) => {
			const answer = answerAt(c.answers, index)
			return answer.kind === "status" && Option.exists(answer.retryAfter, (seconds) => seconds > 0)
		}
	)
	return Arr.flatten<ReadonlyArray<ReadonlyArray<Feature>>>([
		when(model.retried > 0 && model.ended.kind === "success", "a retried status retried"),
		when(
			model.retried > 0 &&
				model.retried === Option.getOrElse(c.retries, () => 0) &&
				isRetriedOutcome(model.ended),
			"the budget spent"
		),
		when(
			methodRetried(c) &&
				Option.exists(c.retries, (retries) => retries > 0) &&
				model.ended.kind === "status" &&
				!isRetriedOutcome(model.ended) &&
				!(model.ended.status >= 200 && model.ended.status < 300),
			"a status never retried"
		),
		when(
			!methodRetried(c) &&
				Option.exists(c.retries, (retries) => retries > 0) &&
				isRetriedOutcome(firstEnded),
			"a POST not retried"
		),
		when(
			c.unsafe && METHODS[operationOf(c.send)] === "POST" && model.retried > 0,
			"--retry-unsafe"
		),
		when(
			c.send.kind === "order" && Option.isSome(c.send.key) && model.retried > 0,
			"an Idempotency-Key"
		),
		when(model.unreplayable, "a one-shot body"),
		when(
			(c.send.kind === "blob" || (c.send.kind === "upload" && c.send.from === "a file")) &&
				model.retried > 0,
			"a file body sent again"
		),
		when(waited, "a Retry-After waited"),
		when(Option.isSome(model.capped), "a Retry-After past the timeout"),
		when(
			Arr.some(
				Array.from({ length: model.attempts }, (_, index) => index),
				(index) => endedBy(answerAt(c.answers, index), c.timeout).kind === "timeout"
			),
			"a header timeout"
		),
		when(
			Option.isNone(c.retries) && !c.retriesVariable && isRetriedOutcome(firstEnded),
			"no --retries"
		),
		when(
			Option.isNone(c.retries) && c.retriesVariable && isRetriedOutcome(firstEnded),
			"the retries variable ignored"
		),
		when(
			Option.exists(c.timeout, (timeout) => timeout.from === "the variable"),
			"the timeout variable"
		),
		when(
			Option.exists(c.timeout, (timeout) => timeout.seconds === 0) &&
				Arr.some(
					Array.from({ length: model.attempts }, (_, index) => index),
					(index) => answerAt(c.answers, index).kind === "slow"
				),
			"a zero timeout"
		)
	])
}

/** A failure the server answers that the rules retry, asking for no wait or none at all. */
const RETRIED: Gen<Answer> = (source) => ({
	kind: "status",
	status: element(RETRIED_STATUSES)(source),
	retryAfter: weighted<Option.Option<number>>([
		[4, constant(Option.some(0))],
		[1, constant(Option.none())]
	])(source)
})

const OK: Answer = { kind: "ok" }

/** Any answer: mostly a retried failure or success, sometimes a status never retried, a long wait or a slow one. */
const ANSWER: Gen<Answer> = weighted<Answer>([
	[4, RETRIED],
	[3, constant(OK)],
	[
		1,
		(source) => ({
			kind: "status",
			status: element([400, 404, 409])(source),
			retryAfter: Option.none()
		})
	],
	[
		1,
		(source) => ({ kind: "status", status: 503, retryAfter: Option.some(element([1, 3])(source)) })
	],
	[1, constant<Answer>({ kind: "slow" })]
])

const SEND: Gen<Send> = weighted<Send>([
	[2, constant<Send>({ kind: "item" })],
	[2, (source) => ({ kind: "order", key: option(constant("key-1"))(source) })],
	[
		1,
		(source) => ({ kind: "upload", from: element<"stdin" | "a file">(["stdin", "a file"])(source) })
	],
	[1, constant<Send>({ kind: "blob" })]
])

const TIMEOUT: Gen<Option.Option<Timeout>> = weighted<Option.Option<Timeout>>([
	[2, constant(Option.none())],
	[
		1,
		(source) =>
			Option.some({
				seconds: element([0, 1, 2])(source),
				from: element<Timeout["from"]>(["the flag", "the variable"])(source)
			})
	]
])

/** A case with each choice drawn by these generators. */
const caseOf =
	(choices: {
		readonly send: Gen<Send>
		readonly unsafe: Gen<boolean>
		readonly retries: Gen<Option.Option<number>>
		readonly retriesVariable: Gen<boolean>
		readonly timeout: Gen<Option.Option<Timeout>>
		readonly answers: Gen<Arr.NonEmptyReadonlyArray<Answer>>
	}): Gen<Case> =>
	(source) => ({
		send: choices.send(source),
		unsafe: choices.unsafe(source),
		retries: choices.retries(source),
		retriesVariable: choices.retriesVariable(source),
		timeout: choices.timeout(source),
		answers: choices.answers(source)
	})

/** Answers: `first`, then up to two more drawn. */
const answersFrom =
	(first: Gen<Answer>, rest: Gen<Answer>): Gen<Arr.NonEmptyReadonlyArray<Answer>> =>
	(source) =>
		Arr.prepend(array(rest, { min: 0, max: 2 })(source), first(source))

const ANY_CASE = caseOf({
	send: SEND,
	unsafe: boolean,
	retries: option(element([0, 1, 2])),
	retriesVariable: boolean,
	timeout: TIMEOUT,
	answers: answersFrom(ANSWER, ANSWER)
})

/** A case made to reach `focus`, the rest drawn; with no focus, every choice drawn. */
const caseFor = (focus: Option.Option<Feature>): Gen<Case> => {
	if (Option.isNone(focus)) {
		return ANY_CASE
	}
	const retrying = {
		unsafe: constant(false),
		retriesVariable: boolean,
		timeout: constant(Option.none())
	}
	const item = constant<Send>({ kind: "item" })
	switch (focus.value) {
		case "a retried status retried":
			return caseOf({
				...retrying,
				send: item,
				retries: constant(Option.some(1)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "the budget spent":
			return caseOf({
				...retrying,
				send: item,
				retries: constant(Option.some(2)),
				answers: answersFrom(RETRIED, RETRIED)
			})
		case "a status never retried":
			return caseOf({
				...retrying,
				send: item,
				retries: constant(Option.some(2)),
				answers: answersFrom(
					constant<Answer>({ kind: "status", status: 404, retryAfter: Option.none() }),
					RETRIED
				)
			})
		case "a POST not retried":
			return caseOf({
				...retrying,
				send: constant<Send>({ kind: "order", key: Option.none() }),
				retries: constant(Option.some(2)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "--retry-unsafe":
			return caseOf({
				...retrying,
				unsafe: constant(true),
				send: constant<Send>({ kind: "order", key: Option.none() }),
				retries: constant(Option.some(1)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "an Idempotency-Key":
			return caseOf({
				...retrying,
				send: constant<Send>({ kind: "order", key: Option.some("key-1") }),
				retries: constant(Option.some(1)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "a one-shot body":
			return caseOf({
				...retrying,
				unsafe: constant(true),
				send: constant<Send>({ kind: "upload", from: "stdin" }),
				retries: constant(Option.some(1)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "a file body sent again":
			return caseOf({
				...retrying,
				unsafe: constant(true),
				send: element<Send>([{ kind: "blob" }, { kind: "upload", from: "a file" }]),
				retries: constant(Option.some(1)),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "a Retry-After waited":
			return caseOf({
				...retrying,
				send: item,
				retries: constant(Option.some(1)),
				answers: answersFrom(
					constant<Answer>({ kind: "status", status: 503, retryAfter: Option.some(1) }),
					constant(OK)
				)
			})
		case "a Retry-After past the timeout":
			return caseOf({
				...retrying,
				send: item,
				retries: constant(Option.some(1)),
				timeout: map(element<Timeout["from"]>(["the flag", "the variable"]), (from) =>
					Option.some({ seconds: 1, from })
				),
				answers: answersFrom(
					constant<Answer>({ kind: "status", status: 503, retryAfter: Option.some(3) }),
					constant(OK)
				)
			})
		case "a header timeout":
			return caseOf({
				...retrying,
				send: item,
				retries: option(constant(1)),
				timeout: map(element<Timeout["from"]>(["the flag", "the variable"]), (from) =>
					Option.some({ seconds: 1, from })
				),
				answers: answersFrom(constant<Answer>({ kind: "slow" }), constant(OK))
			})
		case "no --retries":
			return caseOf({
				...retrying,
				retriesVariable: constant(false),
				send: item,
				retries: constant(Option.none()),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "the retries variable ignored":
			return caseOf({
				...retrying,
				retriesVariable: constant(true),
				send: item,
				retries: constant(Option.none()),
				answers: answersFrom(RETRIED, constant(OK))
			})
		case "the timeout variable":
			return caseOf({
				...retrying,
				send: SEND,
				retries: option(element([0, 1])),
				timeout: map(element([1, 2]), (seconds) =>
					Option.some<Timeout>({ seconds, from: "the variable" })
				),
				answers: answersFrom(ANSWER, constant(OK))
			})
		case "a zero timeout":
			return caseOf({
				...retrying,
				send: item,
				retries: option(constant(1)),
				timeout: map(element<Timeout["from"]>(["the flag", "the variable"]), (from) =>
					Option.some<Timeout>({ seconds: 0, from })
				),
				answers: answersFrom(constant<Answer>({ kind: "slow" }), constant(OK))
			})
	}
}

/** A focus a case runs: while features are still pending, one of those; otherwise the drawn one. */
const aimedFocus = (
	drawnFocus: Option.Option<Feature>,
	k: SearchCase<Feature>
): Option.Option<Feature> =>
	Option.match(
		Option.flatMap(k.steering, (pending) =>
			Arr.match(
				Arr.filter(FEATURES, (feature) => pending.names(feature)),
				{
					onEmpty: () => Option.none(),
					onNonEmpty: (pendingFeatures) => Option.some(pendingFeatures)
				}
			)
		),
		{
			onNone: () => drawnFocus,
			onSome: (pendingFeatures) => Option.some(k.draw(element(pendingFeatures)))
		}
	)

/** A focus, or none, each half the time. */
const FOCUS: Gen<Option.Option<Feature>> = weighted<Option.Option<Feature>>([
	[1, constant(Option.none())],
	[1, map(element(FEATURES), Option.some)]
])

/** The arguments after the command that give a send's path parameter and body. */
const sendArgs = (send: Send, file: string): ReadonlyArray<string> => {
	switch (send.kind) {
		case "item":
			return ["r1"]
		case "order":
			return Arr.flatten([
				["r1"],
				Option.match(send.key, { onNone: () => [], onSome: (key) => ["--idempotency-key", key] }),
				["--note", "again"]
			])
		case "upload":
			return ["r1", "--body-file", send.from === "stdin" ? "-" : file]
		case "blob":
			return ["r1", "--body-file", file]
	}
}

/** The suite's fixture: the capture server, the package built against it, each operation's command, a body file. */
class RetryFixture extends Context.Service<
	RetryFixture,
	Readonly<{
		server: CaptureServer
		built: BuiltPackage
		commands: Readonly<Record<Operation, ReadonlyArray<string>>>
		file: string
	}>
>()("effect-openapi-cli-generator/test/generated/retry-policy.test/RetryFixture") {}

const fixture = Layer.effect(
	RetryFixture,
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const server = yield* captureServer
		const generated = yield* generateFixture({
			spec: { path: "openapi.json", text: spec },
			config: { path: "author-config.json", text: configOf(server.origins["127.0.0.1"]) },
			authorFiles: []
		})
		const built = yield* buildPackage(generated)
		const commands = yield* Effect.all(
			Rec.map(POINTERS, (pointer) =>
				Effect.map(
					Effect.fromOption(
						Arr.findFirst(generated.result.report.commandNames, (name) => name.pointer === pointer)
					),
					(name) => name.path
				)
			)
		)
		const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "retry-policy-" })
		const file = path.join(scratch, "octets.bin")
		yield* fs.writeFile(file, octetBody())
		return { server, built, commands, file }
	})
).pipe(Layer.provideMerge(harnessLayer))

layer(fixture, { excludeTestServices: true })("a generated CLI's retries", (it) => {
	it.effect("follow the retry rules over every answer the server gives", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const { server, built, commands, file } = yield* RetryFixture
				return yield* explore(
					{
						suite: "retry policy",
						oracle: {
							kind: "second-implementation",
							name: "a model of the retry rules run over the server's sequence of answers"
						},
						draw: drawn(FOCUS),
						literal: Formatter.format,
						coverage: required<Feature>(FEATURES, { cases: 24, sense: notesOnly }),
						kept: [],
						runs: 6,
						shrink: { kind: "bounded", candidates: 30 },
						concurrency: 1,
						steerEvery: 1,
						caseHang: Duration.seconds(60)
					},
					(drawnFocus, k) =>
						Effect.gen(function* () {
							const c = k.draw(caseFor(aimedFocus(drawnFocus, k)))
							k.noteAll(caseFeatures(c))
							const observed = yield* server.observe(
								(_request, attempt) => responseOf(answerAt(c.answers, attempt)),
								runBin(built, {
									args: Arr.flatten([
										commands[operationOf(c.send)],
										["--base-url", server.origins["127.0.0.1"], "--error-format", "json"],
										c.unsafe ? ["--retry-unsafe"] : [],
										Option.match(c.retries, {
											onNone: () => [],
											onSome: (retries) => ["--retries", String(retries)]
										}),
										Option.match(
											Option.filter(c.timeout, (timeout) => timeout.from === "the flag"),
											{
												onNone: () => [],
												onSome: (timeout) => ["--timeout", String(timeout.seconds)]
											}
										),
										sendArgs(c.send, file)
									]),
									env: {
										...(c.retriesVariable ? { RETRY_RETRIES: "5" } : {}),
										...Option.match(
											Option.filter(c.timeout, (timeout) => timeout.from === "the variable"),
											{
												onNone: () => ({}),
												onSome: (timeout) => ({ RETRY_TIMEOUT: String(timeout.seconds) })
											}
										)
									},
									stdin: isOneShot(c.send) ? octetBody() : new Uint8Array(0)
								})
							)
							const lines = Str.split("\n")(Buffer.from(observed.result.stderr).toString("utf8"))
							deepStrictEqual<Outcome>(
								{
									exitCode: observed.result.exitCode,
									attempts: Arr.map(observed.requests, attemptOf(c)),
									retryNotices: Arr.length(Arr.filter(lines, Str.startsWith("Notice: retrying "))),
									unreplayable: Arr.some(lines, Str.includes("unreplayableBody")),
									error: errorOf(lines)
								},
								expectedOf(c),
								"the attempts, the notices, the exit code and the error follow the retry rules"
							)
						})
				)
			})
		)
	)
})
