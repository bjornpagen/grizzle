import { Schema } from "effect"
import { fingerprintSchemas } from "#adapter/boundary/names.ts"
import {
	type AcquireRefusal,
	AcquireRefusalSchema,
	AdmissionFailed,
	AdmissionRefused,
	type AdmissionStage,
	AdmissionTransient,
	ClaimRefused,
	CommitLost,
	CompileErrorSchema,
	ConcurrentRefresh,
	ConnectionEnvironmentRefused,
	ConnectionLost,
	DbConfigRefused,
	Deadlock,
	DriverFailure,
	EncodingFailureSchema,
	GeneratedSerialUnique,
	HandleReleased,
	InputTooLarge,
	LawRejected,
	LoginNameRefused,
	MissingCapability,
	WorkloadUngenerated,
	PageRequestRefused,
	PutTargetConflict,
	RoleOutsideLayers,
	SerializationFailure,
	ServerError,
	SpanKeyChange,
	StaleReasonSchema,
	StaleStatement,
	TokenError,
	type TransientReason,
	TransientReasonSchema,
	UnreadableAnswer,
	UnseenOccupant
} from "#adapter/errors/failures.ts"

import type {
	EncodingFailure,
	TransientReason as EngineTransientReason
} from "#compiler/core/errors.ts"
import { sqlstateClass, sqlstates } from "#compiler/core/sqlstate.ts"

/**
 * The execution errors: exactly what the public API's error channels name, each a Schema.TaggedError carried in
 * Effect's error channel, whose classified case is its `reason`, one of failures.ts's classes, so Effect.catchReason,
 * catchReasons and unwrapReason reach it. What follows from a reason (an error's stage) is a getter, never a stored
 * field, and each error's `message` renders a sentence from its reason.
 *
 * Db.open and DbLayer.make fail with OpenError; a read with ReadError (ReadFailure, TransientFailure or StaleSnapshot),
 * a page also with the engine's CursorError; a write or refresh with ApplyError (the engine's EncodingFailure,
 * TransientFailure, TransportFailure, ExecutionFailure, CommitUnknown or StaleSnapshot); compile with
 * the engine's CompileError. `invariant-rejected` is an outcome value, never an error, and a defect stays a defect.
 * Every failure the server raised carries the server's own report (failures.ts ServerError): its SQLSTATE, message,
 * DETAIL and HINT as given.
 */

/**
 * Why opening a Db failed: no session (AcquireRefusal); a DbConfig no connection can use, or an environment that sets
 * a connection option grizzle cannot override; a role no provided layer serves, or a login with no role name; a token
 * verify refused or threw, or claims that do not decode through the role's contexts; a schema, snapshot or option
 * value that does not compile or parse (CompileError); an admission refused; an admission whose transaction
 * SERIALIZABLE refused, which is retryable (AdmissionTransient); or an admission that could not run to a verdict.
 */
const OpenReasonSchema = Schema.Union([
	AcquireRefusalSchema,
	DbConfigRefused,
	ConnectionEnvironmentRefused,
	RoleOutsideLayers,
	LoginNameRefused,
	TokenError,
	ClaimRefused,
	CompileErrorSchema,
	AdmissionRefused,
	AdmissionTransient,
	AdmissionFailed,
	MissingCapability,
	WorkloadUngenerated
])
export type OpenReason = typeof OpenReasonSchema.Type

/**
 * Where acquiring a session failed: the password Effect, TLS, authentication (a refusal of SQLSTATE class 28), anything
 * else on the way to ReadyForQuery, the acquisition wait budget, or a DbLayer whose scope has closed.
 */
type AcquireStage = "credential" | "tls" | "authentication" | "connect" | "wait" | "released"

/**
 * Where opening a Db failed: an acquisition's stage; `config`, a DbConfig or the environment's connection options
 * refused; `role`, a role no provided layer's login holds or a login with no role name; `token`, a token verify
 * refused or whose claims do not decode; `schema`, a value that does not compile or parse, or a layer whose snapshot
 * does not record its workloads (WorkloadUngenerated); admission's stage, `capability` for a workload program needing
 * an extension the database lacks too; or `admission`, an admission with no verdict, its transaction refused by
 * SERIALIZABLE (retryable) or failed otherwise.
 */
export type OpenStage =
	| AcquireStage
	| AdmissionStage
	| "config"
	| "role"
	| "token"
	| "schema"
	| "admission"

/** The stage of an acquisition's refusal. */
const acquireStage = (reason: AcquireRefusal): AcquireStage => {
	switch (reason._tag) {
		case "CredentialError":
			return "credential"
		case "TlsRefused":
			return "tls"
		case "StartupRefused":
			return sqlstateClass(reason.error.sqlstate) ===
				sqlstateClass(sqlstates.invalidAuthorizationSpecification)
				? "authentication"
				: "connect"
		case "ConnectTimedOut":
		case "SocketFailed":
		case "ConnectionClosed":
		case "DriverRefused":
		case "NoCancelKey":
			return "connect"
		case "AcquisitionBudgetExceeded":
			return "wait"
		case "LayerReleased":
			return "released"
	}
}

const openStage = (reason: OpenReason): OpenStage => {
	switch (reason._tag) {
		case "CredentialError":
		case "TlsRefused":
		case "StartupRefused":
		case "ConnectTimedOut":
		case "SocketFailed":
		case "ConnectionClosed":
		case "DriverRefused":
		case "NoCancelKey":
		case "AcquisitionBudgetExceeded":
		case "LayerReleased":
			return acquireStage(reason)
		case "DbConfigRefused":
		case "ConnectionEnvironmentRefused":
			return "config"
		case "RoleOutsideLayers":
		case "LoginNameRefused":
			return "role"
		case "TokenError":
		case "ClaimRefused":
			return "token"
		case "CompileError":
		case "WorkloadUngenerated":
			return "schema"
		case "AdmissionRefused": {
			const refused: AdmissionRefused = reason
			return refused.stage
		}
		case "AdmissionTransient":
		case "AdmissionFailed":
			return "admission"
		case "MissingCapability":
			return "capability"
	}
}

/** Opening a Db, or building a DbLayer, failed for `reason`, at the stage that reason fails at. */
export class OpenError extends Schema.TaggedError<OpenError, { readonly brand: unique symbol }>()(
	"OpenError",
	{
		reason: OpenReasonSchema
	}
) {
	get stage(): OpenStage {
		return openStage(this.reason)
	}

	override get message(): string {
		return `opening the database failed at stage ${this.stage}: ${this.reason.message}`
	}
}

/**
 * Why a read failed: the server refused its statement (ServerError); its session was not acquired (AcquireRefusal), or
 * its db.compile handle's Scope had ended (HandleReleased); the session it ran on failed (the connection lost, before or after COMMIT was sent; the driver; rows grizzle cannot
 * read); the compiler refused it before any SQL, for a query that does not compile for this Db or needs a capability
 * the admitted database lacks; or the host refused its input before any SQL: a codec's refusal, a ChangeSet's input a
 * law rejects (db.explain), a relation input past the size limit, or a page request.
 */
const ReadReasonSchema = Schema.Union([
	ServerError,
	AcquireRefusalSchema,
	HandleReleased,
	ConnectionLost,
	CommitLost,
	DriverFailure,
	UnreadableAnswer,
	CompileErrorSchema,
	MissingCapability,
	EncodingFailureSchema,
	LawRejected,
	InputTooLarge,
	PageRequestRefused
])
export type ReadReason = typeof ReadReasonSchema.Type

/** Where a read failed. */
export type ReadStage =
	| "acquire"
	| "transport"
	| "driver"
	| "resource"
	| "execute"
	| "decode"
	| "encode"
	| "request"
	| "compile"
	| "capability"

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
		case "AcquisitionBudgetExceeded":
		case "LayerReleased":
		case "HandleReleased":
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
		case "MissingCapability":
			return "capability"
		case "EncodingFailure":
		case "LawRejected":
			return "encode"
		case "InputTooLarge":
			return "resource"
		case "PageRequestRefused":
			return "request"
	}
}

/**
 * A read failed for `reason`. Its stage follows: a server's refusal is at stage `resource` when its SQLSTATE is a
 * runtime resource failure and at `execute` otherwise, an acquisition's and a released handle's at `acquire`, a session's at `transport`,
 * `driver` or `decode`, the compiler's at `compile` or `capability`, the host's at `encode`, `resource` or `request`.
 */
export class ReadFailure extends Schema.TaggedError<
	ReadFailure,
	{ readonly brand: unique symbol }
>()("ReadFailure", {
	reason: ReadReasonSchema
}) {
	get stage(): ReadStage {
		return readStage(this.reason)
	}

	override get message(): string {
		return `the read failed at stage ${this.stage}: ${this.reason.message}`
	}
}

/**
 * The database refused this attempt for a reason outside the call's inputs, and the attempt changed nothing: a
 * concurrent transaction's work met it, or a server statement the session had named went stale. This is what retryable
 * means, and the only call error it applies to (Db.open's is OpenError's AdmissionTransient): the same call with the
 * same inputs may succeed if it runs again. grizzle
 * makes one attempt per call and never retries; a caller that wants another attempt runs the call again (Effect.retry
 * with its own Schedule, while the error is a TransientFailure). `reason` says what grizzle read the refusal as, and
 * `error` is the server's report of it.
 */
export class TransientFailure extends Schema.TaggedError<
	TransientFailure,
	{ readonly brand: unique symbol }
>()("TransientFailure", { reason: TransientReasonSchema, error: ServerError }) {
	override get message(): string {
		return `the database refused this attempt, which changed nothing: ${this.reason.message}`
	}
}

/** The shell's reason of the engine's classification of a transient refusal. */
export const transientReason = (reason: EngineTransientReason): TransientReason => {
	switch (reason._tag) {
		case "SerializationFailure":
			return SerializationFailure.make()
		case "Deadlock":
			return Deadlock.make()
		case "PutTargetConflict":
			return PutTargetConflict.make({ relation: reason.relation })
		case "GeneratedSerialUnique":
			return GeneratedSerialUnique.make({
				relation: reason.relation,
				constraint: reason.constraint
			})
		case "SpanKeyChange":
			return SpanKeyChange.make({ relation: reason.relation })
		case "UnseenOccupant":
			return UnseenOccupant.make({ relation: reason.relation, constraint: reason.constraint })
		case "ConcurrentRefresh":
			return ConcurrentRefresh.make({ relation: reason.relation })
		case "StaleStatement":
			return StaleStatement.make()
	}
}

/**
 * The refusal SERIALIZABLE gives any transaction, a read's or a write's, as its TransientFailure: 40001, no serial
 * order, or 40P01, a deadlock; undefined for any other report.
 */
export const serializationRefusal = (error: ServerError): TransientFailure | undefined =>
	error.sqlstate === sqlstates.serializationFailure
		? TransientFailure.make({ reason: SerializationFailure.make(), error })
		: error.sqlstate === sqlstates.deadlockDetected
			? TransientFailure.make({ reason: Deadlock.make(), error })
			: undefined

/**
 * The database does not hold the snapshot this Db was admitted at, so the call ran nothing: the fence every transaction
 * of a Db takes first refused it, for `reason`. `snapshot` is the fingerprint the Db was opened with, and `error` the
 * server's report: the lock's 55P03, or the guard's 55Z02 or 55Z01. Not retryable: the same call on the same Db meets it
 * again until the migration completes, and after it a Db of the snapshot the database then holds runs the call.
 */
export class StaleSnapshot extends Schema.TaggedError<
	StaleSnapshot,
	{ readonly brand: unique symbol }
>()("StaleSnapshot", {
	reason: StaleReasonSchema,
	snapshot: fingerprintSchemas.schema,
	error: ServerError
}) {
	override get message(): string {
		return `the database does not hold the snapshot ${this.snapshot} the Db was opened with: ${this.reason.message}`
	}
}

/**
 * A failed read: at run time or refused before any SQL (ReadFailure), refused by SERIALIZABLE (40001 or 40P01, which a
 * read-only serializable transaction can meet too) or by a stale statement, the one failure the same read may not meet
 * again, or refused by the fence (StaleSnapshot).
 */
export type ReadError = ReadFailure | TransientFailure | StaleSnapshot

/**
 * Why a write or refresh changed nothing because its session could not be had or broke before COMMIT was sent: the
 * acquisition's refusal, its db.compile handle's ended Scope, or the connection lost or the driver failed.
 */
const TransportReasonSchema = Schema.Union([
	AcquireRefusalSchema,
	HandleReleased,
	ConnectionLost,
	DriverFailure
])
export type TransportReason = typeof TransportReasonSchema.Type

/** Where a write's transport failed. */
export type TransportStage = "acquire" | "transport" | "driver"

/** A write or refresh changed nothing for `reason`, at stage `acquire`, `transport` or `driver`. */
export class TransportFailure extends Schema.TaggedError<
	TransportFailure,
	{ readonly brand: unique symbol }
>()("TransportFailure", { reason: TransportReasonSchema }) {
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
 * (ServerError); the compiler refused the program, which does not compile for this Db or needs a capability the
 * database lacks; a relation input is past the size limit; or a statement answered rows grizzle cannot read, with what
 * its transaction then did.
 */
const ExecutionReasonSchema = Schema.Union([
	ServerError,
	CompileErrorSchema,
	MissingCapability,
	InputTooLarge,
	UnreadableAnswer
])
export type ExecutionReason = typeof ExecutionReasonSchema.Type

/** A write or refresh failed at execution, or the host refused it before any SQL was sent, for `reason`. */
export class ExecutionFailure extends Schema.TaggedError<
	ExecutionFailure,
	{ readonly brand: unique symbol }
>()("ExecutionFailure", { reason: ExecutionReasonSchema }) {
	override get message(): string {
		return `the write failed: ${this.reason.message}`
	}
}

/**
 * COMMIT was sent and no acknowledgement arrived; the change may be committed. Not retryable: what the database holds
 * is unknown, so a caller reads it back before deciding to run the call again.
 */
export class CommitUnknown extends Schema.TaggedError<
	CommitUnknown,
	{ readonly brand: unique symbol }
>()("CommitUnknown", {}) {
	override get message(): string {
		return "COMMIT was sent and no answer came: the change may have committed"
	}
}

/** The errors a write or refresh fails with. */
export type ApplyError =
	| EncodingFailure
	| TransientFailure
	| TransportFailure
	| ExecutionFailure
	| CommitUnknown
	| StaleSnapshot
