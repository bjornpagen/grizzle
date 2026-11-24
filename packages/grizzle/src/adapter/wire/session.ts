/**
 * Sessions over pg, a hot path: every query of every flight is written, and every cell of every row it answers is
 * checked, here, in native loops with no Option or closure per row.
 *
 * Sessions: clients of the caller's node-postgres (DbConnection.driver, types/driver.ts PgDriver) in pipeline mode,
 * pooled by its own Pool, but the live leader's replication connection, which pg's pipeline mode cannot stream
 * (wireModeOf). grizzle imports nothing of pg itself.
 *
 * This module is grizzle's only contact with pg, whose types expose `any` (rows, values, pool callbacks): every value
 * pg hands back is narrowed here, by its class (the driver's DatabaseError), by a type argument that pins rows to
 * unknown cells, or by a checked read of a field its types leave out (BackendKeyData), so batch.ts sees only
 * grizzle's types.
 *
 * - Transport. Every connection, a session's and a CancelRequest's, is a socket the transport opens (Transport.open),
 *   connected to its host and port, then an SSLRequest, then verify-full TLS over it: the certificate must chain to the
 *   CA bundle and name `servername`. The transport is the one the parse admitted (connection/config.ts ParsedTransport),
 *   so its bundle is a nonempty list of PEM texts and its host a network host, never the path of a Unix socket, which
 *   pg would connect by path alone. pg replaces the `servername` it gives TLS with the host whenever the host is a
 *   name, so the name is verified by the identity check itself, and the SNI a server sees is the host; a
 *   CancelRequest's connection is upgraded the same way (sessionTls). A server that answers the SSLRequest with N is
 *   refused: pg has no fallback to plaintext.
 * - Password. A Redacted, or an Effect evaluated once per connection attempt, under the services of the lease it is
 *   opened for: pg is given a function either way (passwordOf), which it calls when the server asks for a password,
 *   since pg reads PGPASSWORD, then a password file, for any password it is given as a falsy value. A client holds
 *   those services only until its connection is set up, so one the server never asked for a password keeps no lease's
 *   context. Its CredentialError fails the attempt at the stage credential, as the failure's reason; a defect or an
 *   interruption of the Effect is the operation's defect.
 * - Failure. A connection attempt that fails is classified once, here, from what pg reports (failures.ts
 *   ConnectRefusal): the CredentialError, a socket error code, the
 *   server's refusal of the startup with its ErrorResponse as it gave it, TLS, a connection closed before it was ready,
 *   pg's own refusal, or no cancellation key.
 * - Startup. pg sends user and database, and a login's session its pinned defaults as `options`
 *   (physical/ddl/roles.ts loginStartupOptions), the very defaults its role stores, which Db.open's admission
 *   verifies; an owner's session sends its default level and generic plans (startupOptionsOf), generic plans the one of
 *   them every session grizzle opens starts under, and otherwise starts under its role's and its database's defaults;
 *   a replication connection sends none. grizzle never issues a session-level SET and names no session: an application_name is the environment's (connection/
 *   environment.ts). pg reads every setting it is given as a falsy value from the environment instead: the client config
 *   states each it can (clientConfig), and the startup variables it cannot (connection/environment.ts) are refused
 *   before any session opens, a login's by DbLayer.make, an owner's by the command line.
 * - Values. Every type parser is the identity and results are requested as text, so every cell is the text the server
 *   sent, and parameters are bound as untyped text. Each row is read as it arrives (submit): a served statement whose
 *   intake takes its rows hands each on at once, and every other query's are kept for its answer. grizzle's own SQL never delivers NULL (absence is zero rows), so a
 *   result with a NULL cell is an unreadable answer: the statement ran, and its rows are none grizzle reads. Every row
 *   past this module is texts only.
 * - Statements. A served statement (batch.ts PreparedStatement) is sent under its name, which pg parses on the
 *   connection's first use of it and binds on every use after, by pg's own record of the names each connection parsed,
 *   which starts empty with every connection: a session holds the served statements it ran, and nothing else of a
 *   flight. Every other statement (batch.ts OneShotStatement) runs as PostgreSQL's unnamed statement, parsed, bound and
 *   executed in its own execution.
 * - Cancellation. pg's JavaScript client has no supported cancel: Client#cancel is undocumented and writes the
 *   CancelRequest on a plaintext socket. A session sends one CancelRequest over a connection of its own, which the
 *   transport opens and upgrades as a session's, with the BackendKeyData pg read at startup (Session.cancel); an
 *   interrupted flight sends one, and another each time the server answers a query of it after the one before was
 *   sent, until the server has ended it, and destroys the session only once a request could not reach the server
 *   (wire/batch.ts abandon).
 * - Waiting. No connection, CancelRequest or interrupted flight is bounded by a clock of grizzle's: each waits for its
 *   server's own answer or failure, as the operating system reports an unreachable host (a refused or timed-out TCP
 *   connect, a reset) and as PostgreSQL ends a startup it does not finish (authentication_timeout). A caller that
 *   answers by a deadline states it on its own call (`Effect.timeout`).
 * - Pool. The driver's own Pool, its most sessions the caller's (DbConfig.pool), which keeps every session it opened
 *   for its life: it is built with an idle timeout of 0, pg's "never" (types/driver.ts PgPoolConfig), so no session is
 *   closed for being idle, and a session's cold cost, its connection and its first plan of each statement, is paid once
 *   in the pool's life, never again after a pause between requests. It opens no session before a lease asks for one,
 *   and hands a lease the idle session released last (pg-pool's idle list is a stack), so one request at a time runs on
 *   one session. A session leaves the pool only once it is not open (State, below) or the pool ends (Release). The
 *   wait for a session is the lease's own: its ask takes one of the pool's `max`
 *   permits, or waits for one in order, before pg's Pool is asked for a client, and the permit is held until pg has
 *   that client back, so pg's Pool always has an idle client or room and never keeps a lease waiting for one, holding
 *   an ask only for the turn it takes to hand an idle client over. The lease waits, interruptibly and with no deadline
 *   of its own, only for its ask to settle: the caller's own timeout bounds it. A permit and a client move between the
 *   ask, pg's callback and the lease only in plain synchronous code, so no interruption at any step can drop one. A
 *   wait that is interrupted leaves nothing behind: a client that arrives for a lease abandoned while pg connected it
 *   goes back to the pool, and its permit with it. A lease of an ended pool is refused with LayerReleased, before pg is
 *   asked for a client.
 * - State. A session is open, retired or ended (SessionState), and moves only as sessionTransitions says: retired on an
 *   interruption with a statement in flight, a failure batch.ts cannot account for, or a transaction it could not end;
 *   ended once its connection ends, lost, ended by the server, or destroyed. A session that is not open is released
 *   with an error, so pg's Pool closes it instead of keeping it, and is counted out of the pool before its permit admits
 *   another lease.
 * - Release. The pool ends when the scope it was built in closes (a DbLayer's): pg's Pool ends, writing a Terminate to
 *   each idle session; the socket of every client still connecting, handed to a lease or leased is destroyed at once;
 *   every lease still waiting is refused with LayerReleased, whether queued for a permit or asking pg's Pool, which
 *   drops the asks it queued for an idle client when it ends and so would never answer them; and the release returns
 *   once the server has closed every other connection, which it does only once that session's backend has exited, its
 *   temporary relations dropped and the backend out of the database's (makePool), so the database can be dropped at
 *   once. That wait has no deadline: interrupting the release ends it, every connection still open destroyed.
 */
import { Buffer } from "node:buffer"
import { isIP } from "node:net"
import { type ConnectionOptions, checkServerIdentity, connect as tlsConnect } from "node:tls"
import * as Arr from "effect/Array"
import * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Formatter from "effect/Formatter"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import {
	defect,
	flightMaxBytes,
	messageMaxBytes,
	nominal,
	type ReplicationCommand,
	type StatementName
} from "#compiler/plan/runtime.ts"

import type { ParsedConnection, ParsedTransport } from "#adapter/connection/config.ts"
import { CredentialError } from "#adapter/errors/credential.ts"
import {
	type AcquireRefusal,
	ConnectionClosed,
	type ConnectRefusal,
	DriverFailure,
	DriverRefused,
	LayerReleased,
	ConnectionLost,
	NoCancelKey,
	ReplicationEnded,
	type ServerError,
	SocketFailed,
	StartupRefused,
	TlsRefused,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import { ownServices } from "#adapter/services.ts"
import type {
	PgClient,
	PgClientConfig,
	PgDriver,
	PgPool,
	PgPoolClient,
	PgQueryConfig,
	PgSocket,
	PgWireMode
} from "#adapter/types/driver.ts"
import type { PoolBounds } from "#adapter/types/layer.ts"
import type {
	BatchOutcome,
	OneShotStatement,
	PreparedStatement,
	Transaction
} from "#adapter/wire/batch.ts"
import { type ServerAnswer, serverFailure } from "#adapter/wire/failure.ts"
import type { EmittedText, Isolation, OutputRows } from "#compiler/plan/common.ts"
import type { ServedSession } from "#compiler/plan/serve.ts"

/**
 * What a session sends that no program states, each emitted where it was compiled (served/forms.ts ServedSession): a
 * read's BEGIN, a write's at each isolation level, and its end, COMMIT or ROLLBACK. A served
 * login's file carries them, and an owner's session takes generate's own.
 */
export interface ControlTexts {
	/** An owner's session's startup options: generic plans alone (physical/ddl/roles.ts ownerStartupOptions). */
	readonly ownerStartup: ServedSession["ownerStartup"]
	readonly begin: ServedSession["begin"]
	readonly commit: EmittedText
	readonly rollback: EmittedText
}

/**
 * Whose session it is: a login's, every session of a pool, which starts under the options pinning its role's defaults;
 * an owner's, one outside any pool, which starts under its default level and generic plans (startupOptionsOf); or a
 * replication connection's, the live leader's walsender of its database, which states none.
 */
type Startup =
	| { readonly kind: "owner" }
	| { readonly kind: "login"; readonly options: string }
	| { readonly kind: "replication" }

/**
 * An owner's sessions' startup options: SERIALIZABLE as each one's default level. grizzle sets no database default
 * (engine physical/ddl/isolation.ts), so a statement an owner's session sends outside a BEGIN, the migration identity's
 * (a survey or catalog read, a catalog's DDL, a `-- grizzle: no-transaction` file's statements), runs SERIALIZABLE by
 * this statement of grizzle's own, as every BEGIN grizzle sends names its level; a guarded table's guard refuses a
 * write below it (25000).
 */
const ownerOptions = "-c default_transaction_isolation=serializable"

/**
 * The startup packet's `options` of a session of `startup`: a login's its pinned defaults (engine physical/ddl/roles.ts
 * loginStartupOptions), generic plans among them; an owner's its default level (ownerOptions) and generic plans, as its
 * session texts carry them (ControlTexts ownerStartup, roles.ts ownerStartupOptions); a replication connection's none,
 * which runs no transaction.
 */
const startupOptionsOf = (
	startup: Startup,
	controls: ControlTexts
): { readonly options?: string } => {
	switch (startup.kind) {
		case "login":
			return { options: startup.options }
		case "owner":
			return { options: `${ownerOptions} ${controls.ownerStartup}` }
		case "replication":
			return {}
	}
}

/**
 * The wire mode of a session of `startup` (types/driver.ts PgWireMode): a login's and an owner's pipelined; a
 * replication connection's a walsender of its database, never pipelined, since pg 8.23 refuses its stream, a
 * Submittable (replicationOf), on a pipelined client before a byte of START_REPLICATION is sent: a pipelined leader
 * makes the slot and never streams it.
 */
const wireModeOf = (startup: Startup): PgWireMode =>
	startup.kind === "replication" ? { pipeline: false, replication: "database" } : { pipeline: true }

/**
 * Where one session connects and as whom: the parsed connection (connection/config.ts ParsedConnection), its driver,
 * transport, database and password, the login role, whose session it is, installed already under the
 * connection's role space, and its transactions' control texts.
 */
interface SessionSpec extends Omit<ParsedConnection, "roles"> {
	/** The login role. */
	readonly role: string
	readonly startup: Startup
	readonly controls: ControlTexts
}

/**
 * A transaction control of a pipeline: BEGIN, a read's or a write's at its level, or the
 * transaction's end, COMMIT or ROLLBACK. Whoever reads a pipeline reads which control it is from here, never from its
 * text.
 */
export type TxControl =
	| { readonly kind: "begin"; readonly access: "readOnly" }
	| { readonly kind: "begin"; readonly access: "readWrite"; readonly isolation: Isolation }
	| { readonly kind: "end"; readonly end: Transaction["end"] }

/** The text a control sends, among a session's control texts. */
export const controlText = (controls: ControlTexts, control: TxControl): EmittedText => {
	switch (control.kind) {
		case "begin":
			return control.access === "readOnly"
				? controls.begin.read
				: controls.begin.write[control.isolation]
		case "end":
			return control.end === "COMMIT" ? controls.commit : controls.rollback
	}
}

/**
 * One query of a pipeline: a statement, on the extended protocol with its own Sync, served under its name or one-shot
 * as the unnamed statement (batch.ts BatchStatement), or a transaction control, a simple Query message.
 */
export type WireQuery =
	| PreparedStatement
	| OneShotStatement
	| { readonly _tag: "control"; readonly control: TxControl }

/**
 * What the server answered one query: its result; a result whose rows grizzle's SQL cannot deliver (a NULL cell, or a
 * cell that is no text), with its command tag, since the query ran; an ErrorResponse, with the fields grizzle keeps,
 * refused, or terminated when the server ends the session after it (failure.ts ServerAnswer); or no answer pg could
 * read, because the connection failed or pg would not send the query.
 */
export type Answer =
	| { readonly _tag: "result"; readonly outcome: BatchOutcome }
	| { readonly _tag: "unreadable"; readonly command: string }
	| ServerAnswer
	| { readonly _tag: "failed" }

interface BackendKey {
	readonly processId: number
	readonly secretKey: number
}

/** pg keeps the BackendKeyData of a connected client as `processID` and `secretKey`, which its types leave out. */
const backendKeyOf = (client: PgClient): BackendKey | undefined => {
	if (!Predicate.hasProperty(client, "processID") || !Predicate.hasProperty(client, "secretKey")) {
		return undefined
	}
	const processId = client.processID
	const secretKey = client.secretKey
	return Predicate.isNumber(processId) && Predicate.isNumber(secretKey)
		? { processId, secretKey }
		: undefined
}

/** One result row whose every cell arrived as text: PostgreSQL's output texts, minted here, where they arrive. */
type OutputRow = OutputRows[number]

const outputRow = nominal<ReadonlyArray<string>, OutputRow>()

/** A result's rows whose every cell arrived as text (outputRow). */
const outputRows = nominal<ReadonlyArray<OutputRow>, OutputRows>()

/** A row every cell of which arrived as text: a native loop over its cells. */
const isTextRow = (row: ReadonlyArray<unknown>): row is ReadonlyArray<string> => {
	for (const cell of row) {
		if (typeof cell !== "string") {
			return false
		}
	}
	return true
}

/**
 * The answer of a query pg ended with `error`: its DatabaseError for an ErrorResponse, as the server's failure, and its
 * own Error for a failed connection or a query it would not send.
 */
const errorAnswer = (driver: PgDriver, error: unknown): Answer =>
	error instanceof driver.DatabaseError
		? (serverFailure(error) ?? { _tag: "failed" })
		: { _tag: "failed" }

/** The identity of every type: each cell stays the text the server sent. */
const rawText = { getTypeParser: () => (text: string) => text } as const

/**
 * verify-full against the CA bundle and `servername`. The identity check names the server explicitly, so it holds
 * whatever pg sets as the SNI; the SNI is never an IP address. The bundle is the transport's authority, parsed once
 * from its nonempty list of PEM texts (connection/config.ts ParsedTransport): a context built from a list trusts that
 * list alone, never Node's own root certificates, so no bundle ever lets a public authority's certificate verify.
 */
const verifyFull = (transport: ParsedTransport): ConnectionOptions => {
	const servername = transport.servername
	return {
		secureContext: transport.authority,
		rejectUnauthorized: true,
		...(isIP(servername) === 0 ? { servername } : {}),
		checkServerIdentity: (...[, certificate]) => checkServerIdentity(servername, certificate)
	}
}

/**
 * The TLS a connection's socket is upgraded with, as pg 8.23 upgrades a session's (lib/connection.js upgradeToSSL):
 * verify-full's options, the host, and the host as the SNI whenever it is a name. A CancelRequest's connection is
 * upgraded with exactly these, so it verifies as the session it cancels did.
 */
const sessionTls = (transport: ParsedTransport, socket: PgSocket): ConnectionOptions => ({
	socket,
	host: transport.host,
	...verifyFull(transport),
	...(isIP(transport.host) === 0 ? { servername: transport.host } : {})
})

/**
 * The failures pg reports only by their message, as the pinned pg spells them: the server's answer to the SSLRequest (N,
 * or neither S nor N), and a connection that ended before ReadyForQuery with no ErrorResponse. pg's own connect timeout
 * ("timeout expired") is never set (clientConfig), so pg never reports one.
 */
const messageRefusals: ReadonlyMap<string, (spec: SessionSpec) => ConnectRefusal> = new Map<
	string,
	(spec: SessionSpec) => ConnectRefusal
>([
	[
		"The server does not support SSL connections",
		() => new TlsRefused({ fault: { kind: "notOffered" } })
	],
	[
		"There was an error establishing an SSL connection",
		() => new TlsRefused({ fault: { kind: "unanswered" } })
	],
	["Connection terminated unexpectedly", () => new ConnectionClosed()]
])

/**
 * The password Effect of an attempt died or was interrupted: a defect of the operation that opened the session, never
 * a connection failure. The password function rejects with it, so the attempt's end can tell it from pg's failures.
 */
class PasswordDefect extends Data.TaggedError("PasswordDefect")<{ readonly defect: unknown }> {}

/** What pg said with a failure it reports by message alone: the message, or the value it failed with, rendered. */
const saidBy = (error: unknown): string =>
	Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
		? error.message
		: Formatter.format(error)

/**
 * The errors the TLS upgrade of a client's connection raised before its handshake completed, each the very error pg then
 * fails the attempt with: a TLS failure is told by when it happened, not by its code, so a certificate the CA bundle
 * does not verify, a name it does not carry and a server that refuses the handshake are TLS alike. Each pool, and each
 * owner's session, keeps its own, which its clients fill (sessionClient) and its attempts' ends read (attemptFailed).
 */
type Handshakes = WeakSet<object>

/**
 * The class of a failed connection attempt, from what pg reported (failures.ts ConnectRefusal): the CredentialError the
 * password function rejected with; a Node error the TLS handshake raised, as TLS with its code; an ErrorResponse, the
 * server's refusal of the startup as it gave it; any other Node error by its code, as the socket's; pg's own failures
 * that carry no code by their message; and anything else pg ended the startup with as its own refusal, with pg's words.
 */
const connectRefusalOf = (
	spec: SessionSpec,
	handshakes: Handshakes,
	error: unknown
): ConnectRefusal => {
	if (error instanceof CredentialError) {
		return error
	}
	if (
		Predicate.isObject(error) &&
		handshakes.has(error) &&
		Predicate.hasProperty(error, "code") &&
		Predicate.isString(error.code)
	) {
		return new TlsRefused({ fault: { kind: "handshake", code: error.code } })
	}
	if (error instanceof spec.driver.DatabaseError) {
		const answer = serverFailure(error)
		return answer === undefined
			? new DriverRefused({ said: error.message })
			: new StartupRefused({ error: answer.error })
	}
	if (Predicate.hasProperty(error, "code") && Predicate.isString(error.code)) {
		return new SocketFailed({ code: error.code })
	}
	const said = saidBy(error)
	const known = messageRefusals.get(said)
	return known === undefined ? new DriverRefused({ said }) : known(spec)
}

/** The end of a failed connection attempt: a defect of the password Effect is the operation's; any other its class. */
const attemptFailed = (
	spec: SessionSpec,
	handshakes: Handshakes,
	error: unknown
): Effect.Effect<never, ConnectRefusal> =>
	error instanceof PasswordDefect
		? Effect.die(error.defect)
		: Effect.fail(connectRefusalOf(spec, handshakes, error))

/**
 * The services a client's password Effect runs under: `current`, else its pool's or its caller's (`own`). A pool's are
 * its layer's own (services.ts ownServices), the span its layer was built in left behind; a lone session's are its
 * caller's, for whom it connects.
 *
 * A pool's: a client is constructed synchronously inside the call that needs it (pg's Pool constructs and connects one
 * inside `connect` when it has room), so the lease holds `current` around that call and gives it back to `own`. A
 * client's own: its lease's from its construction until its connection is set up, then `own`. pg keeps a password
 * function it never called (trust, peer or certificate authentication) for the client's life, and a lease's services
 * hold its Scope, which keeps its Exit, so no connected client keeps a lease's.
 */
interface AttemptServices {
	current: Context.Context<never>
	readonly own: Context.Context<never>
}

/**
 * The password of one connection attempt: a function pg calls when the server asks for one, which yields the Redacted
 * or runs the Effect under the services `current` holds then. pg is never given a text, which it would read as unset
 * when empty, falling back to PGPASSWORD and then to a password file; a function it calls, whatever it yields.
 *
 * A typed failure rejects with the CredentialError, which fails the attempt at the credential stage; a defect or
 * an interruption of the Effect rejects with a PasswordDefect, the operation's defect.
 */
const passwordOf = (spec: SessionSpec, services: AttemptServices): (() => Promise<string>) => {
	const configured = spec.password
	const secret: Effect.Effect<Redacted.Redacted, CredentialError> = Redacted.isRedacted(configured)
		? Effect.succeed(configured)
		: configured
	return () =>
		Effect.runPromiseWith(services.current)(
			secret.pipe(
				Effect.map(Redacted.value),
				Effect.sandbox,
				Effect.mapError((cause) => {
					const error = Cause.findError(cause)
					return Result.isSuccess(error)
						? error.success
						: new PasswordDefect({ defect: Cause.squash(cause) })
				})
			)
		)
}

/**
 * A session's client configuration over `socket`, the one the transport opened for it: it states every startup and
 * wire setting pg would otherwise read from the environment and can be told, the client encoding and the TLS
 * negotiation among them, so `PGCLIENT_ENCODING` and `PGSSLNEGOTIATION` reach no session, and a login's and an owner's
 * session its options (startupOptionsOf), so `PGOPTIONS` reaches none of theirs; the startup variables it cannot be told are
 * connection/environment.ts's. The password is the attempt's (passwordOf).
 */
const clientConfig = (
	spec: SessionSpec,
	socket: PgSocket,
	password: () => Promise<string>
): PgClientConfig => ({
	host: spec.transport.host,
	port: spec.transport.port,
	database: spec.database,
	user: spec.role,
	password,
	client_encoding: "utf8",
	sslnegotiation: "postgres",
	...startupOptionsOf(spec.startup, spec.controls),
	...wireModeOf(spec.startup),
	types: rawText,
	connectionTimeoutMillis: 0,
	ssl: verifyFull(spec.transport),
	stream: () => socket
})

/** Destroys a client's connection at once: the TLS socket pg reads, and the transport's socket under it. */
const destroyWire = (client: PgClient, socket: PgSocket): void => {
	client.connection.stream.destroy()
	socket.destroy()
}

/** The SSLRequest message: its length, 8, and the request code 80877103. */
const sslRequest = (): Uint8Array => Uint8Array.of(0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f)

/**
 * The bytes of a CancelRequest in protocol 3.0, the version the driver speaks: four Int32 fields, its length, the
 * request code, and the backend's process ID and secret key ("Before protocol version 3.2, the secret key was always 4
 * bytes long.", https://www.postgresql.org/docs/19/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-CANCELREQUEST).
 *
 * @formatConstant protocol 3.0's CancelRequest: four Int32 fields, its length counting itself
 */
const cancelRequestBytes = 16

/** The CancelRequest message: its length, cancelRequestBytes, the request code 80877102, and the backend's key. */
const cancelFrame = (key: BackendKey): Uint8Array => {
	const frame = new Uint8Array(cancelRequestBytes)
	const view = new DataView(frame.buffer)
	view.setInt32(0, cancelRequestBytes)
	view.setInt32(4, 80877102)
	view.setInt32(8, key.processId)
	view.setInt32(12, key.secretKey)
	return frame
}

/**
 * How a CancelRequest ended: `sent`, written over its connection's TLS, which the server closes once it has read it and
 * signalled the backend; or `unreached`, its connection failed or ended before the request was written, as the
 * operating system reports an unreachable host (refused, timed out, reset), or as the server refused the SSLRequest or
 * the TLS handshake failed. An unreached request is the server's own verdict that the client cannot reach it now.
 */
export type CancelEnd = "sent" | "unreached"

/**
 * One CancelRequest for whatever statement the session's backend is running, over a connection of its own: a socket
 * the transport opens, connected to its host and port, then the SSLRequest and verify-full TLS exactly as a session's
 * (sessionTls). It ends when that connection closes or fails (CancelEnd): `sent` once the request was written, which
 * the server reads and then closes the connection, `unreached` if it ended before. No clock of grizzle's ends it.
 * Either way, or when it is interrupted, its sockets are destroyed.
 */
const cancelRequest = (spec: SessionSpec, key: BackendKey): Effect.Effect<CancelEnd> =>
	Effect.callback<CancelEnd>((resume) => {
		const transport = spec.transport
		const raw = transport.open()
		const sockets: Array<{ readonly destroy: () => unknown }> = [raw]
		let end: CancelEnd = "unreached"
		let finished = false
		const finish = (): void => {
			if (finished) {
				return
			}
			finished = true
			for (const socket of sockets) {
				socket.destroy()
			}
			resume(Effect.succeed(end))
		}
		raw.on("error", finish)
		raw.once("close", finish)
		raw.once("connect", () => raw.write(sslRequest()))
		raw.once("data", (answer: Uint8Array) => {
			if (answer.length !== 1 || answer[0] !== 0x53) {
				finish()
				return
			}
			const secure = tlsConnect(sessionTls(transport, raw))
			sockets.push(secure)
			secure.on("error", finish)
			secure.once("close", finish)
			secure.once("secureConnect", () => {
				end = "sent"
				secure.write(cancelFrame(key))
			})
		})
		raw.setNoDelay(true)
		raw.connect(transport.port, transport.host)
		return Effect.sync(finish)
	})

/**
 * Where a session stands, the one state whatever reads it consults: `open`, its connection up and the session reusable;
 * `retired`, its connection up but never reused, since what ran on it left it unaccounted for (a refused BEGIN, an
 * answer the pipeline cannot account for, a transaction it could not end, an interruption with a statement in flight);
 * or `ended`, its connection gone, lost, ended by the server or destroyed, so nothing can run on it and it is never
 * reused either. Every pair of "reusable" and "connected" a session can be in is one of these: an ended session is
 * never open, and no session comes back from retired or ended.
 */
export type SessionState = "open" | "retired" | "ended"

/**
 * What moves a session's state: grizzle's own decision never to reuse it (`retire`), and its connection's end
 * (`end`), which pg reports, or a destroy causes.
 */
export type SessionEvent = "retire" | "end"

/**
 * The state each event leaves a session in, from each state: the whole of a session's transitions. Retiring an ended
 * session leaves it ended, and every state ends.
 */
export const sessionTransitions: {
	readonly [S in SessionState]: { readonly [E in SessionEvent]: SessionState }
} = {
	open: { retire: "retired", end: "ended" },
	retired: { retire: "retired", end: "ended" },
	ended: { retire: "ended", end: "ended" }
}

/**
 * The stand-ups a session has run (engine runtime/write/flight.ts StandUp), by name (standUpName): each the session
 * objects its committed stand-up transaction made, which the session holds until it ends (apply/stand-up.ts).
 */
export interface StoodUp {
	/** Every stand-up's name the session holds. */
	readonly held: ReadonlySet<StatementName>
	/** Records `names`, once the stand-up transaction that ran them committed. */
	readonly add: (names: ReadonlyArray<StatementName>) => void
}

/** One connected client in pipeline mode, with what grizzle keeps beside it. */
export interface Session {
	/** The login role the session logged in as, which its statements run as unless a prologue enters another. */
	readonly role: string
	/** The texts its transactions' controls send (ControlTexts). */
	readonly controls: ControlTexts
	/** The stand-ups it has run (StoodUp), none at its start. */
	readonly stoodUp: StoodUp
	/**
	 * One CancelRequest for the statement the backend is running, ended once its connection closes or fails, `sent` or
	 * `unreached` (CancelEnd): it never waits on the statement it cancels. The server ignores one that reaches the
	 * backend while it reads a command (REL_19_0 src/backend/tcop/postgres.c 3536-3546), a statement not read yet among
	 * them, so it stops nothing then.
	 */
	readonly cancel: Effect.Effect<CancelEnd>
	/** Where the session stands now (SessionState). */
	readonly state: () => SessionState
	/** Never reuse the session: it is retired, or stays ended. */
	readonly retire: () => void
	/**
	 * Ends the connection at once, failing whatever it was waiting for: its sockets are destroyed, nothing is awaited,
	 * and the session is ended from this call on. Only a session grizzle cannot end as it ends one it is done with
	 * (`close`) is destroyed: one a lease may still run on, one an interrupted flight cannot account for, or one whose
	 * close is interrupted.
	 */
	readonly destroy: () => void
	/**
	 * The wait for the connection's end, once a Terminate is on its way: done when pg reports it ended, which for a
	 * Terminate the server read is once the server closed it, and the server closes it only once the session's backend
	 * has exited, its temporary relations dropped and the backend out of the database's backends (makePool). The wait
	 * has no deadline; interrupted, it destroys the connection (`destroy`) and ends at once.
	 */
	readonly closed: Effect.Effect<void>
	/**
	 * The session ended as grizzle ends every session it is done with, the one way a session ends normally: an open one
	 * by a Terminate (pg's Client.end, which writes it and half-closes the connection), then the wait for the server's
	 * close (`closed`); a retired or ended one destroyed, its connection unaccounted for or gone. A pool's idle sessions
	 * are given their Terminate by pg's Pool as it ends, and their end waits for the same close (makePool).
	 */
	readonly close: Effect.Effect<void>
	/**
	 * The most bytes one write of the session's connection carries, and so one flight (flightMaxBytes):
	 * the flight's builder refuses a longer flight before any byte of it is written (wire/batch.ts send).
	 */
	readonly flightMaxBytes: number
	/**
	 * The longest message the session's server reads, as its length word counts it (messageMaxBytes):
	 * the flight's builder refuses a flight with a longer Parse or Bind before any byte of it is written (wire/batch.ts
	 * send, bindOverrun).
	 */
	readonly messageMaxBytes: number
	/**
	 * Writes `pipeline` in one corked write, and reports each query's answer by its index, then the pipeline's end: the ReadyForQuery after its last query, or the connection's end once every query
	 * has failed. Its bytes, as pg writes them, are within flightMaxBytes, and each of its Parse and Bind messages within
	 * messageMaxBytes. `onCut` reports, before any query fails for it,
	 * a write that failed while its stream stood: the end of the pipeline's last message never left the process
	 * (flightEnd).
	 */
	readonly send: (
		pipeline: ReadonlyArray<WireQuery>,
		onAnswer: (index: number, answer: Answer) => void,
		onEnd: () => void,
		onCut: () => void
	) => void
}

/**
 * A served statement on the extended protocol, under its name: pg sends its Parse only where the connection has not
 * parsed the name yet (pg 8.23 query.js prepare, hasBeenParsed), then its Bind of the name. pg refuses a query before
 * its bytes go out only for what this never builds: no text, parameters that are no array or that its value mapper
 * throws on (every parameter is a string, or a Uint8Array it sends in binary, a view of the same bytes), or a name the
 * connection parsed for another text, which only a SHA-256 collision gives (core/prepared.ts). So a pipeline is
 * written whole: no statement is skipped while the ones after it, COMMIT included, are sent.
 */
const preparedQuery = (query: PreparedStatement): PgQueryConfig => ({
	name: query.text.name,
	text: query.text.sql,
	values: query.params.slice(),
	rowMode: "array"
})

/**
 * A one-shot statement on the extended protocol, as the unnamed statement. pg sends a query without parameters or a
 * name as a simple Query message, which accepts several statements in one text, unless its `queryMode` is "extended",
 * which pg's types leave out. pg refuses it before its bytes go out only for what preparedQuery's statements never
 * hold either.
 */
const oneShotQuery = (query: OneShotStatement): PgQueryConfig => ({
	text: query.sql,
	values: query.params.slice(),
	rowMode: "array",
	queryMode: "extended"
})

const controlQuery = (sql: EmittedText | ReplicationCommand): PgQueryConfig => ({
	text: sql,
	rowMode: "array"
})

/** The rows no taken statement's outcome holds (batch.ts RowIntake). */
const noRows: OutputRows = outputRows([])

/**
 * The configuration of one query of a pipeline, in array row mode: a served statement under its name, a one-shot
 * statement as the unnamed statement on the extended protocol, a control as a simple Query.
 */
const queryConfig = (query: WireQuery, controls: ControlTexts): PgQueryConfig => {
	switch (query._tag) {
		case "control":
			return controlQuery(controlText(controls, query.control))
		case "prepared":
			return preparedQuery(query)
		case "oneShot":
			return oneShotQuery(query)
	}
}

/**
 * Submits one query of a pipeline to `client` as the driver's own Query, with listeners and no callback, so pg keeps no
 * row (types/driver.ts PgQuery), and reports its answer to `answer` once. Each row is admitted as it arrives,
 * every cell a text, a native loop with no closure per row: a served statement's taken rows go to its intake's `take`
 * at once, every other query's are kept for its answer. A row with a NULL, or a cell that is no text, makes the answer
 * unreadable, and no row after it is taken or kept; the query ran, so its answer still carries its command tag.
 */
const submit = (
	client: PgClient,
	spec: SessionSpec,
	query: WireQuery,
	answer: (answer: Answer) => void
): void => {
	submitConfig(
		client,
		spec,
		queryConfig(query, spec.controls),
		query._tag === "prepared" && query.intake.kind === "taken" ? query.intake.take : undefined,
		answer
	)
}

/**
 * Submits one query of its configuration (submit), a served statement's rows going to `taken` as they arrive, every
 * other query's kept for its answer: a pipeline's query, or a replication connection's simple Query
 * (ReplicationSession).
 */
const submitConfig = (
	client: PgClient,
	spec: SessionSpec,
	config: PgQueryConfig,
	taken: ((row: OutputRow) => void) | undefined,
	answer: (answer: Answer) => void
): void => {
	const pg = new spec.driver.Query(config)
	const kept: Array<OutputRow> = []
	let readable = true
	pg.on("row", (row) => {
		if (!readable) {
			return
		}
		if (!isTextRow(row)) {
			readable = false
			return
		}
		if (taken === undefined) {
			kept.push(outputRow(row))
		} else {
			taken(outputRow(row))
		}
	})
	pg.on("end", (result) => {
		answer(
			readable
				? {
						_tag: "result",
						outcome: {
							command: result.command,
							rows: taken === undefined ? outputRows(kept) : noRows
						}
					}
				: { _tag: "unreadable", command: result.command }
		)
	})
	pg.on("error", (error) => {
		answer(errorAnswer(spec.driver, error))
	})
	client.query(pg)
}

/**
 * The last chunk of every flight's corked write, a new empty one, whose callback reports how the write ended: Node calls
 * every chunk's callback of one corked write with its one outcome, an error before it destroys the stream for it. An
 * error while the stream stands is the write's own (the socket's, or SSL_write's): it failed before its last byte, the
 * end of the pipeline's last message, left the process, since a write that hands its every byte on succeeds. So the
 * server never read that message whole and never ran it: a COMMIT there never ran. An error once the stream is destroyed
 * cancels a write that may have gone out whole, and proves nothing; so does every failure of a transport's socket that
 * is no native one, which Node's TLS reaches through a JavaScript stream that reports a write's failure only after the
 * stream is destroyed.
 */
const flightEnd = (): Uint8Array => new Uint8Array(0)

/**
 * The whole flight is written corked and flushed at once; the stream is uncorked whatever the writes threw. The session
 * is ended in the step that reports its connection's end to whoever waits for it (`closed`), so a caller its close
 * resumes finds it ended.
 */
const makeSession = (
	client: PgClient,
	socket: PgSocket,
	spec: SessionSpec,
	key: BackendKey
): Session => {
	let state: SessionState = "open"
	const stood = new Set<StatementName>()
	const move = (event: SessionEvent): void => {
		state = sessionTransitions[state][event]
	}
	const end = (): void => {
		move("end")
	}
	/** Done once the connection has ended, the session with it (`closed`). */
	const ended = Deferred.makeUnsafe<void>()
	const connectionEnded = (): void => {
		move("end")
		Deferred.doneUnsafe(ended, Exit.void)
	}
	client.on("error", end)
	client.on("end", connectionEnded)
	const destroy = (): void => {
		destroyWire(client, socket)
		move("end")
	}
	const closed: Effect.Effect<void> = Deferred.await(ended).pipe(
		Effect.interruptible,
		Effect.onInterrupt(() => Effect.sync(destroy))
	)
	const send: Session["send"] = (pipeline, onAnswer, onEnd, onCut) => {
		const connection = client.connection
		let answered = 0
		let drained = false
		const settle = (): void => {
			if (answered < pipeline.length || !(drained || state === "ended")) {
				return
			}
			client.off("drain", drain)
			client.off("end", drain)
			onEnd()
		}
		const drain = (): void => {
			drained = true
			settle()
		}
		client.on("drain", drain)
		client.on("end", drain)
		connection.stream.cork()
		const written = Result.try(() => {
			let next = 0
			for (const query of pipeline) {
				const index = next
				next += 1
				submit(client, spec, query, (answer) => {
					onAnswer(index, answer)
					answered += 1
					settle()
				})
			}
			connection.stream.write(flightEnd(), (error) => {
				if (Predicate.isError(error) && !connection.stream.destroyed) {
					onCut()
				}
			})
		})
		connection.stream.uncork()
		if (Result.isFailure(written)) {
			throw written.failure
		}
	}
	return {
		role: spec.role,
		controls: spec.controls,
		stoodUp: {
			held: stood,
			add: (names) => {
				for (const name of names) {
					stood.add(name)
				}
			}
		},
		flightMaxBytes: flightMaxBytes,
		messageMaxBytes: messageMaxBytes,
		cancel: cancelRequest(spec, key),
		state: () => state,
		retire: () => {
			move("retire")
		},
		destroy,
		closed,
		close: Effect.suspend((): Effect.Effect<void> => {
			switch (state) {
				case "open":
					client.end(terminated)
					return closed
				case "retired":
				case "ended":
					return Effect.sync(destroy)
			}
		}),
		send
	}
}

/** A session from a client pg has just connected over `socket`: its BackendKeyData must be there. */
const sessionOf = (client: PgClient, socket: PgSocket, spec: SessionSpec): Session | undefined => {
	const key = backendKeyOf(client)
	return key === undefined ? undefined : makeSession(client, socket, spec, key)
}

/**
 * What the owner of a client class learns of each client it constructs: `opened`, the client and the socket the
 * transport opened for it, as it is constructed; and `ready`, the client and its session once the server has answered
 * its startup, before pg hands the client to anyone, or no session when the server sent no BackendKeyData.
 */
interface ClientHooks {
	readonly opened: (client: PgClient, socket: PgSocket) => void
	readonly ready: (client: PgClient, session: Session | undefined) => void
}

/**
 * The client class of the sessions over `spec`, derived from the driver's own Client. pg's Pool constructs each client
 * with its own copy of its options, from which it hides the password, and reads `connectionTimeoutMillis` from those
 * options as its own bound on the wait for a free client; so a client takes its configuration from here instead, with
 * no connect timeout (clientConfig), and the wait stays the lease's. Each client opens its socket through the transport
 * as it is constructed. An `error` event of a client in use is also the failure of its queries, which their callbacks
 * receive, so the event is dropped rather than left to crash the process. A connection that failed is destroyed: pg
 * leaves it open when the failure is the client's own, a rejected password function or a SCRAM proof that does not
 * verify. The client's password runs under the services of the attempt that constructs it until its connection is set
 * up, and under `own` after.
 *
 * The session is made at the first ReadyForQuery, by a listener the constructor adds before pg's own, so it is there
 * before pg calls back whoever asked for the client (ClientHooks.ready). Once pg upgrades the connection to TLS, every
 * error the TLS socket raises before its handshake completes joins `handshakes`, by a listener ahead of pg's, which
 * fails the attempt with it.
 */
const sessionClient = (
	spec: SessionSpec,
	attempt: AttemptServices,
	handshakes: Handshakes,
	hooks: ClientHooks
): new () => PgClient =>
	class SessionClient extends spec.driver.Client {
		constructor() {
			const services: AttemptServices = { current: attempt.current, own: attempt.own }
			const socket = spec.transport.open()
			super(clientConfig(spec, socket, passwordOf(spec, services)))
			hooks.opened(this, socket)
			this.connection.once("sslconnect", () => {
				const secure = this.connection.stream
				const handshake = { done: false }
				secure.once("secureConnect", () => {
					handshake.done = true
				})
				secure.prependListener("error", (error: unknown) => {
					if (!handshake.done && Predicate.isObject(error)) {
						handshakes.add(error)
					}
				})
			})
			this.connection.once("readyForQuery", () => {
				services.current = services.own
				hooks.ready(this, sessionOf(this, socket, spec))
			})
			this.on("error", () => undefined)
			this.connection.on("error", () => {
				destroyWire(this, socket)
			})
		}
	}

/** A client end's callback that wants nothing: pg calls it once the connection has ended. */
const terminated = (): void => undefined

/**
 * The wait for every one of `sessions` to close (Session closed), each a Terminate on its way, all at once and
 * interruptible as one. Interrupted, it destroys every one of them still open before it ends, whether or not the
 * wait for that one had begun: a wait interrupted before its own fiber ran never reaches the destroy its `closed`
 * holds, so a pool's release in a fiber already interrupted, the case of every scope an interruption closes, would
 * return with idle sessions open, their backends alive past the release.
 */
const closedAll = (sessions: ReadonlyArray<Session>): Effect.Effect<void> =>
	Effect.all(
		Arr.map(sessions, (session) => session.closed),
		{ concurrency: "unbounded", discard: true }
	).pipe(
		Effect.interruptible,
		Effect.onInterrupt(() =>
			Effect.sync(() => {
				for (const session of sessions) {
					session.destroy()
				}
			})
		)
	)

/**
 * One session outside any pool over `spec`, closed with the scope as every session grizzle is done with is (Session
 * close): its Terminate written, then the wait for the server's close, which the server makes only once the session's
 * backend has exited, so a DROP DATABASE after `grizzle migrate` finds no backend of its session. `attach` is handed its client once it is connected and
 * before the session is returned, so a listener it adds misses nothing the session receives. The attempt is
 * interruptible.
 */
const connectOne = (
	spec: SessionSpec,
	attach: (client: PgClient) => void
): Effect.Effect<Session, ConnectRefusal, Scope.Scope> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const services = yield* Effect.context()
			const sockets: Array<PgSocket> = []
			const sessions: Array<Session> = []
			const handshakes: Handshakes = new WeakSet()
			const SessionClient = sessionClient(spec, { current: services, own: services }, handshakes, {
				opened: (_client, socket) => {
					sockets.push(socket)
				},
				ready: (_client, session) => {
					if (session !== undefined) {
						sessions.push(session)
					}
				}
			})
			const client = new SessionClient()
			const destroy = (): void => {
				client.connection.stream.destroy()
				for (const socket of sockets) {
					socket.destroy()
				}
			}
			const connected = Effect.callback<void, ConnectRefusal>((resume) => {
				client.connect((error: unknown) => {
					resume(
						error === null || error === undefined
							? Effect.void
							: attemptFailed(spec, handshakes, error)
					)
				})
				return Effect.sync(destroy)
			})
			yield* Effect.onError(restore(connected), () => Effect.sync(destroy))
			const [session] = sessions
			if (session === undefined) {
				destroy()
				return yield* new NoCancelKey()
			}
			yield* Effect.addFinalizer(() => session.close)
			attach(client)
			return session
		})
	)

/** A client that is handed nothing beyond its session. */
const attachNothing = (): void => undefined

/**
 * One session outside any pool (the migration owner's, the live leader's), an owner's, which starts under no options of
 * a login's, closed with the scope (connectOne).
 */
export const connectSession = (
	given: Omit<SessionSpec, "startup">
): Effect.Effect<Session, ConnectRefusal, Scope.Scope> =>
	connectOne({ ...given, startup: { kind: "owner" } }, attachNothing)

/**
 * What a listening session reports, each in pg's own event, in the order the server sent it: `notified`, the payload of
 * a notification on a channel it listens on, absent only where pg read none; and `ended`, once, when its connection
 * ends, lost, ended by the server or destroyed, after which nothing more is notified.
 */
export interface ListenHooks {
	readonly notified: (payload: string | undefined) => void
	readonly ended: () => void
}

/**
 * A listening session outside any pool (adapter/live/listen.ts), the installation's decoder login's, an owner's, which
 * starts under no login's options, closed with the scope (connectOne), its hooks attached before the session is
 * returned, so every notification it receives and its end are reported once it LISTENs. A connection the network drops
 * without a word is found only by the transport's own keepalive (Transport.open), for which grizzle sets no interval.
 */
export const connectListener = (
	given: Omit<SessionSpec, "startup">,
	hooks: ListenHooks
): Effect.Effect<Session, ConnectRefusal, Scope.Scope> =>
	connectOne({ ...given, startup: { kind: "owner" } }, (client) => {
		client.on("notification", (message) => {
			hooks.notified(message.payload)
		})
		client.once("end", hooks.ended)
	})
/**
 * How a query on a replication connection failed: the server refused it, the session ended under it, or pg would not
 * send it or answered what the connection cannot account for (DriverFailure).
 */
export type ReplicationFailure = ServerError | ConnectionLost | DriverFailure

/**
 * A replication query's end with no ErrorResponse, by whether its connection ended, as batch.ts `broken` reads a
 * pipeline's by its session's state: a stream destroyed, or whose read side ended, is the connection's loss; a stream
 * still standing is pg's own refusal of the query, a DriverFailure and never a transport loss.
 */
const unexplained = (client: PgClient): ConnectionLost | DriverFailure =>
	client.connection.stream.destroyed || client.connection.stream.readableEnded
		? new ConnectionLost({ operation: "query", ended: { by: "transport" } })
		: new DriverFailure({ operation: "query" })

/** The failure an answer that is no result reads as on `client`'s replication connection. */
const replicationFailure = (
	client: PgClient,
	answer: Exclude<Answer, { readonly _tag: "result" | "unreadable" }>
): ReplicationFailure => {
	switch (answer._tag) {
		case "refused":
			return answer.error
		case "terminated":
			return new ConnectionLost({
				operation: "query",
				ended: { by: "server", error: answer.error }
			})
		case "failed":
			return unexplained(client)
	}
}

/**
 * The live leader's replication connection (adapter/live/leader.ts): a walsender of the database, which reads only
 * simple Queries, SQL or a replication command, each sent alone and waited for, either for its completion alone
 * (`run`), whose rows none of the leader's reads, a slot's creation answering a NULL snapshot name among them, or for
 * its rows (`read`), a row it cannot read its failure; then the one stream START_REPLICATION opens (`stream`), each
 * CopyData of which is handed to `data` the moment it arrives, as the bytes it carries, and which ends only in failure,
 * the server's refusal, the session's end, or the server ending the stream; and the replies the stream takes, each one
 * CopyData (`reply`), written by pg's own writer of one (copyWriterOf).
 */
export interface ReplicationSession {
	readonly run: (text: EmittedText | ReplicationCommand) => Effect.Effect<void, ReplicationFailure>
	readonly read: (
		text: EmittedText
	) => Effect.Effect<OutputRows, ReplicationFailure | UnreadableAnswer>
	readonly stream: (
		start: ReplicationCommand,
		data: (chunk: Uint8Array) => void
	) => Effect.Effect<never, ReplicationFailure | ReplicationEnded>
	readonly reply: (chunk: Uint8Array) => void
}

/**
 * One simple Query on a replication connection, sent alone, as it completed: its rows, or rows it could not read; its
 * refusal or the session's end its failure. A query outside a transaction block runs in its own, which its completion
 * committed.
 */
const completed = (
	client: PgClient,
	spec: SessionSpec,
	text: EmittedText | ReplicationCommand
): Effect.Effect<Extract<Answer, { readonly _tag: "result" | "unreadable" }>, ReplicationFailure> =>
	Effect.callback((resume) => {
		submitConfig(client, spec, controlQuery(text), undefined, (answer) => {
			switch (answer._tag) {
				case "result":
				case "unreadable":
					resume(Effect.succeed(answer))
					return
				case "refused":
				case "terminated":
				case "failed":
					resume(Effect.fail(replicationFailure(client, answer)))
			}
		})
	})

/**
 * The writer of one CopyData message on a client's connection, pg 8.23's `sendCopyFromChunk` (lib/connection.js), which
 * its types leave out: read once, checked, and bound to the connection; none where pg has no such member. pg-protocol's
 * writer copies the chunk by Buffer's own `copy` (buffer-writer.js Writer.add), which a plain Uint8Array lacks, so each
 * chunk is handed over as a Buffer viewing its bytes, never a copy of them.
 */
const copyWriterOf = (client: PgClient): ((chunk: Uint8Array) => void) | undefined => {
	const connection: unknown = client.connection
	if (!Predicate.hasProperty(connection, "sendCopyFromChunk")) {
		return undefined
	}
	const write: unknown = connection.sendCopyFromChunk
	return Predicate.isFunction(write)
		? (chunk) => {
				Reflect.apply(write, connection, [
					Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
				])
			}
		: undefined
}

/** The bytes a CopyData message carries, as pg 8.23 parses it (pg-protocol copyData's `chunk`). */
const copyChunk = (message: unknown): Uint8Array | undefined =>
	Predicate.hasProperty(message, "chunk") && message.chunk instanceof Uint8Array
		? message.chunk
		: undefined

/**
 * A replication session over `client` (ReplicationSession). The stream is pg's own Submittable, which pg makes the
 * client's active query (client.js _pulseQueryQueue) and hands every CopyData it reads (_handleCopyData), the
 * CopyBothResponse before them being a message pg reads and leaves to no one; its every other handler is the end of
 * the stream: an ErrorResponse its refusal, the connection's end its loss, pg's own error on a connection still
 * standing, or a CopyData that carries no chunk, a DriverFailure (unexplained), a ReadyForQuery the server's end of it.
 */
const replicationOf = (
	client: PgClient,
	spec: SessionSpec,
	write: (chunk: Uint8Array) => void
): ReplicationSession => ({
	run: (text) => Effect.asVoid(completed(client, spec, text)),
	read: (text) =>
		Effect.flatMap(completed(client, spec, text), (answer) =>
			answer._tag === "result"
				? Effect.succeed(answer.outcome.rows)
				: Effect.fail(new UnreadableAnswer({ index: 0, fate: "committed" }))
		),
	stream: (start, data) =>
		Effect.callback<never, ReplicationFailure | ReplicationEnded>((resume) => {
			const finished = (): void => {
				resume(Effect.fail(new ReplicationEnded()))
			}
			const ignored = (): void => undefined
			client.query({
				submit: (connection) => {
					connection.query(start)
				},
				handleCopyData: (message: unknown) => {
					const chunk = copyChunk(message)
					if (chunk === undefined) {
						resume(Effect.fail(new DriverFailure({ operation: "query" })))
						return
					}
					data(chunk)
				},
				handleError: (error: unknown) => {
					const answer = errorAnswer(spec.driver, error)
					resume(
						Effect.fail(
							answer._tag === "result" || answer._tag === "unreadable"
								? unexplained(client)
								: replicationFailure(client, answer)
						)
					)
				},
				handleReadyForQuery: finished,
				handleRowDescription: ignored,
				handleDataRow: ignored,
				handleCommandComplete: ignored,
				handleEmptyQuery: ignored,
				handlePortalSuspended: ignored,
				handleCopyInResponse: finished
			})
		}),
	reply: write
})

/**
 * The live leader's replication connection, outside any pool: a session of `given`'s role, the decoder login, which
 * starts as a walsender of its database and states no login's options (Startup), closed with the scope (connectOne).
 */
export const connectReplication = (
	given: Omit<SessionSpec, "startup">
): Effect.Effect<ReplicationSession, ConnectRefusal, Scope.Scope> => {
	const spec: SessionSpec = { ...given, startup: { kind: "replication" } }
	const held: { client: PgClient | undefined } = { client: undefined }
	return Effect.flatMap(
		connectOne(spec, (client) => {
			held.client = client
		}),
		() => {
			const client = held.client
			if (client === undefined) {
				return Effect.die(defect("connectOne hands its client to attach before it returns"))
			}
			const write = copyWriterOf(client)
			return write === undefined
				? Effect.fail(new DriverRefused({ said: "the driver's connection writes no CopyData" }))
				: Effect.succeed(replicationOf(client, spec, write))
		}
	)
}

/**
 * What one lease's ask for a client came to, once pg answered it: pg's client, held for the lease with its permit; or
 * its refusal, the permit back, with what the attempt failed with.
 */
type Settled =
	| { readonly _tag: "connected"; readonly client: PgPoolClient }
	| { readonly _tag: "refused"; readonly failure: Effect.Effect<never, AcquireRefusal> }

/**
 * Where one lease's ask for a client stands, and so who holds its permit: queued for a permit, holding none; connecting,
 * its permit given to pg's Pool, which was asked for a client and has not answered; or settled.
 */
type AskState =
	| { readonly _tag: "queued" }
	| { readonly _tag: "connecting"; readonly attempt: Attempt }
	| Settled

/**
 * One lease's ask for a client. It moves only in plain synchronous code, never across a fiber's steps: the lease waits
 * for `settled` alone, interruptibly, which carries what the ask came to; an interrupted lease withdraws its ask at once,
 * without interruption, so neither a permit nor a client is ever in flight between fibers where an interruption could
 * drop it.
 */
interface Ask {
	state: AskState
	/** The services of the lease the ask is for, under which its connection attempt's password runs. */
	readonly services: Context.Context<never>
	/** Done with what the ask came to, once it is connected or refused. */
	readonly settled: Deferred.Deferred<Settled>
}

/**
 * The pool's permits, one for each session up to `bounds.max`, as they stand between asks: some free and no ask waiting
 * (`free`, at least one), asks waiting for one in order and none free (`waiting`, at least one), or neither
 * (`exhausted`). A free permit and a waiting ask never stand side by side: a permit that comes back goes to the first
 * ask waiting, and only when none waits is it free.
 */
type Permits =
	| { readonly _tag: "free"; readonly count: number }
	| { readonly _tag: "waiting"; readonly queue: Arr.NonEmptyReadonlyArray<Ask> }
	| { readonly _tag: "exhausted" }

const exhausted: Permits = { _tag: "exhausted" }

/** The permits once `asks` wait in order: waiting, or exhausted when none does. */
const waitingFor = (asks: ReadonlyArray<Ask>): Permits =>
	Arr.isReadonlyArrayNonEmpty(asks) ? { _tag: "waiting", queue: asks } : exhausted

/** The permits with `ask` no longer among those waiting. */
const withdrawn = (permits: Permits, ask: Ask): Permits =>
	permits._tag === "waiting" ? waitingFor(Arr.filter(permits.queue, (w) => w !== ask)) : permits

/** Who pg's answer to one request for a client is for: the ask waiting for it, or nobody once that lease left. */
type AttemptWaiter = { readonly _tag: "waiting"; readonly ask: Ask } | { readonly _tag: "nobody" }

/** One request to pg's Pool for a client, made for an ask holding a permit. */
interface Attempt {
	waiter: AttemptWaiter
}

const nobody: AttemptWaiter = { _tag: "nobody" }

/** What an ask comes to once its pool has ended: the layer that built the pool was released. */
const layerReleased = (): Settled => ({
	_tag: "refused",
	failure: Effect.fail(new LayerReleased())
})

/**
 * What pg's answer to an attempt reaches in the pool that made it (makePool): that pg answered it, so it holds its
 * permit no longer as an attempt; the way a permit goes back; the client handed to the ask waiting for it, which then
 * holds the permit until its lease takes the client; and the one settling of an ask, its state and its `settled`
 * together.
 */
interface AttemptOwner {
	readonly answered: (attempt: Attempt) => void
	readonly permitBack: () => void
	readonly handOver: (ask: Ask, client: PgPoolClient) => void
	readonly settle: (ask: Ask, settled: Settled) => void
}

/**
 * pg's callback for one attempt. For the ask waiting for it, the client is held for the lease with its permit, or the
 * failure is the ask's and the permit goes back. When nobody waits, the lease having left or the pool having ended, the
 * client goes back to pg's Pool and the permit with it: the pool's end leaves no attempt waiting (makePool), so an
 * answer for a waiting ask always comes before it. pg keeps the callback for the client's life (the connection's
 * `connect` listener holds pg's own callback, which holds this), so it is made here, apart from any lease, and drops
 * the ask once it has answered: a connected client keeps no lease's context.
 */
const answerAttempt =
	(spec: SessionSpec, handshakes: Handshakes, attempt: Attempt, owner: AttemptOwner) =>
	(error: unknown, client: PgPoolClient | undefined): void => {
		owner.answered(attempt)
		const waiter = attempt.waiter
		attempt.waiter = nobody
		if (waiter._tag === "nobody") {
			client?.release(false)
			owner.permitBack()
			return
		}
		if (client !== undefined) {
			owner.handOver(waiter.ask, client)
			return
		}
		owner.settle(waiter.ask, {
			_tag: "refused",
			failure: attemptFailed(spec, handshakes, error)
		})
		owner.permitBack()
	}

/** Where a login's sessions connect: the driver, the transport, the database, the login role and the password. */
export type LoginConnection = Omit<SessionSpec, "startup" | "controls">

interface PoolConfig {
	/** Where each of the pool's sessions connects. */
	readonly connection: LoginConnection
	/**
	 * What every session of the login sends that no program states: the startup options pinning its role's defaults and
	 * its transactions' control texts, its served file's (served/forms.ts ServedSession).
	 */
	readonly session: ServedSession
	/** The pool's bounds (DbConfig.pool). */
	readonly bounds: PoolBounds
}

/**
 * A pool's permits as they stand at one moment, one permit for each session up to its bounds' `max`: each free; held by
 * an ask that is no lease yet (`attempting`: an attempt pg's Pool has not answered, a left lease's among them, or a
 * client pg handed over that its lease has not taken yet); or held by a session handed to a lease and not yet released
 * (`leased`; a connection still being established is none). So free + attempting + leased is the pool's `max` at every
 * moment, and a permit that none of them holds is lost. `waiting` counts the leases queued for a permit, which wait only
 * while none is free.
 */
export interface PoolState {
	readonly free: number
	readonly attempting: number
	readonly leased: number
	readonly waiting: number
}

export interface SessionPool {
	readonly role: string
	/** pg's Pool, holding the pool's bounds. */
	readonly native: PgPool
	/** A session for the scope. */
	readonly lease: Effect.Effect<Session, AcquireRefusal, Scope.Scope>
	/** Open connections: leased, idle, or still being established. */
	readonly size: Effect.Effect<number>
	/** The pool's permits and its waiting leases, read in one step (PoolState). */
	readonly state: Effect.Effect<PoolState>
}

/**
 * Builds the pool in the current scope; it ends when that scope closes. A pool is a login's: each of its sessions
 * starts under the login's pinned defaults (SessionSpec startup), and is kept for the pool's life once opened, never
 * closed for being idle (see the header's Pool). pg's Pool reports an idle client that failed after it has closed and
 * dropped it, so its `error` event wants nothing. The lease's services hold only while pg constructs and starts connecting a client inside
 * `connect`, and that client keeps them only until its connection is set up.
 *
 * Its end, when the scope closes: pg's Pool ends, which writes a Terminate to each idle client, half-closes its
 * connection and refuses every later ask; the wire of every client still connecting, handed to a lease or leased is
 * destroyed; every ask still unsettled is refused with LayerReleased; and the end then waits for the server to close
 * every connection it did not destroy, an idle session's, or one a release was closing already. A backend's server
 * closes its connection only once the backend has exited: proc_exit runs the before_shmem_exit callbacks, among them
 * the drop of the session's temporary relations (REL_19_0 src/backend/catalog/namespace.c 4610
 * RemoveTempRelationsCallback), then the on_shmem_exit ones, which take the backend out of the database's backends
 * (src/backend/storage/lmgr/proc.c 554 ProcKill, 594 RemoveProcFromArray; backend_status.c 218, its pg_stat_activity
 * row), and only then the on_proc_exit ones, the connection's close among them (src/backend/storage/ipc/ipc.c 166
 * proc_exit_prepare; src/backend/libpq/pqcomm.c 287 socket_close, which leaves the socket open until the process dies
 * so that a client "can be sure the backend has exited"). So once the end returns, no backend of the pool's idle
 * sessions counts against the database: a DROP DATABASE after it finds none, where it found a backend still dropping
 * its session's temporary relations, the rule judge's deltas, its sentinel and the write's carriers
 * (physical/ddl/rules.ts addStandUps, sql/ast.ts CreateCarrier), each a table with its TOAST table and index, its row
 * types and its NOT NULL constraints: 150 tables, 642 objects, 1.8 s for one session of pantry's export suite and 6
 * to 13 s on its whole project (edullm P5, 2026-11-21), where DROP DATABASE waits 5 s. The wait has no deadline of
 * grizzle's: interrupting the release, or the fiber whose scope it closes, your own timeout among the ways, ends it and
 * destroys every connection still open (closedAll), as the end of a session leased then is destroyed at once.
 */
export const makePool = (config: PoolConfig): Effect.Effect<SessionPool, never, Scope.Scope> =>
	Effect.gen(function* () {
		const { bounds } = config
		const spec: SessionSpec = {
			...config.connection,
			startup: { kind: "login", options: config.session.startup },
			controls: config.session
		}
		const own = yield* ownServices()
		const attemptServices: AttemptServices = { current: own, own }
		/**
		 * The session of each client pg's Pool connected, made when its client is ready, before anyone holds the
		 * client, and kept beside it; a client with none had no BackendKeyData, and an ended session goes with its
		 * client. `wires` holds every client constructed, with the socket the transport opened for it, until it ends: what the
		 * pool's end destroys or waits for.
		 */
		const sessions = new WeakMap<PgClient, Session>()
		const wires = new Map<PgClient, PgSocket>()
		const handshakes: Handshakes = new WeakSet()
		const native = new spec.driver.Pool({
			Client: sessionClient(spec, attemptServices, handshakes, {
				opened: (client, socket) => {
					wires.set(client, socket)
					client.once("end", () => {
						wires.delete(client)
					})
				},
				ready: (client, session) => {
					if (session === undefined) {
						return
					}
					sessions.set(client, session)
				}
			}),
			max: bounds.max,
			idleTimeoutMillis: 0
		})
		native.on("error", () => undefined)
		/**
		 * The permits. An ask takes a permit before pg's Pool is asked for a client for it, and the permit comes back
		 * once pg has that client back or the attempt has failed; an attempt abandoned while pg connects or hands over
		 * its client keeps its permit until pg answers. So pg's Pool always has an idle client or room for the attempt,
		 * and never queues one but for the turn it takes to hand an idle client over.
		 */
		let permits: Permits = { _tag: "free", count: bounds.max }
		/**
		 * The clients handed to a lease and not yet released. pg's Pool counts a client still connecting in totalCount
		 * and not in idleCount, so its difference would count a session being established as leased.
		 */
		const leased = new Set<PgPoolClient>()
		/** The attempts pg's Pool has not answered, each holding the permit its ask took, a left lease's included. */
		const pending = new Set<Attempt>()
		/** The asks pg answered with a client their lease has not taken yet, each holding its permit, with that client. */
		const handed = new Map<Ask, PgPoolClient>()
		/**
		 * The asks not yet settled, whose leases wait: queued for a permit, or connecting. An ask leaves when it settles
		 * or its lease withdraws it, and the pool's end refuses every one still here: pg's Pool drops the asks it queued
		 * for an idle client when it ends, and answers none of them.
		 */
		const unsettled = new Set<Ask>()

		/** Settles `ask`: what it came to, for its lease to take. */
		const settle = (ask: Ask, settled: Settled): void => {
			unsettled.delete(ask)
			ask.state = settled
			Deferred.doneUnsafe(ask.settled, Exit.succeed(settled))
		}

		/**
		 * Asks pg's Pool for a client for `ask`, which holds a permit, under the services of its lease, pg's answer
		 * reaching `owner`; whether pg holds the permit now. pg's Pool ends only in this pool's finalizer, so an ending
		 * pool is a released layer: the ask is refused with LayerReleased, read in the same turn as `connect`, so no end
		 * can come between, and the permit is the caller's again, as it is when pg's Pool throws.
		 */
		const attemptFor = (ask: Ask, owner: AttemptOwner): boolean => {
			if (native.ending) {
				settle(ask, layerReleased())
				return false
			}
			const attempt: Attempt = { waiter: { _tag: "waiting", ask } }
			ask.state = { _tag: "connecting", attempt }
			pending.add(attempt)
			attemptServices.current = ask.services
			const started = Result.try(() => {
				native.connect(answerAttempt(spec, handshakes, attempt, owner))
			})
			attemptServices.current = own
			if (Result.isSuccess(started)) {
				return true
			}
			pending.delete(attempt)
			attempt.waiter = nobody
			settle(ask, { _tag: "refused", failure: Effect.die(started.failure) })
			return false
		}

		/**
		 * What pg's answers reach in this pool: the one settling of an ask, and a permit back, to the first ask waiting
		 * that pg's Pool takes it for, whose attempt's answer reaches this owner in turn, else free.
		 */
		const owner: AttemptOwner = {
			answered: (attempt) => {
				pending.delete(attempt)
			},
			handOver: (ask, client) => {
				handed.set(ask, client)
				settle(ask, { _tag: "connected", client })
			},
			settle,
			permitBack: () => {
				while (permits._tag === "waiting") {
					const [first, ...rest] = permits.queue
					permits = waitingFor(rest)
					if (attemptFor(first, owner)) {
						return
					}
				}
				permits = { _tag: "free", count: permits._tag === "free" ? permits.count + 1 : 1 }
			}
		}

		/** A new ask for the lease whose services are `services`: given a free permit and pg asked at once, or queued. */
		const newAsk = (services: Context.Context<never>): Ask => {
			const made: Ask = {
				state: { _tag: "queued" },
				services,
				settled: Deferred.makeUnsafe<Settled>()
			}
			unsettled.add(made)
			if (permits._tag !== "free") {
				permits = {
					_tag: "waiting",
					queue: permits._tag === "waiting" ? Arr.append(permits.queue, made) : [made]
				}
				return made
			}
			permits = permits.count === 1 ? exhausted : { _tag: "free", count: permits.count - 1 }
			if (!attemptFor(made, owner)) {
				owner.permitBack()
			}
			return made
		}

		/**
		 * An interrupted lease's ask, withdrawn in one step: from the queue; from pg's Pool, whose later answer goes back
		 * with its permit; or, when pg answered with a client the lease never took, that client back to pg's Pool and
		 * then its permit. A refused ask's permit is back already.
		 */
		const withdraw = (ask: Ask): void => {
			const state = ask.state
			switch (state._tag) {
				case "queued":
					unsettled.delete(ask)
					permits = withdrawn(permits, ask)
					return
				case "connecting":
					unsettled.delete(ask)
					state.attempt.waiter = nobody
					return
				case "connected":
					handed.delete(ask)
					state.client.release(false)
					owner.permitBack()
					return
				case "refused":
					return
			}
		}

		/**
		 * The pool's end (see makePool): pg's Pool ended, which gives each idle client its Terminate; the wire of every
		 * client no lease may still run on destroyed, one connecting, handed to a lease or leased, a ready one's through
		 * its session; every ask still unsettled refused with LayerReleased, the queue emptied with them; then the wait
		 * for every other session's close (closedAll), though the release runs uninterruptibly, so an interruption,
		 * the release's own or the one whose scope it closes, destroys every connection still open. A connecting ask's
		 * attempt answers nobody after: pg's later answer, if any comes, goes back to the ended pool with its permit.
		 */
		const end = (): Effect.Effect<void> => {
			native.end(terminated)
			const held = new Set<PgClient>([...leased, ...handed.values()])
			const closing: Array<Session> = []
			for (const [client, socket] of wires) {
				const session = sessions.get(client)
				if (session === undefined) {
					destroyWire(client, socket)
				} else if (held.has(client)) {
					session.destroy()
				} else {
					closing.push(session)
				}
			}
			permits = permits._tag === "waiting" ? exhausted : permits
			for (const ask of unsettled) {
				const state = ask.state
				if (state._tag === "connecting") {
					state.attempt.waiter = nobody
				}
				settle(ask, layerReleased())
			}
			return closedAll(closing)
		}
		yield* Effect.addFinalizer(() => Effect.suspend(end))

		/**
		 * `client` back to pg's Pool, which closes it when `close` holds, and then its permit: pg's Pool counts a closed
		 * client out at once, so the permit admits no lease before the pool has room for it.
		 */
		const giveBack = (client: PgPoolClient, close: boolean): void => {
			client.release(close)
			owner.permitBack()
		}

		/** The client pg handed to `ask` back, untaken by its lease, closed: the ask holds its permit no longer. */
		const untaken = (ask: Ask, client: PgPoolClient): Effect.Effect<void> =>
			Effect.sync(() => {
				handed.delete(ask)
				giveBack(client, true)
			})

		/**
		 * A lease's end: the client leaves the leased count and goes back to pg's Pool, which keeps it exactly when the
		 * session is open; a retired or ended one is released with an error, so pg's Pool closes it.
		 */
		const release = (client: PgPoolClient, session: Session): Effect.Effect<void> =>
			Effect.sync(() => {
				leased.delete(client)
				giveBack(client, session.state() !== "open")
			})

		/**
		 * One client as a session for the scope. A pooled client whose session is not open, its connection ended while it
		 * sat idle, is closed before anything runs on it and another leased in its place, while `replacements` remain:
		 * this is pool hygiene, never a retry, at most `bounds.max` times, so no flight is ever sent twice, and a
		 * connection attempt that fails is the acquisition's failure. A lease of a pool already ending is refused at once,
		 * before it asks for a permit.
		 *
		 * Only the wait for the ask to settle is interruptible, and it carries nothing and has no deadline: an interrupted
		 * lease withdraws its ask in one step, without interruption, so a client that arrived for it goes back with its
		 * permit, and a leased client is always released.
		 */
		const leaseWith = (replacements: number): Effect.Effect<Session, AcquireRefusal, Scope.Scope> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (native.ending) {
						return yield* new LayerReleased()
					}
					const context = yield* Effect.context()
					const asked = newAsk(context)
					const waited = yield* Effect.exit(restore(Deferred.await(asked.settled)))
					if (Exit.isFailure(waited)) {
						withdraw(asked)
						return yield* Effect.failCause(waited.cause)
					}
					const settled = waited.value
					if (settled._tag === "refused") {
						return yield* settled.failure
					}
					const client = settled.client
					const session = sessions.get(client)
					if (session === undefined) {
						yield* untaken(asked, client)
						return yield* new NoCancelKey()
					}
					if (session.state() !== "open" && replacements > 0) {
						yield* untaken(asked, client)
						return yield* restore(leaseWith(replacements - 1))
					}
					handed.delete(asked)
					leased.add(client)
					yield* Effect.addFinalizer(() => release(client, session))
					return session
				})
			)

		return {
			role: spec.role,
			native,
			lease: leaseWith(bounds.max),
			size: Effect.sync(() => native.totalCount),
			state: Effect.sync((): PoolState => ({
				free: permits._tag === "free" ? permits.count : 0,
				attempting: pending.size + handed.size,
				leased: leased.size,
				waiting: permits._tag === "waiting" ? permits.queue.length : 0
			}))
		}
	})
