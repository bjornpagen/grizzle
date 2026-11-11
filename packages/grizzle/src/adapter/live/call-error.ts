/**
 * The one reading of grizzle's failures as the call errors a live answer ends with (live/events.ts callErrors): every
 * error a Db's open, read or write fails with, each by its class and its reason's, through the tables below. A read
 * commits nothing, so a read's broken connection is `transport`, as is a write's broken before its COMMIT was sent,
 * which changed nothing; a write whose COMMIT went unanswered is `commitUnknown`; and a session never opened is
 * `unavailable`.
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
import { type CallError, callError } from "#compiler/plan/runtime.ts"

/** The call errors grizzle's failures read as, each carrying the failure's own message. */
const failed = (message: string): CallError => callError("failed", { message })
const input = (message: string): CallError => callError("input", { message })
const route = (message: string): CallError => callError("route", { message })
const tokenRefused = (message: string): CallError => callError("tokenRefused", { message })
const transport = (message: string): CallError => callError("transport", { message })
const unavailable = (message: string): CallError => callError("unavailable", { message })
const stale = (message: string): CallError => callError("stale", { message })
const commitUnknown = (message: string): CallError => callError("commitUnknown", { message })

/** A failure's reasons by tag, each with the call error it reads as. */
type Reading<R extends { readonly _tag: string }> = {
	readonly [T in R["_tag"]]: (message: string) => CallError
}

/**
 * Why opening a Db failed: a token that is no token68, one verify refused, or claims or an `exp` that do not decode are
 * `tokenRefused`; a role no layer
 * serves is no route; the rest is the server's own configuration.
 */
const openReading: Reading<OpenReason> = {
	DbConfigRefused: failed,
	ConnectionEnvironmentRefused: failed,
	ServedLoginRefused: failed,
	LiveSourceMissing: failed,
	RoleOutsideLayers: route,
	TokenMalformed: tokenRefused,
	TokenError: tokenRefused,
	ClaimRefused: tokenRefused,
	ExpiryRefused: tokenRefused,
	CompileError: failed
}

/**
 * Why a read failed: a session refused before anything was sent is `unavailable`; a connection broken while it ran is
 * `transport`, since a read commits nothing; the host's refusal of its input is `input`; the rest is the server's.
 */
const readReading: Reading<ReadReason> = {
	ServerError: failed,
	CredentialError: unavailable,
	TlsRefused: unavailable,
	StartupRefused: unavailable,
	ConnectTimedOut: unavailable,
	SocketFailed: unavailable,
	ConnectionClosed: unavailable,
	DriverRefused: unavailable,
	NoCancelKey: unavailable,
	LayerReleased: unavailable,
	HandleReleased: unavailable,
	ConnectionLost: transport,
	CommitLost: transport,
	DriverFailure: transport,
	UnreadableAnswer: failed,
	CompileError: failed,
	EncodingFailure: input,
	LawRejected: input,
	InputTooLarge: input,
	TemporaryRefused: failed,
	CallInputRefused: input
}

/**
 * Why a write changed nothing: its session could not be had, `unavailable`, or broke before its COMMIT was sent,
 * `transport`.
 */
const transportReading: Reading<TransportReason> = {
	CredentialError: unavailable,
	TlsRefused: unavailable,
	StartupRefused: unavailable,
	ConnectTimedOut: unavailable,
	SocketFailed: unavailable,
	ConnectionClosed: unavailable,
	DriverRefused: unavailable,
	NoCancelKey: unavailable,
	LayerReleased: unavailable,
	HandleReleased: unavailable,
	ConnectionLost: transport,
	DriverFailure: transport
}

/** Why a write failed at execution: a relation input past its bound is `input`; the rest is the server's. */
const executionReading: Reading<ExecutionReason> = {
	ServerError: failed,
	CompileError: failed,
	InputTooLarge: input,
	TemporaryRefused: failed,
	UnreadableAnswer: failed
}

/** The call error a Db's open, read or write failure ends a live answer with, its message the failure's. */
export const callErrorOf = (error: OpenError | ReadError | ApplyError): CallError => {
	switch (error._tag) {
		case "OpenError":
			return openReading[error.reason._tag](error.message)
		case "ReadFailure":
			return readReading[error.reason._tag](error.message)
		case "TransportFailure":
			return transportReading[error.reason._tag](error.message)
		case "ExecutionFailure":
			return executionReading[error.reason._tag](error.message)
		case "TransientFailure":
			return callError("transient", { message: error.message, reason: error.reason._tag })
		case "StaleSnapshot":
			return stale(error.message)
		case "CommitUnknown":
			return commitUnknown(error.message)
		case "EncodingFailure":
		case "CallInputRefused":
			return input(error.message)
	}
}
