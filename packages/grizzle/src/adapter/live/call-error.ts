/**
 * The one reading of grizzle's failures as the call errors a live answer ends with (live/events.ts callErrors), by
 * where each is met (live/events.ts failures): each source's table below, keyed by what failed there, gives the kind
 * of CallError each failure reads as, and its type holds every value to its source's kinds, so a producer of a source
 * makes only that source's errors (FailureOf). A read commits nothing, so a read's broken connection is `transport`,
 * as is a write's broken before its COMMIT was sent, which changed nothing; a write whose COMMIT went unanswered is
 * `commitUnknown`. A session never opened is read by its cause, where the adapter classified it (failures.ts
 * AcquireRefusal), by the SQLSTATE or the socket's code it carries and never by its words: a connection that was not
 * authenticated is `credentialRefused`, and one that may be had later `unavailable`, each with its reason.
 */
import { constants } from "node:os"
import { Record as Rec } from "effect"
import type {
	ApplyError,
	ExecutionReason,
	OpenError,
	OpenReason,
	ReadError,
	ReadReason,
	TransportReason
} from "#adapter/errors/execution.ts"
import type { AcquireRefusal, ConnectionLost, TlsFault } from "#adapter/errors/failures.ts"
import type { LeaderReason } from "#adapter/live/leader.ts"
import type { SourceLoss, SourceRefusal } from "#adapter/live/source.ts"
import type {
	CallErrorIn,
	CallErrorKind,
	CallErrorOf,
	CredentialReason,
	callErrors,
	FailureKind,
	FailureOf,
	FailureSource,
	UnavailableCause
} from "#compiler/live/index.ts"
import {
	callError,
	type Sqlstate,
	sqlstateClass,
	sqlstates,
	wireRefusals
} from "#compiler/plan/runtime.ts"

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
 * Why a read failed, by its reason, and its refusals by SERIALIZABLE and by the fence by their class, a session never
 * had aside (connectCallError): a connection broken while it ran is `transport`, since a read commits nothing; the
 * host's refusal of its input is `input`, and so is PostgreSQL's refusal of a parameter's value by its pattern as it
 * binds it; a refusal by laws, PostgreSQL's by a contract's or a pattern's domain (LawRejected) or an explain's of the
 * host's key parse (InputRejected), is `refused` with its laws; a serialization failure or a deadlock is `transient`;
 * the fence's refusal is `stale`; the rest is the server's.
 */
const readReading = {
	ServerError: "failed",
	LawRejected: "refused",
	InputRejected: "refused",
	ParamRejected: "input",
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
} as const satisfies Reading<
	Exclude<ReadReason["_tag"], AcquireRefusal["_tag"]> | Exclude<ReadError["_tag"], "ReadFailure">,
	"read"
>

/**
 * Why a write or a refresh failed, by the reason of its transport's or its execution's failure, and by its class
 * otherwise, a session never had aside (connectCallError): its session broke before its COMMIT was sent, `transport`;
 * a relation input past its bound, a parameter's value PostgreSQL refused by its pattern as it bound it, or an input
 * the host refused, `input`; a serialization failure or a concurrent writer's change, `transient`; the fence's
 * refusal, `stale`; a COMMIT sent and unanswered, `commitUnknown`; the rest is the server's.
 */
const applyReading = {
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
	| Exclude<TransportReason["_tag"], AcquireRefusal["_tag"]>
	| ExecutionReason["_tag"]
	| Exclude<ApplyError["_tag"], "TransportFailure" | "ExecutionFailure">,
	"apply"
>

/**
 * What ends a live read's subscription (live/subscriptions.ts) as a kind of its own, besides its source's refusal of a
 * connection and its server's refusals (sourceCallError) and the causes that leave it unavailable (watchUnavailable):
 * an answer no format reads, a slot's secret that is no key, or a statement of its source past a bound, which meet the
 * same refusal again, `failed`; a migration of the installation, `stale`; a layer whose login's served file holds no
 * live source, `failed`; and its token's expiry, `tokenExpired`.
 */
const watchReading = {
	UnreadableAnswer: "failed",
	SecretUnreadable: "failed",
	InputTooLarge: "failed",
	SourceMigrated: "stale",
	Unsourced: "failed",
	TokenExpired: "tokenExpired"
} as const satisfies Reading<string, "watch">

/**
 * What ends a live read's subscription and leaves it `unavailable`, which a client calls again, by its reason: its
 * listening session's end, or a session of its source whose driver failed, `sessionLost`; the installation's slot not
 * standing yet, `slotAbsent`, or invalidated, `slotInvalidated`, each of which its leader makes; its layer's release,
 * `layerReleased`. A connection its source lost reads by who ended it (lostCallError).
 */
const watchUnavailable = {
	DriverFailure: "sessionLost",
	ListenerLost: "sessionLost",
	SlotAbsent: "slotAbsent",
	SourceInvalidated: "slotInvalidated",
	SourceClosed: "layerReleased"
} as const satisfies { readonly [tag: string]: UnavailableCause }

/**
 * A ChangeSet's application that is a refusal, by its outcome's kind (types/db.ts ApplyOutcome): the laws', `refused`
 * with which laws and the witness; a fact outside the world relation, `outsideWorld`.
 */
export const outcomeReading = {
	"invariant-rejected": "refused",
	"outside-world": "outsideWorld"
} as const satisfies Reading<string, "outcome">

/** Each tag of a refusal of a session (failures.ts AcquireRefusal), under itself: the roster is complete by its type. */
const acquireTags: { readonly [T in AcquireRefusal["_tag"]]: T } = {
	CredentialError: "CredentialError",
	ConnectTimedOut: "ConnectTimedOut",
	SocketFailed: "SocketFailed",
	StartupRefused: "StartupRefused",
	TlsRefused: "TlsRefused",
	ConnectionClosed: "ConnectionClosed",
	DriverRefused: "DriverRefused",
	NoCancelKey: "NoCancelKey",
	LayerReleased: "LayerReleased"
}

/** The tags of a refusal of a session (acquireTags). */
const acquireTagSet: ReadonlySet<string> = new Set(Rec.keys(acquireTags))

/** Whether a failure is a refusal of a session (failures.ts AcquireRefusal), by its tag. */
const isAcquireRefusal = (failure: { readonly _tag: string }): failure is AcquireRefusal =>
	acquireTagSet.has(failure._tag)

/** The kinds a refusal of a session reads as (connectCallError), under themselves: complete by their type. */
const connectKindRoster: { readonly [K in ConnectKind]: K } = {
	credentialRefused: "credentialRefused",
	unavailable: "unavailable",
	failed: "failed"
}

/**
 * The kinds a refusal of a session reads as: the connection not authenticated, `credentialRefused`; no session for
 * now, `unavailable`; a server that sends no cancellation key, which every attempt meets again, `failed`.
 */
type ConnectKind = "credentialRefused" | "unavailable" | "failed"

/** The kinds a refusal of a session reads as (connectKindRoster). */
const connectKinds: ReadonlyArray<ConnectKind> = Rec.values(connectKindRoster)

/**
 * Every source's reading (live/events.ts failures): the kinds each source's table reads its failures as, and for a
 * source that opens a session, the kinds a refusal of one reads as (connectKinds): what the document's error union of
 * an answer is held to (test/unit/live/openapi.test.ts).
 */
export const readings: { readonly [S in FailureSource]: ReadonlyArray<FailureKind<S>> } = {
	door: Rec.values(doorReading),
	open: Rec.values(openReading),
	read: [...Rec.values(readReading), ...connectKinds],
	watch: [...Rec.values(watchReading), ...connectKinds],
	apply: [...Rec.values(applyReading), ...connectKinds],
	outcome: Rec.values(outcomeReading)
}

/** The error `unavailable` for the named cause `cause`, carrying a failure's own message. */
const unavailable = (cause: UnavailableCause, message: string): CallErrorOf<"unavailable"> =>
	callError("unavailable", { message, reason: { kind: cause } })

/** The error `credentialRefused` for `reason`, carrying a failure's own message. */
const credentialRefused = (
	reason: CredentialReason,
	message: string
): CallErrorOf<"credentialRefused"> => callError("credentialRefused", { message, reason })

/**
 * The SQLSTATEs a server's refusal of a connection names a cause by, each with it: shut down by its administrator,
 * after a crash, or accepting no connection now, `serverDown`; every slot taken, `tooManyConnections`.
 */
const serverCauses: ReadonlyMap<Sqlstate, UnavailableCause> = new Map<Sqlstate, UnavailableCause>([
	[sqlstates.adminShutdown, "serverDown"],
	[sqlstates.crashShutdown, "serverDown"],
	[sqlstates.cannotConnectNow, "serverDown"],
	[sqlstates.tooManyConnections, "tooManyConnections"]
])

/**
 * The server's refusal with `sqlstate`, of a connection's startup or of a statement of a live source: class 28
 * (invalid authorization specification) is `credentialRefused`, 28P01 the password's and any other code of the class
 * the login's; a code serverCauses names is `unavailable` with its cause; any other is `unavailable`, `otherSqlstate`
 * with the code.
 */
const serverCallError = (
	sqlstate: Sqlstate,
	message: string
): CallErrorIn<"credentialRefused" | "unavailable"> => {
	if (sqlstateClass(sqlstate) === sqlstateClass(sqlstates.invalidAuthorizationSpecification)) {
		return credentialRefused(
			sqlstate === sqlstates.invalidPassword ? "passwordRefused" : "loginRefused",
			message
		)
	}
	const cause = serverCauses.get(sqlstate)
	return cause === undefined
		? callError("unavailable", { message, reason: { kind: "otherSqlstate", sqlstate } })
		: unavailable(cause, message)
}

/**
 * The socket codes a connection's failure names a cause by, each with it, its errno's name or the resolver's: nothing
 * accepting at the address, `connectionRefused`; no route, `hostUnreachable`; a name that did not resolve,
 * `hostUnresolved`; the socket's own timeout, `timedOut`; a connection reset or broken, `connectionClosed`.
 */
const socketCauses: ReadonlyMap<string, UnavailableCause> = new Map<string, UnavailableCause>([
	["ECONNREFUSED", "connectionRefused"],
	["ENOENT", "connectionRefused"],
	["EHOSTUNREACH", "hostUnreachable"],
	["ENETUNREACH", "hostUnreachable"],
	["EHOSTDOWN", "hostUnreachable"],
	["ENETDOWN", "hostUnreachable"],
	["ENOTFOUND", "hostUnresolved"],
	["EAI_AGAIN", "hostUnresolved"],
	["ETIMEDOUT", "timedOut"],
	["ECONNRESET", "connectionClosed"],
	["EPIPE", "connectionClosed"],
	["ECONNABORTED", "connectionClosed"]
])

/** The socket's failure with `code`: its cause where socketCauses names one, else `otherSocketCode` with the code. */
const socketCallError = (code: string, message: string): CallErrorOf<"unavailable"> => {
	const cause = socketCauses.get(code)
	return cause === undefined
		? callError("unavailable", { message, reason: { kind: "otherSocketCode", code } })
		: unavailable(cause, message)
}

/** The codes of this platform's system errors, by their errno's names (os.constants.errno). */
const systemErrors: ReadonlySet<string> = new Set(Rec.keys(constants.errno))

/**
 * TLS's failure: a handshake that failed with a system error's code (systemErrors) is the socket's, as
 * socketCallError reads it, since the connection failed under TLS and not TLS itself; any other code, a certificate
 * that does not verify or a negotiation that failed, and a server that offers no TLS or answers neither, is
 * `credentialRefused`, `tlsUnverified`: the server could not be authenticated.
 */
const tlsCallError = (
	fault: TlsFault,
	message: string
): CallErrorIn<"credentialRefused" | "unavailable"> =>
	fault.kind === "handshake" && systemErrors.has(fault.code)
		? socketCallError(fault.code, message)
		: credentialRefused("tlsUnverified", message)

/**
 * A session never had, by its cause (failures.ts AcquireRefusal), carrying a failure's own message: the password
 * Effect's failure, `passwordFailed`, and pg's own end of the startup, `driverRefused`, are `credentialRefused`; the
 * server's refusal by its SQLSTATE (serverCallError), the socket's by its code (socketCallError) and TLS's by its fault
 * (tlsCallError); no answer within the connect timeout, `timedOut`, and a connection closed before it was ready,
 * `connectionClosed`, are `unavailable`; a server that sends no cancellation key is `failed`, since every attempt
 * meets it; and a released layer is `unavailable`, `layerReleased`.
 */
const connectCallError = (refusal: AcquireRefusal, message: string): CallErrorIn<ConnectKind> => {
	switch (refusal._tag) {
		case "CredentialError":
			return credentialRefused("passwordFailed", message)
		case "StartupRefused":
			return serverCallError(refusal.error.sqlstate, message)
		case "SocketFailed":
			return socketCallError(refusal.code, message)
		case "TlsRefused":
			return tlsCallError(refusal.fault, message)
		case "ConnectTimedOut":
			return unavailable("timedOut", message)
		case "ConnectionClosed":
			return unavailable("connectionClosed", message)
		case "DriverRefused":
			return credentialRefused("driverRefused", message)
		case "NoCancelKey":
			return messageErrors.failed(message)
		case "LayerReleased":
			return unavailable("layerReleased", message)
	}
}

/**
 * A connection a live source's session lost: one the server ended with its report reads by its SQLSTATE
 * (serverCallError), 57P01 `serverDown` among them; one the transport lost, `unavailable`, `sessionLost`.
 */
const lostCallError = (
	lost: ConnectionLost,
	message: string
): CallErrorIn<"credentialRefused" | "unavailable"> =>
	lost.ended.by === "server"
		? serverCallError(lost.ended.error.sqlstate, message)
		: unavailable("sessionLost", message)

/**
 * The failure of the process's candidacy for the installation's live leader, by its cause: a refused connection as
 * connectCallError reads it; the server's refusal of a statement, of a fan-out's statement or of its COMMIT by its
 * SQLSTATE (serverCallError); a connection lost as lostCallError reads it; a fan-out's COMMIT whose answer was lost, a
 * driver's failure, or a replication stream silent past its deadline, `sessionLost`, a session of the leader lost; and
 * any other cause, an answer, a message or a secret it cannot read, a statement past a bound, or a stream the server
 * ended, `leaderFailed`, since the next candidacy runs afresh.
 */
const leaderCallError = (reason: LeaderReason, message: string): CallErrorIn<ConnectKind> => {
	if (isAcquireRefusal(reason)) {
		return connectCallError(reason, message)
	}
	switch (reason._tag) {
		case "ServerError":
			return serverCallError(reason.sqlstate, message)
		case "BatchRefused":
		case "CommitRefused":
			return serverCallError(reason.failure.sqlstate, message)
		case "ConnectionLost":
			return lostCallError(reason, message)
		case "CommitLost":
		case "DriverFailure":
		case "ReplicationSilent":
			return unavailable("sessionLost", message)
		case "UnreadableAnswer":
		case "InputTooLarge":
		case "ReplicationEnded":
		case "MessageUnreadable":
		case "ChangesUnroutable":
		case "SecretUnreadable":
		case "SenderTimeoutUnreadable":
			return unavailable("leaderFailed", message)
	}
}

/** The HTTP door's refusal `refusal` (doorReading), carrying its own message. */
export const doorRefusal = <T extends keyof typeof doorReading>(
	refusal: T,
	message: string
): CallErrorOf<(typeof doorReading)[T]> => messageErrors[doorReading[refusal]](message)

/**
 * What ends a live read's subscription by its change source's refusal or loss, carrying `message`: a refused
 * connection (connectCallError), the server's refusal by its SQLSTATE (serverCallError), a lost connection by who
 * ended it (lostCallError), the leader's failure by its cause (leaderCallError), a cause that leaves it unavailable
 * (watchUnavailable), or one of a kind of its own (watchReading).
 */
export const sourceCallError = (
	reason: SourceRefusal | SourceLoss,
	message: string
): FailureOf<"watch"> => {
	if (isAcquireRefusal(reason)) {
		return connectCallError(reason, message)
	}
	switch (reason._tag) {
		case "ServerError":
			return serverCallError(reason.sqlstate, message)
		case "LeaderFailed":
			return leaderCallError(reason.reason, message)
		case "ConnectionLost":
			return lostCallError(reason, message)
		case "DriverFailure":
		case "ListenerLost":
		case "SlotAbsent":
		case "SourceInvalidated":
			return unavailable(watchUnavailable[reason._tag], message)
		case "UnreadableAnswer":
		case "SecretUnreadable":
		case "InputTooLarge":
		case "SourceMigrated":
			return messageErrors[watchReading[reason._tag]](message)
	}
}

/**
 * What ends a live read's subscription besides its source, carrying its own message: its layer's release,
 * `unavailable`, `layerReleased` (watchUnavailable); a layer whose login's served file holds no live source, or its
 * token's expiry (watchReading).
 */
export const watchEnded = (
	ended: "SourceClosed" | "Unsourced" | "TokenExpired",
	message: string
): FailureOf<"watch"> =>
	ended === "SourceClosed"
		? unavailable(watchUnavailable[ended], message)
		: messageErrors[watchReading[ended]](message)

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
			if (isAcquireRefusal(reason)) {
				return connectCallError(reason, error.message)
			}
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
		case "TransportFailure": {
			const reason = error.reason
			return isAcquireRefusal(reason)
				? connectCallError(reason, error.message)
				: messageErrors[applyReading[reason._tag]](error.message)
		}
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
