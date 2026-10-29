import { Schema } from "effect"
import { LawSchema } from "#adapter/boundary/law.ts"
import { nameSchemas, SqlstateSchema } from "#adapter/boundary/names.ts"
import { EncodingFailure, isCompileError } from "#compiler/core/errors.ts"

/**
 * The reasons of grizzle's errors, and the wire's own classification of a flight's failure.
 *
 * Every error the public API's channels name (execution.ts) carries what happened as its `reason`: one of the classes
 * here, each a Schema.TaggedError, so Effect.catchReason, catchReasons and unwrapReason reach it, and each rendering
 * its own `message`. A reason states only what happened, as data: whatever follows from it (an error's stage, a pool's
 * saturation) is a getter, never a stored field. `cause` is only a foreign value wrapped: what the password Effect
 * (CredentialError) or the layer's verify (TokenError) failed with or threw. The adapter classifies each failure once,
 * where it happens: a connection attempt where pg reports it (wire/session.ts), a statement's answer where its flight
 * drains (wire/batch.ts), an admission where it compares (adapter/admission).
 */

/** A CompileError, the engine's plain class, as a reason: recognized by the engine's tag guard. */
export const CompileErrorSchema = Schema.declare(isCompileError, { expected: "CompileError" })

/** An EncodingFailure, the engine's plain class, as a reason. */
export const EncodingFailureSchema = Schema.instanceOf(EncodingFailure)

const MaybeText = Schema.UndefinedOr(Schema.String)

/**
 * An ErrorResponse: PostgreSQL refused a statement with one. It keeps the SQLSTATE, the message (its `message`), DETAIL
 * and HINT as the server gave them, and the identity fields, each the installed name it is, admitted once where the
 * wire reads the ErrorResponse: the constraint, the schema, the table, the column, and the data type, which a domain
 * constraint's violation reports as its domain; each undefined when the server did not report it. It is built in one
 * place, from pg's DatabaseError (adapter/wire/failure.ts serverFailure), and every failure the server raised carries
 * it as it is, so no layer re-states, re-admits or drops what the server said; the application decides what to log.
 */
export class ServerError extends Schema.TaggedError<
	ServerError,
	{ readonly brand: unique symbol }
>()("ServerError", {
	sqlstate: SqlstateSchema,
	message: Schema.String,
	constraint: Schema.UndefinedOr(nameSchemas.constraint),
	schema: Schema.UndefinedOr(nameSchemas.schema),
	table: Schema.UndefinedOr(nameSchemas.relation),
	column: Schema.UndefinedOr(nameSchemas.column),
	dataType: Schema.UndefinedOr(nameSchemas.domain),
	detail: MaybeText,
	hint: MaybeText
}) {}

/** The server's report, as a sentence names it: its SQLSTATE and its message. */
const reportText = (error: ServerError): string => `SQLSTATE ${error.sqlstate}: ${error.message}`

/**
 * A password Effect failed, for example an AWS provider that could not resolve credentials: the application fails its
 * password Effect with it, the provider's failure as its `cause`. grizzle never fails with it on its own: it is the
 * reason of an OpenError, a ReadFailure or a TransportFailure, at stage `credential`.
 */
export class CredentialError extends Schema.TaggedError<
	CredentialError,
	{ readonly brand: unique symbol }
>()("CredentialError", { cause: Schema.Unknown }) {
	override get message(): string {
		return "the password Effect failed"
	}
}

/**
 * No answer came within the connect budget: the server or a waking provider took longer to reach ReadyForQuery, or
 * nothing answered at all.
 */
export class ConnectTimedOut extends Schema.TaggedError<
	ConnectTimedOut,
	{ readonly brand: unique symbol }
>()("ConnectTimedOut", { millis: Schema.Finite }) {
	override get message(): string {
		return `no answer within the connect budget of ${this.millis} ms`
	}
}

/**
 * The transport failed with a socket error code, such as ECONNREFUSED (nothing listens), ENOTFOUND (the host does not
 * resolve) or ECONNRESET.
 */
export class SocketFailed extends Schema.TaggedError<
	SocketFailed,
	{ readonly brand: unique symbol }
>()("SocketFailed", { code: Schema.String }) {
	override get message(): string {
		return `the socket failed (${this.code})`
	}
}

/**
 * The server refused the startup with an ErrorResponse, such as 28P01 for a wrong password, 53300 for too many
 * connections or 3D000 for no such database: `error` is its report. Its stage is `authentication` for SQLSTATE class 28
 * (invalid authorization) and `connect` for any other.
 */
export class StartupRefused extends Schema.TaggedError<
	StartupRefused,
	{ readonly brand: unique symbol }
>()("StartupRefused", { error: ServerError }) {
	override get message(): string {
		return `the server refused the login with ${reportText(this.error)}`
	}
}

/**
 * Why TLS failed: the handshake failed with Node's code (a certificate that does not verify, such as CERT_HAS_EXPIRED or
 * ERR_TLS_CERT_ALTNAME_INVALID, or a failed negotiation, ERR_SSL_*); the server answered the SSLRequest with N, so it
 * offers no TLS; it answered with neither S nor N; or the CA bundle is empty, so nothing could verify.
 */
const TlsFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("handshake"), code: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("notOffered") }),
	Schema.Struct({ kind: Schema.Literal("unanswered") }),
	Schema.Struct({ kind: Schema.Literal("noAuthority") })
])
export type TlsFault = typeof TlsFaultSchema.Type

const tlsFaultText = (fault: TlsFault): string => {
	switch (fault.kind) {
		case "handshake":
			return `TLS did not verify (${fault.code})`
		case "notOffered":
			return "the server offers no TLS"
		case "unanswered":
			return "the server answered the TLS request with neither yes nor no"
		case "noAuthority":
			return "the CA bundle is empty, so no certificate can verify"
	}
}

/** TLS did not come up verified, for `fault`, and nothing was sent in plaintext. */
export class TlsRefused extends Schema.TaggedError<TlsRefused, { readonly brand: unique symbol }>()(
	"TlsRefused",
	{
		fault: TlsFaultSchema
	}
) {
	override get message(): string {
		return tlsFaultText(this.fault)
	}
}

/** The server closed the connection before it was ready, without an ErrorResponse. */
export class ConnectionClosed extends Schema.TaggedError<
	ConnectionClosed,
	{ readonly brand: unique symbol }
>()("ConnectionClosed", {}) {
	override get message(): string {
		return "the server closed the connection before it was ready"
	}
}

/**
 * pg ended the startup itself, with neither a code nor a SQLSTATE: a SCRAM exchange whose server proof does not
 * verify, a mechanism it does not support, or a server that asks a password of a role configured without one. `said`
 * is pg's own words, which name no password.
 */
export class DriverRefused extends Schema.TaggedError<
	DriverRefused,
	{ readonly brand: unique symbol }
>()("DriverRefused", { said: Schema.String }) {
	override get message(): string {
		return `the driver ended the startup: ${this.said}`
	}
}

/** The server reached ReadyForQuery without the BackendKeyData every session cancels with, so grizzle refused it. */
export class NoCancelKey extends Schema.TaggedError<
	NoCancelKey,
	{ readonly brand: unique symbol }
>()("NoCancelKey", {}) {
	override get message(): string {
		return "the server sent no cancellation key"
	}
}

/**
 * How a connection attempt failed, classified once, where pg reports it (adapter/wire/session.ts): the password Effect
 * failed; no answer within the connect budget; a socket error code; the server refused the startup; TLS; a connection
 * closed before it was ready; pg's own refusal; or no cancellation key. None carries a password.
 */
export const ConnectRefusalSchema = Schema.Union([
	CredentialError,
	ConnectTimedOut,
	SocketFailed,
	StartupRefused,
	TlsRefused,
	ConnectionClosed,
	DriverRefused,
	NoCancelKey
])
export type ConnectRefusal = typeof ConnectRefusalSchema.Type

/**
 * The acquisition wait budget of `millis` ran out before a session was handed over. `sessions` counts the open
 * sessions (leased, idle, retiring or still being established, never a failed connection attempt), `leased` the ones
 * handed to a lease and not yet released, when the budget ran out, and `max` is the pool's maximum: every session up to
 * the maximum leased is a saturated pool; otherwise a session was still being established.
 */
export class AcquisitionBudgetExceeded extends Schema.TaggedError<
	AcquisitionBudgetExceeded,
	{ readonly brand: unique symbol }
>()("AcquisitionBudgetExceeded", {
	millis: Schema.Finite,
	sessions: Schema.Int,
	leased: Schema.Int,
	max: Schema.Int
}) {
	/** Whether every session up to the pool's maximum was leased. */
	get saturated(): boolean {
		return this.leased >= this.max
	}

	override get message(): string {
		const pool = `${this.leased} of at most ${this.max} sessions leased, ${this.sessions} open`
		return `no session within the acquisition wait budget of ${this.millis} ms: ${pool}`
	}
}

/**
 * The DbLayer the Db was opened under has been released: its scope closed, which ended its session pools, so the Db
 * was used past its layer's lifetime. No connection was attempted.
 */
export class LayerReleased extends Schema.TaggedError<
	LayerReleased,
	{ readonly brand: unique symbol }
>()("LayerReleased", {}) {
	override get message(): string {
		return "the DbLayer the Db was opened under has been released"
	}
}

/**
 * The db.compile handle was used after the Scope that compiled it ended, which released its server statements. No
 * connection was attempted.
 */
export class HandleReleased extends Schema.TaggedError<
	HandleReleased,
	{ readonly brand: unique symbol }
>()("HandleReleased", {}) {
	override get message(): string {
		return "the db.compile handle was used after the Scope that compiled it ended"
	}
}

/** Why no session was acquired: a connection attempt's refusal, the acquisition wait budget, or a released layer. */
export const AcquireRefusalSchema = Schema.Union([
	ConnectRefusalSchema,
	AcquisitionBudgetExceeded,
	LayerReleased
])
export type AcquireRefusal = typeof AcquireRefusalSchema.Type

/** A DbConfig no connection can use: `detail` names the setting it refuses, and never quotes a password. */
export class DbConfigRefused extends Schema.TaggedError<
	DbConfigRefused,
	{ readonly brand: unique symbol }
>()("DbConfigRefused", { detail: Schema.String }) {
	override get message(): string {
		return this.detail
	}
}

/**
 * No provided DbLayer serves the role: the context holds no layer built for the login that holds it (`login`), or the
 * role is in no login at all (undefined).
 */
export class RoleOutsideLayers extends Schema.TaggedError<
	RoleOutsideLayers,
	{ readonly brand: unique symbol }
>()("RoleOutsideLayers", { role: Schema.String, login: Schema.String }) {
	override get message(): string {
		return `no provided DbLayer is built for login ${this.login}, which holds role ${this.role}`
	}
}

/**
 * The layer's login has no PostgreSQL role name under the schema its base is installed under: `login` is its declared
 * name, which its ownership admitted, `role` its PostgreSQL role `<schema>__<login>`, and `limit` the bytes that role
 * passes, PostgreSQL's 63 (physical/ddl/names.ts fittedLogin). A name the declared-name rule refuses is the login's
 * CompileError.
 */
export class LoginNameRefused extends Schema.TaggedError<
	LoginNameRefused,
	{ readonly brand: unique symbol }
>()("LoginNameRefused", { login: Schema.String, role: Schema.String, limit: Schema.Int }) {
	override get message(): string {
		return `login ${this.login} has no PostgreSQL role name: ${this.role} is longer than ${this.limit} bytes`
	}
}

/**
 * A token was refused: the layer's verify failed with it, its `cause` the verifier's own, or verify threw, its `cause`
 * what it threw. The application's verify fails with it; grizzle builds one only for a verify that throws. It is the
 * reason of an OpenError at stage `token`. CredentialError stays the database password failing.
 */
export class TokenError extends Schema.TaggedError<TokenError, { readonly brand: unique symbol }>()(
	"TokenError",
	{
		cause: Schema.Unknown
	}
) {
	override get message(): string {
		return "the layer's verify refused the token"
	}
}

/**
 * Why a claim object does not decode through its context's fields: it is present but no object (the payload itself,
 * for a context read from its top level), a field's claim is missing from it, or a claim's value is refused, by its
 * field's encoder or, for a refined field, by PostgreSQL. An absent claim object is no fact, never a refusal. No claim
 * value is quoted.
 */
const ClaimFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notAnObject") }),
	Schema.Struct({ kind: Schema.Literal("missing"), field: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("refused"), field: Schema.String })
])
export type ClaimFault = typeof ClaimFaultSchema.Type

/**
 * The verified payload does not decode through `context`'s fields, for `fault`: the reason of an OpenError at stage
 * `token`.
 */
export class ClaimRefused extends Schema.TaggedError<
	ClaimRefused,
	{ readonly brand: unique symbol }
>()("ClaimRefused", { context: Schema.String, fault: ClaimFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "notAnObject":
				return `the claim object of context ${this.context} is no object`
			case "missing":
				return `the claim object of context ${this.context} has no ${fault.field}`
			case "refused":
				return `the claim ${fault.field} of context ${this.context} is no value of its field`
		}
	}
}

/**
 * The stages admission reports, in the order it reports them (adapter/admission/admit.ts): the server, its database
 * and the extensions the schema needs; whether the database holds the snapshot; and the database's and the login's
 * settings and the login's and the role's privileges against it.
 */
const admissionStages = [
	"version",
	"locale",
	"capability",
	"ledger",
	"settings",
	"privileges"
] as const
const AdmissionStageSchema = Schema.Literals(admissionStages)
export type AdmissionStage = typeof AdmissionStageSchema.Type

/** One check admission found unmet: what was checked (a setting, a catalog property or an extension), at its stage. */
const AdmissionMismatchSchema = Schema.Struct({
	stage: AdmissionStageSchema,
	check: Schema.String,
	expected: Schema.String,
	observed: Schema.String
})
export type AdmissionMismatch = typeof AdmissionMismatchSchema.Type

/**
 * A refused admission: every mismatch found, each naming the check, the value required and the value observed. Its
 * stage is the first, in admission's order, with a mismatch. Settings and catalog properties are not secrets, and
 * nothing else is reported.
 */
export class AdmissionRefused extends Schema.TaggedError<
	AdmissionRefused,
	{ readonly brand: unique symbol }
>()("AdmissionRefused", { mismatches: Schema.NonEmptyArray(AdmissionMismatchSchema) }) {
	/** The first stage, in admission's order, a mismatch is at. */
	get stage(): AdmissionStage {
		let least = this.mismatches[0].stage
		for (const mismatch of this.mismatches) {
			if (admissionStages.indexOf(mismatch.stage) < admissionStages.indexOf(least)) {
				least = mismatch.stage
			}
		}
		return least
	}

	override get message(): string {
		const [first, ...rest] = this.mismatches
		const more = rest.length === 0 ? "" : ` (and ${rest.length} more)`
		return `${first.check}: expected ${first.expected}, observed ${first.observed}${more}`
	}
}

/** The catalog answered what its statement cannot: `what` is what the statement answers. */
export class CatalogRowRefused extends Schema.TaggedError<
	CatalogRowRefused,
	{ readonly brand: unique symbol }
>()("CatalogRowRefused", { what: Schema.String }) {
	override get message(): string {
		return `the catalog's answer is not ${this.what}`
	}
}

const operationText = { query: "a query", begin: "BEGIN", commit: "COMMIT" } as const

/**
 * The transport failed (socket error or close, a cancellation that never drained), or the server ended the session
 * with a FATAL or PANIC ErrorResponse (pg_terminate_backend's 57P01, a shutdown), after which it closes the connection.
 * The session is unusable and is retired; whether a statement in flight ran is unknown.
 *
 * `operation` is what the session was doing: a query, a BEGIN the server refused, after which no transaction is open,
 * or a COMMIT whose answer never came. `ended` is how it ended: by the server, with its FATAL or PANIC report or its
 * refusal of BEGIN, or by the transport, with no report.
 */
export class ConnectionLost extends Schema.TaggedError<
	ConnectionLost,
	{ readonly brand: unique symbol }
>()("ConnectionLost", {
	operation: Schema.Literals(["query", "begin", "commit"]),
	ended: Schema.Union([
		Schema.Struct({ by: Schema.Literal("server"), error: ServerError }),
		Schema.Struct({ by: Schema.Literal("transport") })
	])
}) {
	override get message(): string {
		const during = `the connection was lost during ${operationText[this.operation]}`
		return this.ended.by === "server"
			? `${during}: the server ended the session with ${reportText(this.ended.error)}`
			: during
	}
}

/**
 * The connection failed after COMMIT was sent and before it answered, no statement having been refused before it:
 * the transaction may have committed.
 */
export class CommitLost extends Schema.TaggedError<CommitLost, { readonly brand: unique symbol }>()(
	"CommitLost",
	{}
) {
	override get message(): string {
		return "the connection was lost after COMMIT was sent: the transaction may have committed"
	}
}

/**
 * pg would not send a query, or answered what the pipeline cannot account for. The session is retired. `operation` is
 * what the session was doing: a query, or a ROLLBACK the server refused, after which the transaction's end is unknown.
 */
export class DriverFailure extends Schema.TaggedError<
	DriverFailure,
	{ readonly brand: unique symbol }
>()("DriverFailure", { operation: Schema.Literals(["query", "rollback"]) }) {
	override get message(): string {
		return this.operation === "query"
			? "the driver would not send a query, or answered what the pipeline cannot account for"
			: "the server refused ROLLBACK, so the transaction's end is unknown"
	}
}

/**
 * What a transaction's flight did, from every answer it got: BEGIN was refused, so no transaction ran
 * ("noTransaction"); a statement was refused, so it aborted ("aborted"); every statement ran and its end answered
 * ("committed" for COMMIT's COMMIT, "rolledBack" for ROLLBACK or a refused COMMIT); or an answer that would decide never
 * came ("unknown").
 */
const TransactionFateSchema = Schema.Literals([
	"noTransaction",
	"aborted",
	"committed",
	"rolledBack",
	"unknown"
])
export type TransactionFate = typeof TransactionFateSchema.Type

const fateText: Readonly<Record<TransactionFate, string>> = {
	noTransaction: "no transaction ran",
	aborted: "the transaction aborted",
	committed: "the transaction committed",
	rolledBack: "the transaction rolled back",
	unknown: "whether the transaction committed is unknown"
}

/**
 * Statement `index` answered rows grizzle cannot read: a NULL cell, or a cell that is no text (only a catalog change
 * since admission makes one, such as a dropped NOT NULL), a plan that is no plan, or rows its compiled proof says it
 * cannot deliver (a second row of a query proved at most one row, more rows than its LIMIT binds, a probe that is not
 * one row of one Boolean). The server ran it, so it decided nothing; `fate` is what the flight's transaction then did,
 * "committed" for a statement alone, which commits at its own Sync.
 */
export class UnreadableAnswer extends Schema.TaggedError<
	UnreadableAnswer,
	{ readonly brand: unique symbol }
>()("UnreadableAnswer", { index: Schema.Int, fate: TransactionFateSchema }) {
	override get message(): string {
		return `statement ${this.index} answered rows grizzle cannot read, and ${fateText[this.fate]}`
	}
}

/**
 * Admission could not run to a verdict, for `failure`: a statement of its flight was refused (the server's report),
 * the session failed, the catalog answered rows its statements cannot give, or what it read does not compile (the
 * ledger's or the snapshot's statements).
 */
export class AdmissionFailed extends Schema.TaggedError<
	AdmissionFailed,
	{ readonly brand: unique symbol }
>()("AdmissionFailed", {
	failure: Schema.Union([
		ServerError,
		ConnectionLost,
		CommitLost,
		DriverFailure,
		UnreadableAnswer,
		CatalogRowRefused,
		CompileErrorSchema
	])
}) {
	override get message(): string {
		return `admission reached no verdict: ${this.failure.message}`
	}
}

/**
 * The capability a program needs and the admitted database lacks, such as an extension (`capability`), found before
 * any SQL.
 */
export class MissingCapability extends Schema.TaggedError<
	MissingCapability,
	{ readonly brand: unique symbol }
>()("MissingCapability", { capability: Schema.String }) {
	override get message(): string {
		return `the database lacks ${this.capability}`
	}
}

/**
 * A layer whose snapshot does not record what its login runs, found when DbLayer.make builds it: its base is another
 * schema than the snapshot's (`schema`), or a program of the login's workloads is one the snapshot does not record, one
 * it records that no workload holds, or one whose access paths or statistics moved (`program`, naming it). Running
 * `grizzle generate` records them.
 */
const UngeneratedFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("schema"), schema: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("program"), sentence: Schema.String })
])

export class WorkloadUngenerated extends Schema.TaggedError<
	WorkloadUngenerated,
	{ readonly brand: unique symbol }
>()("WorkloadUngenerated", { login: Schema.String, fault: UngeneratedFaultSchema }) {
	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "schema":
				return `login ${this.login}: schema ${fault.schema} is not the one snapshot.json records; run grizzle generate`
			case "program":
				return `${fault.sentence}; run grizzle generate`
		}
	}
}

/**
 * db.explain of a ChangeSet whose input `law` rejects before any SQL: two facts of one relation input share a key and
 * differ in payload.
 */
export class LawRejected extends Schema.TaggedError<
	LawRejected,
	{ readonly brand: unique symbol }
>()("LawRejected", {
	law: LawSchema
}) {
	override get message(): string {
		return `the ChangeSet's input breaks a ${this.law.kind} law before any SQL`
	}
}

/** A relation input, a relation parameter or a Stream member, is past the size limit, before any SQL. */
export class InputTooLarge extends Schema.TaggedError<
	InputTooLarge,
	{ readonly brand: unique symbol }
>()("InputTooLarge", {}) {
	override get message(): string {
		return "a relation input is past the size limit"
	}
}

/**
 * Why a page request is refused: its shape (no record, one whose reading throws, a property that is no control
 * property of one direction, no size or both sizes, the other direction's anchor), or its size (no safe integer from 1
 * to the page limit).
 */
const RequestFaultSchema = Schema.Literals(["requestShape", "requestSize"])
export type RequestFault = typeof RequestFaultSchema.Type

/** A page request refused for `fault`, before any SQL. */
export class PageRequestRefused extends Schema.TaggedError<
	PageRequestRefused,
	{ readonly brand: unique symbol }
>()("PageRequestRefused", { fault: RequestFaultSchema }) {
	override get message(): string {
		return this.fault === "requestShape"
			? "the page request is no record of one direction's size and anchor"
			: "the page size is no safe integer from 1 to the page limit"
	}
}

/**
 * SQLSTATE 40001, at a statement or raised by COMMIT: PostgreSQL found no serial order of this transaction and a
 * concurrent one.
 */
export class SerializationFailure extends Schema.TaggedError<
	SerializationFailure,
	{ readonly brand: unique symbol }
>()("SerializationFailure", {}) {
	override get message(): string {
		return "PostgreSQL found no serial order of this transaction and a concurrent one"
	}
}

/** SQLSTATE 40P01: this transaction and a concurrent one each waited for a lock the other held. */
export class Deadlock extends Schema.TaggedError<Deadlock, { readonly brand: unique symbol }>()(
	"Deadlock",
	{}
) {
	override get message(): string {
		return "this transaction and a concurrent one each waited for a lock the other held"
	}
}

/**
 * A put into `relation` deleted the fact at its key, and a concurrent transaction then committed a fact at that key: met
 * as a conflict on the put's insert, or as the unique violation a MERGE raised there.
 */
export class PutTargetConflict extends Schema.TaggedError<
	PutTargetConflict,
	{ readonly brand: unique symbol }
>()("PutTargetConflict", { relation: Schema.String }) {
	override get message(): string {
		return `a concurrent transaction committed a fact of ${this.relation} at a key this put replaced`
	}
}

/**
 * A generated addition's own insert into `relation` raised a unique violation on `constraint`, a key holding the serial
 * field it generates: a concurrent writer stored a value the sequence had not yet passed.
 */
export class GeneratedSerialUnique extends Schema.TaggedError<
	GeneratedSerialUnique,
	{ readonly brand: unique symbol }
>()("GeneratedSerialUnique", { relation: Schema.String, constraint: nameSchemas.constraint }) {
	override get message(): string {
		const stored = "one a concurrent writer stored"
		return `a serial value generated for ${this.relation} met ${stored}, on ${this.constraint}`
	}
}

/**
 * An insert into a span primary key of `relation` met an occupant at the key that a concurrent transaction changed: it
 * has since gone, or on a put's insert it was committed after the put deleted the fact at the key.
 */
export class SpanKeyChange extends Schema.TaggedError<
	SpanKeyChange,
	{ readonly brand: unique symbol }
>()("SpanKeyChange", { relation: Schema.String }) {
	override get message(): string {
		return `an insert into ${this.relation}'s span key met an occupant a concurrent transaction changed`
	}
}

/**
 * An insert into `relation` raised a unique violation on `constraint`, a unique object besides its primary key, from an
 * occupant this transaction's snapshot did not see: a concurrent transaction's, committed or in flight.
 */
export class UnseenOccupant extends Schema.TaggedError<
	UnseenOccupant,
	{ readonly brand: unique symbol }
>()("UnseenOccupant", { relation: Schema.String, constraint: nameSchemas.constraint }) {
	override get message(): string {
		const occupant = "an occupant this transaction's snapshot did not see"
		return `an insert into ${this.relation} met ${occupant}, on ${this.constraint}`
	}
}

/** A refresh of the derived relation `relation`: another refresh of it committed after this transaction's snapshot. */
export class ConcurrentRefresh extends Schema.TaggedError<
	ConcurrentRefresh,
	{ readonly brand: unique symbol }
>()("ConcurrentRefresh", { relation: Schema.String }) {
	override get message(): string {
		return `another refresh of ${this.relation} committed after this transaction's snapshot`
	}
}

/**
 * A server statement the session had named no longer held on its backend (26000, or 0A000 when the cached plan
 * changed its result type after a migration). The session has forgotten the name, so the next attempt parses the
 * statement afresh.
 */
export class StaleStatement extends Schema.TaggedError<
	StaleStatement,
	{ readonly brand: unique symbol }
>()("StaleStatement", {}) {
	override get message(): string {
		return "a server statement the session had named went stale"
	}
}

/**
 * Admission's transaction was refused for a reason outside Db.open's inputs, and it changed nothing: SERIALIZABLE found
 * no serial order of it and a concurrent transaction (40001), as it may for any transaction once it summarizes old
 * committed ones under load, or a deadlock (40P01). Retryable, as a call's TransientFailure is: the same Db.open may
 * succeed if it runs again, and grizzle never retries. `reason` says which, and `error` is the server's report.
 */
export class AdmissionTransient extends Schema.TaggedError<
	AdmissionTransient,
	{ readonly brand: unique symbol }
>()("AdmissionTransient", {
	reason: Schema.Union([SerializationFailure, Deadlock]),
	error: ServerError
}) {
	override get message(): string {
		return `the database refused admission's transaction, which changed nothing: ${this.reason.message}`
	}
}

/**
 * Why a TransientFailure's attempt was refused: a concurrent transaction's work met it, or a server statement the session
 * had named went stale. Each reason carries the facts every occurrence of it has: the relation and the constraint
 * involved.
 */
export const TransientReasonSchema = Schema.Union([
	SerializationFailure,
	Deadlock,
	PutTargetConflict,
	GeneratedSerialUnique,
	SpanKeyChange,
	UnseenOccupant,
	ConcurrentRefresh,
	StaleStatement
])
export type TransientReason = typeof TransientReasonSchema.Type

/**
 * A migration holds the ledger's lock or waits for it (the lock's 55P03), or the ledger holds a folder unfinished, a run
 * stopped part-way included (the guard's 55Z02).
 */
export class Migrating extends Schema.TaggedError<Migrating, { readonly brand: unique symbol }>()(
	"Migrating",
	{}
) {
	override get message(): string {
		return "a migration is running or stopped part-way"
	}
}

/** No folder is unfinished, and the latest complete one's target is another snapshot (the guard's 55Z01). */
export class Migrated extends Schema.TaggedError<Migrated, { readonly brand: unique symbol }>()(
	"Migrated",
	{}
) {
	override get message(): string {
		return "a migration to another snapshot completed"
	}
}

/** Why the fence refused a Db's transaction (physical/ddl/ledger.ts snapshotGuardDdl). */
export const StaleReasonSchema = Schema.Union([Migrating, Migrated])
export type StaleReason = typeof StaleReasonSchema.Type

/** Statement `index` was refused, and nothing committed: the server rejected it and skipped the statements after it. */
export class BatchRefused extends Schema.TaggedError<
	BatchRefused,
	{ readonly brand: unique symbol }
>()("BatchRefused", { index: Schema.Int, failure: ServerError }) {
	override get message(): string {
		return `statement ${this.index} was refused with ${reportText(this.failure)}`
	}
}

/**
 * Statement `index` ran under a name its session had parsed and the server no longer honors (26000: the backend lost
 * it; 0A000: its cached plan no longer has the statement's result type), and nothing committed. The session has
 * forgotten the name, so running the statement again parses it afresh.
 */
export class StaleName extends Schema.TaggedError<StaleName, { readonly brand: unique symbol }>()(
	"StaleName",
	{
		index: Schema.Int,
		failure: ServerError
	}
) {
	override get message(): string {
		return `statement ${this.index} ran under a name the server no longer honors: ${reportText(this.failure)}`
	}
}

/** COMMIT was refused after every statement ran, and nothing committed. */
export class CommitRefused extends Schema.TaggedError<
	CommitRefused,
	{ readonly brand: unique symbol }
>()("CommitRefused", { failure: ServerError }) {
	override get message(): string {
		return `COMMIT was refused with ${reportText(this.failure)}`
	}
}

/** How a statement alone fails: it meets no COMMIT. */
export type AloneFailure =
	| BatchRefused
	| StaleName
	| ConnectionLost
	| DriverFailure
	| UnreadableAnswer

/** How a flight fails. */
export type BatchFailure = AloneFailure | CommitRefused | CommitLost
