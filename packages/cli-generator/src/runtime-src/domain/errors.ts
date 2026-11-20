import { Array as Arr, Data, type Option, Runtime } from "effect"
import { CliError } from "effect/cli"

/**
 * Flag or `--body` validation, mutually exclusive inputs, a refused header or cookie value,
 * binary output to a terminal.
 */
export class UsageError extends Data.TaggedError("UsageError")<{
	readonly flag?: string
	readonly message: string
}> {
	override readonly [Runtime.errorExitCode] = 2

	override get [CliError.userMessage](): string {
		return this.message
	}
}

/**
 * No security alternative of the operation is satisfiable.
 */
export class CredentialMissing extends Data.TaggedError("CredentialMissing")<{
	readonly alternatives: ReadonlyArray<string>
	readonly operation: string
}> {
	override readonly [Runtime.errorExitCode] = 3

	override get [CliError.userMessage](): string {
		return `${this.operation} needs a credential: ${Arr.join(this.alternatives, " or ")}`
	}
}

/**
 * The final status was not 2xx. Exits 3 for 401 and 403, otherwise 1. `matched` is the OpenAPI response key the status
 * matched (a status code 100-599, a range 1XX-5XX, or `default`), or `undeclared`; `body` is the response body, read
 * whole and scrubbed of the run's recorded values; `requestId` is the declared request-id header's value, scrubbed and
 * sanitized.
 */
export class ApiResponseError extends Data.TaggedError("ApiResponseError")<{
	readonly body: string
	readonly matched: string
	readonly mediaType?: string
	readonly operation: string
	readonly requestId?: string
	readonly retryAfterSeconds?: number
	readonly status: number
}> {
	override get [Runtime.errorExitCode](): number {
		return this.status === 401 || this.status === 403 ? 3 : 1
	}

	override get [CliError.userMessage](): string {
		return `${this.operation} returned ${this.status} (matched ${this.matched})`
	}
}

/**
 * A 2xx event stream ended at an event its contract names a failure, after printing it: exit 1, the API-error exit.
 * `data` is the event's data, scrubbed and sanitized as an error body is; `dataJson` is the same data as one compact JSON
 * text, scrubbed, when the event's contract says its data is JSON, which `--error-format json` prints as a JSON value;
 * `retrySafe` is the event's own word that the request took no effect, so running the command again is safe.
 */
export class StreamEventError extends Data.TaggedError("StreamEventError")<{
	readonly data: string
	readonly dataJson: Option.Option<string>
	readonly event: string
	readonly itemIndex: number
	readonly operation: string
	readonly retrySafe: boolean
}> {
	override readonly [Runtime.errorExitCode] = 1

	override get [CliError.userMessage](): string {
		return `${this.operation} sent the failure event ${this.event} at item ${this.itemIndex}`
	}
}

/**
 * A connect, DNS, TLS, timeout or abort failure. The URL arrives already redacted.
 */
export class TransportError extends Data.TaggedError("TransportError")<{
	readonly reason: "connect" | "dns" | "tls" | "timeout" | "aborted"
	readonly url: string
}> {
	override readonly [Runtime.errorExitCode] = 4

	override get [CliError.userMessage](): string {
		return `request to ${this.url} failed: ${this.reason}`
	}
}

/**
 * The runtime redirect loop refused a hop. Origins only, never a full `Location`.
 */
export class RedirectRefused extends Data.TaggedError("RedirectRefused")<{
	readonly from: string
	readonly reason:
		| "crossOriginBody"
		| "downgrade"
		| "loop"
		| "scheme"
		| "userinfo"
		| "unreplayableBody"
	readonly to: string
}> {
	override readonly [Runtime.errorExitCode] = 4

	override get [CliError.userMessage](): string {
		return `redirect from ${this.from} to ${this.to} refused: ${this.reason}`
	}
}

/**
 * Sequential decoding failed, a response body stream went idle, a record's or an event field's bytes are no UTF-8
 * (`invalidText`), or an event stream sent an event its contract does not admit (`unexpectedEvent`) or data its event's
 * schema refuses (`invalidData`).
 */
export class ResponseStreamError extends Data.TaggedError("ResponseStreamError")<{
	readonly itemIndex?: number
	readonly reason:
		| "truncated"
		| "recordTooLarge"
		| "invalidFraming"
		| "idleTimeout"
		| "invalidText"
		| "unexpectedEvent"
		| "invalidData"
}> {
	override readonly [Runtime.errorExitCode] = 5

	override get [CliError.userMessage](): string {
		return this.itemIndex === undefined
			? `response stream failed: ${this.reason}`
			: `response stream failed at item ${this.itemIndex}: ${this.reason}`
	}
}

/**
 * `--output` found an existing path or could not write.
 */
export class OutputError extends Data.TaggedError("OutputError")<{
	readonly path: string
	readonly reason: "exists" | "write"
}> {
	override readonly [Runtime.errorExitCode] = 5

	override get [CliError.userMessage](): string {
		return `cannot write ${this.path}: ${this.reason}`
	}
}
