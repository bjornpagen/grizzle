/**
 * The one reading of grizzle's failures as the call errors a live answer ends with (live/events.ts callErrors), by
 * where each is met (live/events.ts failures): each source's table below, keyed by what failed there, gives the kind
 * of CallError each failure reads as, and its type holds every value to its source's kinds, so a producer of a source
 * makes only that source's errors (FailureOf). A read commits nothing, so a read's broken connection is `transport`,
 * as is a write's broken before its COMMIT was sent, which changed nothing; a write whose COMMIT went unanswered is
 * `commitUnknown`; and a session never opened is `unavailable`.
 */
import type {
	ApplyError,
	ExecutionReason,
	OpenError,
	OpenReason,
	ReadError,
	ReadReason,
	TransportReason
} from "#adapter/errors/execution.ts"
import type { SourceLoss, SourceRefusal } from "#adapter/live/source.ts"
import type {
	CallErrorKind,
	CallErrorOf,
	callErrors,
	FailureKind,
	FailureOf,
	FailureSource
} from "#compiler/live/index.ts"
import { callError, wireRefusals } from "#compiler/plan/runtime.ts"

/** The kinds of CallError whose payload is a message alone. */
type MessageKind = {
	readonly [K in CallErrorKind]: [
		Exclude<keyof (typeof callErrors)[K]["payload"], "message">
	] extends [never]
		? K
		: never
}[CallErrorKind]

/** Each kind of CallError whose payload is a message alone, with the error of it carrying a failure's own message. */
const messageErrors: { readonly [K in MessageKind]: (message: string) => CallErrorOf<K> } = {
	route: (message) => callError("route", { message }),
	input: (message) => callError("input", { message }),
	tokenRefused: (message) => callError("tokenRefused", { message }),
	tokenExpired: (message) => callError("tokenExpired", { message }),
	transport: (message) => callError("transport", { message }),
	unavailable: (message) => callError("unavailable", { message }),
	stale: (message) => callError("stale", { message }),
	commitUnknown: (message) => callError("commitUnknown", { message }),
	failed: (message) => callError("failed", { message })
}

/** A source's reading: each tag of what fails there, with the kind of CallError it reads as, one of the source's. */
type Reading<Tag extends string, S extends FailureSource> = { readonly [T in Tag]: FailureKind<S> }

/**
 * The HTTP door's refusals, before any member runs (http/request.ts, http/handler.ts): a request line no route serves;
 * a wire header naming no digest or another form of the member (live/events.ts wireRefusals); an Authorization header
 * holding no bearer token68, or no token where the role reads a context; a body that cannot be read, is no JSON text
 * in UTF-8, or does not parse as the member's input.
 */
const doorReading = {
	RouteUnserved: "route",
	WireAbsent: wireRefusals.absent,
	WireOther: wireRefusals.other,
	TokenUnreadable: "tokenRefused",
	TokenAbsent: "tokenRefused",
	BodyUnreadable: "input",
	BodyNoJson: "input",
	InputUnparsed: "input"
} as const satisfies Reading<string, "door">

/**
 * Why opening a Db failed: a token that is no token68, one verify refused, or claims or an `exp` that do not decode
 * are `tokenRefused`; a role no layer serves is no route; the rest is the server's own configuration.
 */
const openReading = {
	DbConfigRefused: "failed",
	ConnectionEnvironmentRefused: "failed",
	ServedLoginRefused: "failed",
	LiveSourceMissing: "failed",
	RoleOutsideLayers: "route",
	TokenMalformed: "tokenRefused",
	TokenError: "tokenRefused",
	ClaimRefused: "tokenRefused",
	ExpiryRefused: "tokenRefused",
	CompileError: "failed"
} as const satisfies Reading<OpenReason["_tag"], "open">

/**
 * Why a read failed, by its reason, and its refusals by SERIALIZABLE and by the fence by their class: a session
 * refused before anything was sent is `unavailable`; a connection broken while it ran is `transport`, since a read
 * commits nothing; the host's refusal of its input is `input`, and so is PostgreSQL's refusal of a parameter's value by
 * its pattern as it binds it; a refusal by laws, PostgreSQL's by a contract's or a pattern's domain (LawRejected) or an
 * explain's of the host's key parse (InputRejected), is `refused` with its laws; a serialization failure or a deadlock
 * is `transient`; the fence's refusal is `stale`; the rest is the server's.
 */
const readReading = {
	ServerError: "failed",
	LawRejected: "refused",
	InputRejected: "refused",
	ParamRejected: "input",
	CredentialError: "unavailable",
	TlsRefused: "unavailable",
	StartupRefused: "unavailable",
	ConnectTimedOut: "unavailable",
	SocketFailed: "unavailable",
	ConnectionClosed: "unavailable",
	DriverRefused: "unavailable",
	NoCancelKey: "unavailable",
	LayerReleased: "unavailable",
	ConnectionLost: "transport",
	CommitLost: "transport",
	DriverFailure: "transport",
	UnreadableAnswer: "failed",
	CompileError: "failed",
	EncodingFailure: "input",
	InputTooLarge: "input",
	TemporaryRefused: "failed",
	CallInputRefused: "input",
	TransientFailure: "transient",
	StaleSnapshot: "stale"
} as const satisfies Reading<ReadReason["_tag"] | Exclude<ReadError["_tag"], "ReadFailure">, "read">

/**
 * Why a write or a refresh failed, by the reason of its transport's or its execution's failure, and by its class
 * otherwise: its session could not be had, `unavailable`, or broke before its COMMIT was sent, `transport`; a relation
 * input past its bound, a parameter's value PostgreSQL refused by its pattern as it bound it, or an input the host
 * refused, `input`; a serialization failure or a concurrent writer's change, `transient`; the fence's refusal, `stale`;
 * a COMMIT sent and unanswered, `commitUnknown`; the rest is the server's.
 */
const applyReading = {
	CredentialError: "unavailable",
	TlsRefused: "unavailable",
	StartupRefused: "unavailable",
	ConnectTimedOut: "unavailable",
	SocketFailed: "unavailable",
	ConnectionClosed: "unavailable",
	DriverRefused: "unavailable",
	NoCancelKey: "unavailable",
	LayerReleased: "unavailable",
	ConnectionLost: "transport",
	DriverFailure: "transport",
	ServerError: "failed",
	ParamRejected: "input",
	CompileError: "failed",
	InputTooLarge: "input",
	TemporaryRefused: "failed",
	UnreadableAnswer: "failed",
	EncodingFailure: "input",
	CallInputRefused: "input",
	TransientFailure: "transient",
	StaleSnapshot: "stale",
	CommitUnknown: "commitUnknown"
} as const satisfies Reading<
	| TransportReason["_tag"]
	| ExecutionReason["_tag"]
	| Exclude<ApplyError["_tag"], "TransportFailure" | "ExecutionFailure">,
	"apply"
>

/**
 * What ends a live read's subscription (live/subscriptions.ts): its change source's refusal or loss, each `unavailable`,
 * which a client calls again, but an answer no format reads or a slot's secret that is no key, which are `failed`, and
 * a migration of the installation, `stale`; its layer's release, `unavailable`; a layer whose login's served file holds
 * no live source, `failed`; and its token's expiry, `tokenExpired`.
 */
const watchReading = {
	ServerError: "unavailable",
	LeaderFailed: "unavailable",
	UnreadableAnswer: "failed",
	SecretUnreadable: "failed",
	CredentialError: "unavailable",
	ConnectTimedOut: "unavailable",
	SocketFailed: "unavailable",
	StartupRefused: "unavailable",
	TlsRefused: "unavailable",
	ConnectionClosed: "unavailable",
	DriverRefused: "unavailable",
	NoCancelKey: "unavailable",
	ConnectionLost: "unavailable",
	DriverFailure: "unavailable",
	InputTooLarge: "unavailable",
	SlotAbsent: "unavailable",
	ListenerLost: "unavailable",
	SourceInvalidated: "unavailable",
	SourceMigrated: "stale",
	SourceClosed: "unavailable",
	Unsourced: "failed",
	TokenExpired: "tokenExpired"
} as const satisfies Reading<
	(SourceRefusal | SourceLoss)["_tag"] | "SourceClosed" | "Unsourced" | "TokenExpired",
	"watch"
>

/**
 * A ChangeSet's application that is a refusal, by its outcome's kind (types/db.ts ApplyOutcome): the laws', `refused`
 * with which laws and the witness; a fact outside the world relation, `outsideWorld`.
 */
const outcomeReading = {
	"invariant-rejected": "refused",
	"outside-world": "outsideWorld"
} as const satisfies Reading<string, "outcome">

/**
 * Every source's reading (live/events.ts failures), whose values are each source's kinds: what the document's error
 * union of an answer is held to (test/unit/live/openapi.test.ts).
 */
export const readings = {
	door: doorReading,
	open: openReading,
	read: readReading,
	watch: watchReading,
	apply: applyReading,
	outcome: outcomeReading
} as const satisfies { readonly [S in FailureSource]: Reading<string, S> }

/** The HTTP door's refusal `refusal` (doorReading), carrying its own message. */
export const doorRefusal = <T extends keyof typeof doorReading>(
	refusal: T,
	message: string
): CallErrorOf<(typeof doorReading)[T]> => messageErrors[doorReading[refusal]](message)

/** What ends a live read's subscription (watchReading), carrying its own message. */
export const watchError = (ended: keyof typeof watchReading, message: string): FailureOf<"watch"> =>
	messageErrors[watchReading[ended]](message)

/** The call error a Db's opening fails a served call with, its message the failure's. */
export const openCallError = (error: OpenError): FailureOf<"open"> =>
	messageErrors[openReading[error.reason._tag]](error.message)

/** The witness of a refusal PostgreSQL raised by a domain, which states no row. */
const unreported = { kind: "unreported" } as const

/** The call error a read fails with, its message the failure's. */
export const readCallError = (error: ReadError): FailureOf<"read"> => {
	switch (error._tag) {
		case "ReadFailure": {
			const reason = error.reason
			if (reason._tag === "LawRejected") {
				return callError(readReading.LawRejected, {
					message: error.message,
					refused: reason.refused,
					witness: unreported
				})
			}
			if (reason._tag === "InputRejected") {
				return callError(readReading.InputRejected, {
					message: error.message,
					refused: reason.refused,
					witness: reason.witness
				})
			}
			return messageErrors[readReading[reason._tag]](error.message)
		}
		case "TransientFailure":
			return callError(readReading.TransientFailure, {
				message: error.message,
				reason: error.reason._tag
			})
		case "StaleSnapshot":
			return messageErrors[readReading.StaleSnapshot](error.message)
	}
}

/** The call error a write or a refresh fails with, its message the failure's. */
export const applyCallError = (error: ApplyError): FailureOf<"apply"> => {
	switch (error._tag) {
		case "TransportFailure":
		case "ExecutionFailure":
			return messageErrors[applyReading[error.reason._tag]](error.message)
		case "TransientFailure":
			return callError(applyReading.TransientFailure, {
				message: error.message,
				reason: error.reason._tag
			})
		case "StaleSnapshot":
		case "CommitUnknown":
		case "EncodingFailure":
		case "CallInputRefused":
			return messageErrors[applyReading[error._tag]](error.message)
	}
}
