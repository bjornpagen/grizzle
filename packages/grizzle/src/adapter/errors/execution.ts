import * as Data from "effect/Data"
import {
	type AcquireRefusal,
	type ClaimRefused,
	CommitLost,
	ConcurrentRefresh,
	ConnectionEnvironmentRefused,
	ConnectionLost,
	DbConfigRefused,
	Deadlock,
	DriverFailure,
	type ExpiryRefused,
	GeneratedSerialUnique,
	InputRejected,
	InputTooLarge,
	LawRejected,
	type LiveSourceMissing,
	CallInputRefused,
	ParamRejected,
	PutTargetConflict,
	RoleOutsideLayers,
	SerializationFailure,
	ServedLoginRefused,
	ServerError,
	SpanKeyChange,
	type StaleReason,
	type TemporaryRefused,
	TokenError,
	type TokenMalformed,
	type TransientReason,
	UnreadableAnswer,
	UnseenOccupant
} from "#adapter/errors/failures.ts"
import { SchemaFingerprint, sqlstates } from "#compiler/plan/runtime.ts"

import type {
	CompileError,
	EncodingFailure,
	TransientReason as EngineTransientReason
} from "#compiler/plan/common.ts"

/**
 * The execution errors: exactly what the public API's error channels name, each a Data.TaggedError carried in
 * Effect's error channel, whose classified case is its `reason`, one of failures.ts's classes, so Effect.catchReason,
 * catchReasons and unwrapReason reach it. What follows from a reason (an error's stage) is a getter, never a stored
 * field, and each error's `message` renders a sentence from its reason.
 *
 * Db.open and DbLayer.make fail with OpenError; a read with ReadError (ReadFailure, TransientFailure or StaleSnapshot);
 * a write or refresh with ApplyError (the engine's EncodingFailure, TransientFailure, TransportFailure,
 * ExecutionFailure, CommitUnknown or StaleSnapshot); compile with the engine's CompileError. `invariant-rejected` is an
 * outcome value, never an error, and a defect stays a defect. A served member's call reads each as its one CallError
 * (live/call-error.ts).
 * Every failure the server raised carries the server's own report (failures.ts ServerError): its SQLSTATE, message,
 * DETAIL and HINT as given.
 */

/**
 * Why opening a Db or building a DbLayer failed, on the host, before anything is sent: a DbConfig no connection can
 * use, an environment that sets a connection option grizzle cannot override, or a served file of another login; a role no provided layer serves; a
 * token that is no token68, a token verify refused or threw, claims that do not decode through the role's contexts, or an `exp` that is no
 * NumericDate; a schema, login, snapshot or
 * option value that does not compile or parse (CompileError), a login whose role name the naming door refuses
 * included.
 */
export type OpenReason =
	| DbConfigRefused
	| ConnectionEnvironmentRefused
	| ServedLoginRefused
	| LiveSourceMissing
	| RoleOutsideLayers
	| TokenMalformed
	| TokenError
	| ClaimRefused
	| ExpiryRefused
	| CompileError

/**
 * Where opening a Db or building a DbLayer failed: `config`, a DbConfig or the environment's connection options
 * refused, or a served file of another login than the one it was served as; `role`, a role no provided layer's login holds or a login with no role name; `token`, a token that is no
 * token68, one verify refused, or one whose claims or `exp` do not decode; or `schema`, a value that does not compile or parse.
 */
export type OpenStage = "config" | "role" | "token" | "schema"

const openStage = (reason: OpenReason): OpenStage => {
	switch (reason._tag) {
		case "DbConfigRefused":
		case "ConnectionEnvironmentRefused":
		case "ServedLoginRefused":
		case "LiveSourceMissing":
			return "config"
		case "RoleOutsideLayers":
			return "role"
		case "TokenMalformed":
		case "TokenError":
		case "ClaimRefused":
		case "ExpiryRefused":
			return "token"
		case "CompileError":
			return "schema"
	}
}

/** Opening a Db or building a DbLayer failed for `reason`, at the stage that reason fails at. */
export class OpenError extends Data.TaggedError("OpenError")<{
	readonly reason: OpenReason
}> {
	get stage(): OpenStage {
		return openStage(this.reason)
	}

	override get message(): string {
		return `opening the database failed at stage ${this.stage}: ${this.reason.message}`
	}
}

/**
 * Why a read failed: the server refused its statement (ServerError), by a law of the schema (LawRejected) or a
 * parameter's pattern (ParamRejected) as the statement bound or cast a value; its session was not acquired
 * (AcquireRefusal); the session it ran on failed (the connection lost, before or after COMMIT was sent; the driver;
 * rows grizzle cannot read); the compiler refused it before any SQL, for a query that does not compile for this Db; the
 * server refused a temporary table a change member's explain creates to a role without TEMPORARY on the database; or
 * the host refused its input before any SQL: a codec's refusal, the exact parse's, a ChangeSet's input the host's parse
 * into its keyed sets refuses (a change member's explain, InputRejected), parameters past a bound of their transport,
 * or a call's input (CallInputRefused).
 */
export type ReadReason =
	| ServerError
	| LawRejected
	| ParamRejected
	| AcquireRefusal
	| ConnectionLost
	| CommitLost
	| DriverFailure
	| UnreadableAnswer
	| CompileError
	| EncodingFailure
	| InputRejected
	| InputTooLarge
	| TemporaryRefused
	| CallInputRefused

/** Where a read failed. */
export type ReadStage =
	| "acquire"
	| "transport"
	| "driver"
	| "resource"
	| "execute"
	| "decode"
	| "encode"
	| "input"
	| "compile"

/** The SQLSTATEs of a runtime resource failure, never a truncated result. */
const resourceStates: ReadonlySet<string> = new Set([
	sqlstates.outOfMemory,
	sqlstates.statementTooComplex
])

const readStage = (reason: ReadReason): ReadStage => {
	switch (reason._tag) {
		case "ServerError":
			return resourceStates.has(reason.sqlstate) ? "resource" : "execute"
		case "CredentialError":
		case "TlsRefused":
		case "StartupRefused":
		case "ConnectTimedOut":
		case "SocketFailed":
		case "ConnectionClosed":
		case "DriverRefused":
		case "NoCancelKey":
		case "LayerReleased":
			return "acquire"
		case "ConnectionLost":
		case "CommitLost":
			return "transport"
		case "DriverFailure":
			return "driver"
		case "UnreadableAnswer":
			return "decode"
		case "CompileError":
			return "compile"
		case "LawRejected":
		case "ParamRejected":
			return "execute"
		case "EncodingFailure":
		case "InputRejected":
			return "encode"
		case "InputTooLarge":
			return "resource"
		case "TemporaryRefused":
			return "execute"
		case "CallInputRefused":
			return "input"
	}
}

/**
 * A read failed for `reason`. Its stage follows: a server's refusal is at stage `resource` when its SQLSTATE is a
 * runtime resource failure and at `execute` otherwise, an acquisition's and a released handle's at `acquire`, a
 * session's at `transport`, `driver` or `decode`, the compiler's at `compile`, the host's at `encode`, `resource` or
 * `request`.
 */
export class ReadFailure extends Data.TaggedError("ReadFailure")<{ readonly reason: ReadReason }> {
	get stage(): ReadStage {
		return readStage(this.reason)
	}

	override get message(): string {
		return `the read failed at stage ${this.stage}: ${this.reason.message}`
	}
}

/**
 * The database refused this attempt for a reason outside the call's inputs, and the attempt changed nothing: a
 * concurrent transaction's work met it. This is what retryable means, and the only call error it applies to: the same
 * call with the same inputs may succeed if it runs again. grizzle makes one attempt per call and never retries; a caller
 * that wants another attempt runs the call again (Effect.retry
 * with its own Schedule, while the error is a TransientFailure). `reason` says what grizzle read the refusal as, R
 * the reasons the call can meet (a deferrable read's only a Deadlock, every other call's any), and `error` is the
 * server's report of it.
 */
export class TransientFailure<R extends TransientReason = TransientReason> extends Data.TaggedError(
	"TransientFailure"
)<{
	readonly reason: R
	readonly error: ServerError
}> {
	/** What grizzle read the refusal as, one of the reasons R the call can meet. */
	declare readonly reason: R

	override get message(): string {
		return `the database refused this attempt, which changed nothing: ${this.reason.message}`
	}
}

/** The shell's reason of the engine's classification of a transient refusal. */
export const transientReason = (reason: EngineTransientReason): TransientReason => {
	switch (reason._tag) {
		case "SerializationFailure":
			return new SerializationFailure()
		case "Deadlock":
			return new Deadlock()
		case "PutTargetConflict":
			return new PutTargetConflict({ relation: reason.relation })
		case "GeneratedSerialUnique":
			return new GeneratedSerialUnique({
				relation: reason.relation,
				constraint: reason.constraint
			})
		case "SpanKeyChange":
			return new SpanKeyChange({ relation: reason.relation })
		case "UnseenOccupant":
			return new UnseenOccupant({ relation: reason.relation, constraint: reason.constraint })
		case "ConcurrentRefresh":
			return new ConcurrentRefresh({ relation: reason.relation })
	}
}

/**
 * The refusal SERIALIZABLE gives any transaction, a read's or a write's, from the server's report: 40001, no serial
 * order, or 40P01, a deadlock; undefined for any other report: the one reading of it, a call's TransientFailure
 * (serializationRefusal).
 */
const serializableRefusal = (error: ServerError): SerializationFailure | Deadlock | undefined =>
	error.sqlstate === sqlstates.serializationFailure
		? new SerializationFailure()
		: error.sqlstate === sqlstates.deadlockDetected
			? new Deadlock()
			: undefined

/** SERIALIZABLE's refusal of a call's transaction as its TransientFailure, or undefined for any other report. */
export const serializationRefusal = (error: ServerError): TransientFailure | undefined => {
	const reason = serializableRefusal(error)
	return reason === undefined ? undefined : new TransientFailure({ reason, error })
}

/**
 * The refusal a deferrable read's transaction can meet from another's work, its TransientFailure: 40P01, a deadlock
 * among the heavyweight locks its statement waits on; undefined for any other report. Once its snapshot is safe it
 * takes no part in SSI, so PostgreSQL never refuses it with 40001, which is then the server's report like any other.
 */
export const deadlockRefusal = (error: ServerError): TransientFailure<Deadlock> | undefined =>
	error.sqlstate === sqlstates.deadlockDetected
		? new TransientFailure({ reason: new Deadlock(), error })
		: undefined

/**
 * The database does not hold the snapshot this Db was admitted at, so the call ran nothing: the fence every transaction
 * of a Db takes first refused it, for `reason`. `snapshot` is the fingerprint the Db was opened with, its snapshot.json's
 * `fingerprint`, which the constructor admits, and `error` the server's report: the lock's 55P03, or the guard's 55Z02
 * or 55Z01. Not retryable: the same call on the same Db meets it again until the migration completes, and after it a Db
 * of the snapshot the database then holds runs the call.
 */
export class StaleSnapshot extends Data.TaggedError("StaleSnapshot")<{
	readonly reason: StaleReason
	readonly snapshot: SchemaFingerprint
	readonly error: ServerError
}> {
	constructor(refused: {
		readonly reason: StaleReason
		readonly snapshot: string
		readonly error: ServerError
	}) {
		super({
			reason: refused.reason,
			snapshot: SchemaFingerprint(refused.snapshot),
			error: refused.error
		})
	}

	override get message(): string {
		return `the database does not hold the snapshot ${this.snapshot} the Db was opened with: ${this.reason.message}`
	}
}

/**
 * A failed read: at run time or refused before any SQL (ReadFailure), refused by SERIALIZABLE (40001 or 40P01, which a
 * read-only serializable transaction can meet too), or refused by the fence (StaleSnapshot).
 */
export type ReadError = ReadFailure | TransientFailure | StaleSnapshot

/**
 * A failed read of a deferrable member (deferrable(...)): as any read's (ReadError), but refused by another's work only
 * through a deadlock (deadlockRefusal), since its transaction, once its snapshot is safe, meets no serialization failure.
 */
export type DeferrableReadError = ReadFailure | TransientFailure<Deadlock> | StaleSnapshot

/**
 * Why a write or refresh changed nothing because its session could not be had or broke before COMMIT was sent: the
 * acquisition's refusal, its db.compile handle's ended Scope, or the connection lost or the driver failed.
 */
export type TransportReason = AcquireRefusal | ConnectionLost | DriverFailure

/** Where a write's transport failed. */
export type TransportStage = "acquire" | "transport" | "driver"

/** A write or refresh changed nothing for `reason`, at stage `acquire`, `transport` or `driver`. */
export class TransportFailure extends Data.TaggedError("TransportFailure")<{
	readonly reason: TransportReason
}> {
	get stage(): TransportStage {
		const reason = this.reason
		return reason._tag === "ConnectionLost"
			? "transport"
			: reason._tag === "DriverFailure"
				? "driver"
				: "acquire"
	}

	override get message(): string {
		return `the call changed nothing: ${this.reason.message}`
	}
}

/**
 * Why a write or refresh failed at execution, or was refused before any SQL: the server refused a statement
 * (ServerError), or a parameter's value outside its declared pattern as it bound it (ParamRejected); the compiler
 * refused the program, which does not compile for this Db; a relation input is past the size limit; the server refused a temporary table the write creates to a role
 * without TEMPORARY on the database (TemporaryRefused); or a statement answered rows grizzle cannot read, with what
 * its transaction then did.
 */
export type ExecutionReason =
	| ServerError
	| ParamRejected
	| CompileError
	| InputTooLarge
	| TemporaryRefused
	| UnreadableAnswer

/** A write or refresh failed at execution, or the host refused it before any SQL was sent, for `reason`. */
export class ExecutionFailure extends Data.TaggedError("ExecutionFailure")<{
	readonly reason: ExecutionReason
}> {
	override get message(): string {
		return `the write failed: ${this.reason.message}`
	}
}

/**
 * COMMIT was sent and no acknowledgement arrived; the change may be committed. Not retryable: what the database holds
 * is unknown, so a caller reads it back before deciding to run the call again.
 */
export class CommitUnknown extends Data.TaggedError("CommitUnknown") {
	override get message(): string {
		return "COMMIT was sent and no answer came: the change may have committed"
	}
}

/** The errors a write or refresh fails with. */
export type ApplyError =
	| CallInputRefused
	| EncodingFailure
	| TransientFailure
	| TransportFailure
	| ExecutionFailure
	| CommitUnknown
	| StaleSnapshot
