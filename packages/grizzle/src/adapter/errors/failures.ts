import { Data } from "effect"
import type { StartupVariable } from "#adapter/connection/environment.ts"
import type { Family, Law, Unsendable } from "#compiler/plan/change.ts"
import {
	admittedIdentifier,
	type ColumnIdent,
	type ConstraintName,
	type DomainName,
	type Identifier,
	type IdentityKind,
	type LiteralBound,
	type MessageBound,
	type RelationIdent,
	type Sqlstate
} from "#compiler/plan/common.ts"

/**
 * The reasons of grizzle's errors, and the wire's own classification of a flight's failure.
 *
 * Every error the public API's channels name (execution.ts) carries what happened as its `reason`: one of the classes
 * here, each a Data.TaggedError, so Effect.catchReason, catchReasons and unwrapReason reach it, and each rendering
 * its own `message`. A reason states only what happened, as data: whatever follows from it (an error's stage) is a
 * getter, never a stored field. `cause` is only a foreign value wrapped: what the password Effect
 * (CredentialError) or the layer's verify (TokenError) failed with or threw. The adapter classifies each failure once,
 * where it happens: a connection attempt where pg reports it (wire/session.ts), a statement's answer where its flight
 * drains (wire/batch.ts), a catalog read where its rows are parsed (wire/statement.ts).
 *
 * Each class is its value's one constructor, the adapter's and the public barrel's alike, so an application's test
 * builds the exact value grizzle fails with. A constructor that reads a name the server or the installation gave (a
 * ServerError's report, a reason's constraint, a StaleSnapshot's fingerprint) admits it as the installed name it is,
 * so no caller holds a brand to build one.
 */

/**
 * An ErrorResponse as the server wrote it: its SQLSTATE (Sqlstate.parse), its message, and each field it named or
 * gave, the constraint, the schema, the table, the column, the data type, DETAIL and HINT, undefined where it gave none.
 * Every field is stated.
 */
export interface ErrorResponse {
	readonly sqlstate: Sqlstate
	readonly message: string
	readonly constraint: string | undefined
	readonly schema: string | undefined
	readonly table: string | undefined
	readonly column: string | undefined
	readonly dataType: string | undefined
	readonly detail: string | undefined
	readonly hint: string | undefined
}

/** A field as the server gave it: an empty one says nothing, as an absent one does. */
const said = (text: string | undefined): string | undefined => (text === "" ? undefined : text)

/** A name the server gave, as the installed name it is, or undefined where it named none. */
const named = <K extends IdentityKind>(text: string | undefined): Identifier<K> | undefined => {
	const name = said(text)
	return name === undefined ? undefined : admittedIdentifier(name)
}

/**
 * An ErrorResponse: PostgreSQL refused a statement with one. It keeps the SQLSTATE, the message (its `message`), DETAIL
 * and HINT as the server gave them, and the identity fields, each the installed name it is, admitted here: the
 * constraint, the schema, the table, the column, and the data type, which a domain constraint's violation reports as its
 * domain; each undefined when the server did not report it or reported it empty. Its constructor reads the
 * ErrorResponse, the wire's of pg's DatabaseError (adapter/wire/failure.ts serverFailure) as an application's test's,
 * and every failure the server raised carries it as it is, so no layer re-states, re-admits or drops what the server
 * said; the application decides what to log.
 */
export class ServerError extends Data.TaggedError("ServerError")<{
	readonly sqlstate: Sqlstate
	readonly message: string
	readonly constraint: ConstraintName | undefined
	readonly schema: Identifier<"schema" | "roleSchema"> | undefined
	readonly table: RelationIdent | undefined
	readonly column: ColumnIdent | undefined
	readonly dataType: DomainName | undefined
	readonly detail: string | undefined
	readonly hint: string | undefined
}> {
	constructor(report: ErrorResponse) {
		super({
			sqlstate: report.sqlstate,
			message: report.message,
			constraint: named(report.constraint),
			schema: named(report.schema),
			table: named(report.table),
			column: named(report.column),
			dataType: named(report.dataType),
			detail: said(report.detail),
			hint: said(report.hint)
		})
	}
}

/** The server's report, as a sentence names it: its SQLSTATE and its message. */
const reportText = (error: ServerError): string => `SQLSTATE ${error.sqlstate}: ${error.message}`

/**
 * A password Effect failed, for example an AWS provider that could not resolve credentials: the application fails its
 * password Effect with it, the provider's failure as its `cause`. grizzle never fails with it on its own: it is the
 * reason of an OpenError, a ReadFailure or a TransportFailure, at stage `credential`.
 */
export class CredentialError extends Data.TaggedError("CredentialError")<{
	readonly cause: unknown
}> {
	override get message(): string {
		return "the password Effect failed"
	}
}

/**
 * No answer came within the connection's connect timeout of `millis` (DbConnection.connectTimeoutMs): the server or a
 * waking provider took longer to reach ReadyForQuery, or nothing answered at all.
 */
export class ConnectTimedOut extends Data.TaggedError("ConnectTimedOut")<{
	readonly millis: number
}> {
	override get message(): string {
		return `no answer within the connect timeout of ${this.millis} ms`
	}
}

/**
 * The transport failed with a socket error code, such as ECONNREFUSED (nothing listens), ENOTFOUND (the host does not
 * resolve) or ECONNRESET.
 */
export class SocketFailed extends Data.TaggedError("SocketFailed")<{ readonly code: string }> {
	override get message(): string {
		return `the socket failed (${this.code})`
	}
}

/**
 * The server refused the startup with an ErrorResponse, such as 28P01 for a wrong password, 53300 for too many
 * connections or 3D000 for no such database: `error` is its report. Its stage is `authentication` for SQLSTATE class 28
 * (invalid authorization) and `connect` for any other.
 */
export class StartupRefused extends Data.TaggedError("StartupRefused")<{
	readonly error: ServerError
}> {
	override get message(): string {
		return `the server refused the login with ${reportText(this.error)}`
	}
}

/**
 * Why TLS failed: the handshake failed with Node's code (a certificate that does not verify, such as CERT_HAS_EXPIRED or
 * ERR_TLS_CERT_ALTNAME_INVALID, or a failed negotiation, ERR_SSL_*); the server answered the SSLRequest with N, so it
 * offers no TLS; or it answered with neither S nor N. A CA bundle is never empty: the parse of the connection refuses
 * one (connection/config.ts ParsedTransport).
 */
export type TlsFault =
	| { readonly kind: "handshake"; readonly code: string }
	| { readonly kind: "notOffered" }
	| { readonly kind: "unanswered" }

const tlsFaultText = (fault: TlsFault): string => {
	switch (fault.kind) {
		case "handshake":
			return `TLS did not verify (${fault.code})`
		case "notOffered":
			return "the server offers no TLS"
		case "unanswered":
			return "the server answered the TLS request with neither yes nor no"
	}
}

/** TLS did not come up verified, for `fault`, and nothing was sent in plaintext. */
export class TlsRefused extends Data.TaggedError("TlsRefused")<{ readonly fault: TlsFault }> {
	override get message(): string {
		return tlsFaultText(this.fault)
	}
}

/** The server closed the connection before it was ready, without an ErrorResponse. */
export class ConnectionClosed extends Data.TaggedError("ConnectionClosed") {
	override get message(): string {
		return "the server closed the connection before it was ready"
	}
}

/**
 * pg ended the startup itself, with neither a code nor a SQLSTATE: a SCRAM exchange whose server proof does not
 * verify, a mechanism it does not support, or a server that asks a password of a role configured without one. `said`
 * is pg's own words, which name no password.
 */
export class DriverRefused extends Data.TaggedError("DriverRefused")<{ readonly said: string }> {
	override get message(): string {
		return `the driver ended the startup: ${this.said}`
	}
}

/** The server reached ReadyForQuery without the BackendKeyData every session cancels with, so grizzle refused it. */
export class NoCancelKey extends Data.TaggedError("NoCancelKey") {
	override get message(): string {
		return "the server sent no cancellation key"
	}
}

/**
 * How a connection attempt failed, classified once, where pg reports it (adapter/wire/session.ts): the password Effect
 * failed; no answer within the connect timeout; a socket error code; the server refused the startup; TLS; a connection
 * closed before it was ready; pg's own refusal; or no cancellation key. None carries a password.
 */
export type ConnectRefusal =
	| CredentialError
	| ConnectTimedOut
	| SocketFailed
	| StartupRefused
	| TlsRefused
	| ConnectionClosed
	| DriverRefused
	| NoCancelKey

/**
 * The DbLayer the Db was opened under has been released: its scope closed, which ended its session pools, so the Db
 * was used past its layer's lifetime. No connection was attempted.
 */
export class LayerReleased extends Data.TaggedError("LayerReleased") {
	override get message(): string {
		return "the DbLayer the Db was opened under has been released"
	}
}

/**
 * The db.compile handle was used after the Scope that compiled it ended, which dropped its compiled form. No connection
 * was attempted.
 */
export class HandleReleased extends Data.TaggedError("HandleReleased") {
	override get message(): string {
		return "the db.compile handle was used after the Scope that compiled it ended"
	}
}

/**
 * Why no session was acquired: a connection attempt's refusal, or a released layer. The wait for a session has no
 * deadline of grizzle's: an interruption, the caller's own timeout among them, ends it.
 */
export type AcquireRefusal = ConnectRefusal | LayerReleased

/** A DbConfig no connection can use: `detail` names the setting it refuses, and never quotes a password. */
export class DbConfigRefused extends Data.TaggedError("DbConfigRefused")<{
	readonly detail: string
}> {
	override get message(): string {
		return this.detail
	}
}

/** What a startup variable would do to every session pg starts with it. */
const variableEffect: { readonly [V in StartupVariable]: string } = {
	PGOPTIONS: "its settings outrank every default a session starts under",
	PGREPLICATION: "it makes each session a replication connection"
}

/**
 * A variable of the process environment that node-postgres would send at the startup of every session of a kind
 * grizzle opens, and that no value grizzle configures turns off (connection/environment.ts): DbLayer.make's refusal
 * for a login's sessions, the command line's for an owner's. Its value is never quoted.
 */
export class ConnectionEnvironmentRefused extends Data.TaggedError("ConnectionEnvironmentRefused")<{
	readonly variable: StartupVariable
}> {
	override get message(): string {
		return `the environment sets ${this.variable}, which node-postgres would send at the startup of every session it opens, where ${variableEffect[this.variable]}: unset it`
	}
}

/**
 * No provided DbLayer serves the role: the context holds no layer built for the login that holds it (`login`), or the
 * role is in no login at all (undefined).
 */
export class RoleOutsideLayers extends Data.TaggedError("RoleOutsideLayers")<{
	readonly role: string
	readonly login: string
}> {
	override get message(): string {
		return `no provided DbLayer is built for login ${this.login}, which holds role ${this.role}`
	}
}

/**
 * A token was refused: the layer's verify failed with it, its `cause` the verifier's own, or verify threw, its `cause`
 * what it threw. The application's verify fails with it; grizzle builds one only for a verify that throws. It is the
 * reason of an OpenError at stage `token`. CredentialError stays the database password failing.
 */
export class TokenError extends Data.TaggedError("TokenError")<{ readonly cause: unknown }> {
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
export type ClaimFault =
	| { readonly kind: "notAnObject" }
	| { readonly kind: "missing"; readonly field: string }
	| { readonly kind: "refused"; readonly field: string }

/**
 * The verified payload does not decode through `context`'s fields, for `fault`: the reason of an OpenError at stage
 * `token`.
 */
export class ClaimRefused extends Data.TaggedError("ClaimRefused")<{
	readonly context: string
	readonly fault: ClaimFault
}> {
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

/** The catalog answered what its statement cannot: `what` is what the statement answers. */
export class CatalogRowRefused extends Data.TaggedError("CatalogRowRefused")<{
	readonly what: string
}> {
	override get message(): string {
		return `the catalog's answer is not ${this.what}`
	}
}

const operationText = { query: "a query", begin: "BEGIN", commit: "COMMIT" } as const

/**
 * The transport failed (socket error or close), or the server ended the session with a FATAL or PANIC ErrorResponse
 * (pg_terminate_backend's 57P01, a shutdown), after which it closes the connection.
 * The session is unusable and never reused: retired, or ended with its connection; whether a statement in flight ran is
 * unknown.
 *
 * `operation` is what the session was doing: a query, a BEGIN the server refused, after which no transaction is open,
 * or a COMMIT whose answer never came. `ended` is how it ended: by the server, with its FATAL or PANIC report or its
 * refusal of BEGIN, or by the transport, with no report.
 */
export class ConnectionLost extends Data.TaggedError("ConnectionLost")<{
	readonly operation: "query" | "begin" | "commit"
	readonly ended:
		| { readonly by: "server"; readonly error: ServerError }
		| { readonly by: "transport" }
}> {
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
export class CommitLost extends Data.TaggedError("CommitLost") {
	override get message(): string {
		return "the connection was lost after COMMIT was sent: the transaction may have committed"
	}
}

/**
 * pg would not send a query, or answered what the pipeline cannot account for. The session is retired, never reused.
 * `operation` is what the session was doing: a query, or a ROLLBACK the server refused, after which the transaction's
 * end is unknown.
 */
export class DriverFailure extends Data.TaggedError("DriverFailure")<{
	readonly operation: "query" | "rollback"
}> {
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
export type TransactionFate = "noTransaction" | "aborted" | "committed" | "rolledBack" | "unknown"

const fateText: Readonly<Record<TransactionFate, string>> = {
	noTransaction: "no transaction ran",
	aborted: "the transaction aborted",
	committed: "the transaction committed",
	rolledBack: "the transaction rolled back",
	unknown: "whether the transaction committed is unknown"
}

/**
 * Statement `index` answered rows grizzle cannot read: a NULL cell, or a cell that is no text (only a catalog change
 * since the migration makes one, such as a dropped NOT NULL), a plan that is no plan, or rows its compiled proof says it
 * cannot deliver (a second row of a query proved at most one row, more rows than its LIMIT binds, a probe that is not
 * one row of one Boolean). The server ran it, so it decided nothing; `fate` is what the flight's transaction then did,
 * "committed" for a statement alone, which commits at its own Sync.
 */
export class UnreadableAnswer extends Data.TaggedError("UnreadableAnswer")<{
	readonly index: number
	readonly fate: TransactionFate
}> {
	override get message(): string {
		return `statement ${this.index} answered rows grizzle cannot read, and ${fateText[this.fate]}`
	}
}

/**
 * The capability a program needs and the admitted database lacks, such as an extension (`capability`), found before
 * any SQL.
 */
export class MissingCapability extends Data.TaggedError("MissingCapability")<{
	readonly capability: string
}> {
	override get message(): string {
		return `the database lacks ${this.capability}`
	}
}

/**
 * db.explain of a ChangeSet whose input `law` rejects before any SQL: two facts of one relation input share a key and
 * differ in payload.
 */
export class LawRejected extends Data.TaggedError("LawRejected")<{ readonly law: Law }> {
	override get message(): string {
		return `the ChangeSet's input breaks a ${this.law.kind} law before any SQL`
	}
}

/**
 * Which transport bound an execution's parameters are past, found on the host before its flight is sent:
 *
 * - message: the Bind message of the flight's statement at `statement` would be `bytes` long, as its length word
 *   counts it, past the longest message PostgreSQL reads, `limit` (core/limits.ts messageMaxBytes), past which the
 *   backend ends the connection instead of answering;
 * - literal: the array of the relation input `input`'s column `column` would be longer than any placeholder carries,
 *   so none can carry it (ir/products.ts LiteralBound): a text array longer than the longest string the host builds,
 *   `limit` UTF-16 code units (core/limits.ts maxStringLength), or a bytes column's binary array longer than the longest
 *   message PostgreSQL reads, `limit` bytes (core/limits.ts messageMaxBytes);
 * - familyRow: one row a family write places, vacates or recounts, a `member` row of the family `owner.count`, is past
 *   one of those bounds alone, so no `statement` of the write's plan can carry it however its rows are cut
 *   (write/family/order.ts Unsendable);
 * - flight: the flight's messages, every byte pg writes for it in its one corked write, would be `bytes` long, past the
 *   most one write over TLS carries, `limit` (core/limits.ts flightMaxBytes), past which the write fails whole and the
 *   connection with it, its end unsent;
 * - parse: a statement's Parse message, its text with its name and the message's fields, would be `bytes` long, as its
 *   length word counts it, past the longest message PostgreSQL reads, `limit` (core/limits.ts messageMaxBytes), past
 *   which the backend ends the connection instead of answering;
 * - input: the member `input`'s arrays, or one row of it for a nested write, would make a Bind message of at least
 *   `bytes`, past the longest message PostgreSQL reads, `limit` (ir/products.ts MessageBound), found from its values'
 *   lengths before any of its bytes is read or copied.
 *
 * None bounds a count of rows: a ChangeSet input, a relation parameter or a family of any number of facts travels
 * whenever each row's texts fit and the call's flight fits one write.
 */
export type InputBound =
	| {
			readonly kind: "message"
			readonly statement: number
			readonly bytes: number
			readonly limit: number
	  }
	| {
			readonly kind: "literal"
			readonly form: "text" | "binary"
			readonly input: string
			readonly column: string
			readonly limit: number
	  }
	| {
			readonly kind: "familyRow"
			readonly owner: string
			readonly count: string
			readonly member: string
			readonly row: Unsendable
	  }
	| {
			readonly kind: "flight"
			readonly bytes: number
			readonly limit: number
	  }
	| {
			readonly kind: "parse"
			readonly bytes: number
			readonly limit: number
	  }
	| {
			readonly kind: "input"
			readonly input: string
			readonly bytes: number
			readonly limit: number
	  }

/**
 * An execution's parameters are past a bound of their transport (InputBound), before any SQL: split the input across
 * calls.
 */
export class InputTooLarge extends Data.TaggedError("InputTooLarge")<{
	readonly bound: InputBound
}> {
	override get message(): string {
		const bound = this.bound
		switch (bound.kind) {
			case "message":
				return `statement ${bound.statement} of the call would send a Bind message of ${bound.bytes} bytes, past PostgreSQL's limit of ${bound.limit}; split the input across calls`
			case "literal":
				return bound.form === "text"
					? `the array of column ${bound.column} of input ${bound.input} would be longer than ${bound.limit} UTF-16 code units, the longest string the host builds; split the input across calls`
					: `the binary array of column ${bound.column} of input ${bound.input} would be longer than ${bound.limit} bytes, the longest message PostgreSQL reads; split the input across calls`
			case "familyRow": {
				const row = bound.row
				const past =
					row.kind === "literal"
						? `its column ${row.column} would be an array longer than ${row.limit} UTF-16 code units, the longest string the host builds`
						: `its ${row.statement} statement would send a Bind message of ${row.bytes} bytes, past PostgreSQL's limit of ${row.limit}`
				return `a ${bound.member} row of the family ${bound.owner}.${bound.count} fits no ${row.statement} statement even alone: ${past}; shorten the row's values`
			}
			case "flight":
				return `the flight would write ${bound.bytes} bytes, past the ${bound.limit} one write over TLS carries; split the input across calls`
			case "parse":
				return `a statement's Parse message would be ${bound.bytes} bytes, past PostgreSQL's limit of ${bound.limit}: its text is longer than one message carries`
			case "input":
				return `the arrays of input ${bound.input} would make a Bind message of at least ${bound.bytes} bytes, past PostgreSQL's limit of ${bound.limit}; split the input across calls`
		}
	}
}

/** A family write's row no statement of its plan can carry (write/family/order.ts plan), as the family names it. */
export const familyRowBound = (family: Family, row: Unsendable): InputTooLarge =>
	new InputTooLarge({
		bound: {
			kind: "familyRow",
			owner: family.owner.name,
			count: family.count.name,
			member: family.member.name,
			row
		}
	})

/** The bound of a member no statement can carry, as the engine reports it from its values' lengths. */
export const messageBound = (bound: MessageBound): InputTooLarge =>
	new InputTooLarge({
		bound: { kind: "input", input: bound.input, bytes: bound.bytes, limit: bound.limit }
	})

/** The bound of a relation input's column whose array no string can hold, as the engine reports it. */
export const literalBound = (bound: LiteralBound): InputTooLarge =>
	new InputTooLarge({
		bound: {
			kind: "literal",
			form: bound.form,
			input: bound.input,
			column: bound.column,
			limit: bound.limit
		}
	})

/**
 * Why a page request is refused: its shape (no record, one whose reading throws, a property that is no control
 * property of one direction, no size or both sizes, the other direction's anchor), or its size (no safe integer of
 * at least 1).
 */
export type RequestFault = "requestShape" | "requestSize"

/** A page request refused for `fault`, before any SQL. */
export class PageRequestRefused extends Data.TaggedError("PageRequestRefused")<{
	readonly fault: RequestFault
}> {
	override get message(): string {
		return this.fault === "requestShape"
			? "the page request is no record of one direction's size and anchor"
			: "the page size is no safe integer of at least 1"
	}
}

/**
 * SQLSTATE 40001, at a statement or raised by COMMIT: PostgreSQL found no serial order of this transaction and a
 * concurrent one.
 */
export class SerializationFailure extends Data.TaggedError("SerializationFailure") {
	override get message(): string {
		return "PostgreSQL found no serial order of this transaction and a concurrent one"
	}
}

/** SQLSTATE 40P01: this transaction and a concurrent one each waited for a lock the other held. */
export class Deadlock extends Data.TaggedError("Deadlock") {
	override get message(): string {
		return "this transaction and a concurrent one each waited for a lock the other held"
	}
}

/**
 * A put into `relation` deleted the fact at its key, and a concurrent transaction then committed a fact at that key: met
 * as a conflict on the put's insert, or as the unique violation a MERGE raised there.
 */
export class PutTargetConflict extends Data.TaggedError("PutTargetConflict")<{
	readonly relation: string
}> {
	override get message(): string {
		return `a concurrent transaction committed a fact of ${this.relation} at a key this put replaced`
	}
}

/**
 * A generated addition's own insert into `relation` raised a unique violation on `constraint`, a key holding the serial
 * field it generates: a concurrent writer stored a value the sequence had not yet passed.
 */
export class GeneratedSerialUnique extends Data.TaggedError("GeneratedSerialUnique")<{
	readonly relation: string
	readonly constraint: ConstraintName
}> {
	constructor(met: { readonly relation: string; readonly constraint: string }) {
		super({ relation: met.relation, constraint: admittedIdentifier(met.constraint) })
	}

	override get message(): string {
		const stored = "one a concurrent writer stored"
		return `a serial value generated for ${this.relation} met ${stored}, on ${this.constraint}`
	}
}

/**
 * An insert into a span primary key of `relation` met an occupant at the key that a concurrent transaction changed: it
 * has since gone, or on a put's insert it was committed after the put deleted the fact at the key.
 */
export class SpanKeyChange extends Data.TaggedError("SpanKeyChange")<{
	readonly relation: string
}> {
	override get message(): string {
		return `an insert into ${this.relation}'s span key met an occupant a concurrent transaction changed`
	}
}

/**
 * An insert into `relation` raised a unique violation on `constraint`, a unique object besides its primary key, from an
 * occupant this transaction's snapshot did not see: a concurrent transaction's, committed or in flight.
 */
export class UnseenOccupant extends Data.TaggedError("UnseenOccupant")<{
	readonly relation: string
	readonly constraint: ConstraintName
}> {
	constructor(met: { readonly relation: string; readonly constraint: string }) {
		super({ relation: met.relation, constraint: admittedIdentifier(met.constraint) })
	}

	override get message(): string {
		const occupant = "an occupant this transaction's snapshot did not see"
		return `an insert into ${this.relation} met ${occupant}, on ${this.constraint}`
	}
}

/** A refresh of the derived relation `relation`: another refresh of it committed after this transaction's snapshot. */
export class ConcurrentRefresh extends Data.TaggedError("ConcurrentRefresh")<{
	readonly relation: string
}> {
	override get message(): string {
		return `another refresh of ${this.relation} committed after this transaction's snapshot`
	}
}

/**
 * Why a TransientFailure's attempt was refused: a concurrent transaction's work met it. Each reason carries the facts
 * every occurrence of it has: the relation and the constraint involved.
 */
export type TransientReason =
	| SerializationFailure
	| Deadlock
	| PutTargetConflict
	| GeneratedSerialUnique
	| SpanKeyChange
	| UnseenOccupant
	| ConcurrentRefresh

/**
 * A migration holds the ledger's lock or waits for it (the lock's 55P03), or the ledger holds a folder unfinished, a run
 * stopped part-way included (the guard's 55Z02).
 */
export class Migrating extends Data.TaggedError("Migrating") {
	override get message(): string {
		return "a migration is running or stopped part-way"
	}
}

/** No folder is unfinished, and the latest complete one's target is another snapshot (the guard's 55Z01). */
export class Migrated extends Data.TaggedError("Migrated") {
	override get message(): string {
		return "a migration to another snapshot completed"
	}
}

/** Why the fence refused a Db's transaction (physical/ddl/ledger.ts snapshotGuardDdl). */
export type StaleReason = Migrating | Migrated

/** Statement `index` was refused, and nothing committed: the server rejected it and skipped the statements after it. */
export class BatchRefused extends Data.TaggedError("BatchRefused")<{
	readonly index: number
	readonly failure: ServerError
}> {
	override get message(): string {
		return `statement ${this.index} was refused with ${reportText(this.failure)}`
	}
}

/** COMMIT was refused after every statement ran, and nothing committed. */
export class CommitRefused extends Data.TaggedError("CommitRefused")<{
	readonly failure: ServerError
}> {
	override get message(): string {
		return `COMMIT was refused with ${reportText(this.failure)}`
	}
}

/** How a statement alone fails: it meets no COMMIT. */
export type AloneFailure = BatchRefused | ConnectionLost | DriverFailure | UnreadableAnswer

/** How a flight fails. */
export type BatchFailure = AloneFailure | CommitRefused | CommitLost
