/**
 * Sessions over pg, a hot path: every query of every flight is written, and every cell of every row it answers is
 * checked, here, in native loops with no Option or closure per row.
 */
import { isIP } from "node:net"
import { type ConnectionOptions, checkServerIdentity, connect as tlsConnect } from "node:tls"
import {
	Array as Arr,
	Brand,
	Cause,
	type Context,
	Data,
	Deferred,
	Duration,
	Effect,
	Exit,
	Formatter,
	pipe,
	Predicate,
	Redacted,
	Result,
	type Scope,
	String as Str
} from "effect"

import type { ParsedConnection, ParsedTransport } from "#adapter/connection/config.ts"
import type { SessionKind } from "#adapter/connection/environment.ts"
import {
	type AcquireRefusal,
	ConnectionClosed,
	type ConnectRefusal,
	ConnectTimedOut,
	CredentialError,
	DriverRefused,
	LayerReleased,
	NoCancelKey,
	SocketFailed,
	StartupRefused,
	TlsRefused
} from "#adapter/errors/failures.ts"
import type {
	PgArrayResult,
	PgClient,
	PgClientConfig,
	PgDriver,
	PgPool,
	PgPoolClient,
	PgSocket
} from "#adapter/types/driver.ts"
import type { ConnectionPool, PoolBounds } from "#adapter/types/layer.ts"
import type { BatchOutcome, SentText, Transaction } from "#adapter/wire/batch.ts"
import { type ServerAnswer, serverFailure } from "#adapter/wire/failure.ts"
import { releasingPool } from "#adapter/wire/releasing-pool.ts"
import { emptyNameMap, loginStartupOptions } from "#compiler/plan/catalog.ts"
import {
	type EmittedText,
	emitText,
	flightMaxBytes,
	nominal,
	type OutputRows,
	type Param,
	sha256Hex
} from "#compiler/plan/common.ts"

/**
 * Sessions: clients of the caller's node-postgres (DbConnection.driver, types/driver.ts PgDriver) in pipeline mode,
 * pooled by its own Pool. grizzle imports nothing of pg itself.
 *
 * This module is grizzle's only contact with pg, whose types expose `any` (rows, values, pool callbacks): every value
 * pg hands back is narrowed here, by its class (the driver's DatabaseError), by a type argument that pins rows to
 * unknown cells, or by a checked read of a field its types leave out (BackendKeyData, the parsed-statement map), so
 * batch.ts sees only grizzle's types.
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
 *   ConnectRefusal): the CredentialError, no answer within the connection's connect timeout, a socket error code, the
 *   server's refusal of the startup with its ErrorResponse as it gave it, TLS, a connection closed before it was ready,
 *   pg's own refusal, or no cancellation key.
 * - Startup. pg sends user and database, and a login's session its pinned defaults as `options`
 *   (physical/ddl/roles.ts loginStartupOptions), the very defaults its role stores, which Db.open's admission
 *   verifies; an owner's session sends none, starting under its role's and its database's defaults. grizzle never
 *   issues a session-level SET and names no session: an application_name is the environment's (connection/
 *   environment.ts). pg reads every setting it is given as a falsy value from the environment instead: the client config
 *   states each it can (clientConfig), and the startup variables it cannot (connection/environment.ts) are refused
 *   before any session opens, a login's by DbLayer.make, an owner's by the command line.
 * - Values. Every type parser is the identity and results are requested as text, so every cell is the text the server
 *   sent, and parameters are bound as untyped text. grizzle's own SQL never delivers NULL (absence is zero rows), so a
 *   result with a NULL cell is an unreadable answer: the statement ran, and its rows are none grizzle reads. Every row
 *   past this module is texts only.
 * - Statements. A statement runs as PostgreSQL's unnamed statement, parsed with each execution, unless it is one of the
 *   pool's server statements (ServerStatement): grizzle's fixed prologue, and the programs it compiled ahead and keeps
 *   for a stated lifetime. Each server statement has the pool's name for it, which a session parses on its first use and
 *   binds after (SessionStatements), and each runs as one role only, so its cached plan is never replanned for another.
 * - Cancellation. pg's JavaScript client has no supported cancel: Client#cancel is undocumented and writes the
 *   CancelRequest on a plaintext socket. A session sends one CancelRequest over a connection of its own, which the
 *   transport opens and upgrades as a session's, with the BackendKeyData pg read at startup, within the connect
 *   timeout (Session.cancel); an interrupted flight then destroys the session (wire/batch.ts).
 * - Pool. The driver's own Pool (releasing-pool.ts), handed once, when it is built, to the config's attachPool: a
 *   platform's hook for idle connections, which on Vercel is attachDatabasePool (its pg branch reads
 *   `options.idleTimeoutMillis` and subscribes to `release`), and nothing elsewhere. Its bounds are the caller's
 *   (DbConfig.pool): pg's Pool closes an idle client above the floor the idle timeout after its release, and keeps the
 *   floor open. It opens no session before a lease asks for one, so the floor is the sessions it keeps once opened,
 *   never sessions it opens ahead. The wait for a session is the lease's own: its ask takes one of the pool's `max`
 *   permits, or waits for one in order, before pg's Pool is asked for a client, and the permit is held until pg has
 *   that client back, so pg's Pool always has an idle client or room and never keeps a lease waiting for one, holding
 *   an ask only for the turn it takes to hand an idle client over. The lease waits, interruptibly and with no deadline
 *   of its own, only for its ask to settle: the caller's own timeout bounds it. A permit and a client move between the
 *   ask, pg's callback and the lease only in plain synchronous code, so no interruption at any step can drop one. A
 *   wait that is interrupted leaves nothing behind: a client that arrives for a lease abandoned while pg connected it
 *   goes back to the pool, and its permit with it. A lease of an ended pool is refused with LayerReleased, before pg is
 *   asked for a client. The sessions a release of server statements reaches are the open connections: a session joins
 *   them when its client is ready and leaves when its connection ends.
 * - State. A session is open, retired or ended (SessionState), and moves only as sessionTransitions says: retired on an
 *   interruption with a statement in flight, a failure batch.ts cannot account for, or a transaction it could not end;
 *   ended once its connection ends, lost, ended by the server, or destroyed. A session that is not open is released
 *   with an error, so pg's Pool closes it instead of keeping it, and is counted out of the pool before its permit admits
 *   another lease.
 * - Release. The pool ends when the scope it was built in closes (a DbLayer's): pg's Pool ends, writing a Terminate to
 *   each idle session, every socket of every client it constructed is destroyed at once, and every lease still waiting
 *   is refused with LayerReleased, whether queued for a permit or asking pg's Pool, which drops the asks it queued for
 *   an idle client when it ends and so would never answer them. Nothing is awaited, so a server or a transport that no
 *   longer answers cannot hold a release.
 *
 * The password of a connection: a Redacted, or an Effect evaluated for each connection attempt (passwordOf).
 */
export type Password = ParsedConnection["password"]

/**
 * No password, for a role the server authenticates without one (trust, peer, a client certificate): the empty text,
 * which pg's password function yields (passwordOf), so pg reads neither PGPASSWORD nor ~/.pgpass for it, as it would
 * for an empty text given as the password itself. A server that asks for a password refuses it.
 */
export const noPassword: Redacted.Redacted = Redacted.make("")

/**
 * Where one session connects and as whom: the parsed connection (connection/config.ts ParsedConnection), its driver,
 * transport, database, password and connect timeout, the login role, and whose session it is: a login's, every session
 * of a pool, or an owner's, one outside any pool.
 */
interface SessionSpec extends ParsedConnection {
	/** The login role. */
	readonly role: string
	readonly startup: SessionKind
}

/**
 * A server statement: a SQL text every session parses once, under the name its text determines, and binds after. It is
 * minted (serverStatement) for what grizzle runs from a fixed list, a Db's prologue and the programs it compiled ahead,
 * each run as one role only; whoever minted it releases it (SessionPool.release), which closes it on every session that
 * parsed it. serverStatement is its one mint, so a name never stands beside another text: pg refuses to send a statement
 * under a name it parsed for another text, with a plain Error, and still sends the rest of its pipeline, COMMIT
 * included, which would commit the transaction without that statement.
 */
export type ServerStatement = {
	readonly name: string
	readonly sql: EmittedText
} & Brand.Brand<"ServerStatement">
const mintServerStatement = Brand.nominal<ServerStatement>()

/**
 * The hex digits of a server statement's name after `grizzle_`: the leading ones of its text's SHA-256, 160 bits, so
 * over n distinct texts two share a name with probability at most n(n - 1) / 2 / 2^160.
 *
 * @formatConstant a server statement's name: grizzle_ and 40 lowercase hex digits
 */
const statementDigestHex = 40

/** What every server statement's name begins with. */
const statementNamePrefix = "grizzle_"

/**
 * The bytes of every server statement's name, the one length a name a statement runs under has beside the unnamed
 * statement's empty one: its prefix and its digits, all ASCII.
 */
export const serverStatementNameBytes = statementNamePrefix.length + statementDigestHex

/**
 * The server statement of `sql`, named `grizzle_` and the first statementDigestHex hex digits of the text's SHA-256: one
 * name for one text on every session, whichever pool's Db minted it. Two programs of one text share the name;
 * releasing one closes it on every session that parsed it, and each session's parsed set, not the program, decides that
 * the other parses it again at its next use (SessionStatements.release).
 */
export const serverStatement = (sql: EmittedText): ServerStatement =>
	mintServerStatement({
		name: `${statementNamePrefix}${pipe(sha256Hex(sql), Str.slice(0, statementDigestHex))}`,
		sql
	})

/**
 * The name one execution of a statement runs under: none, PostgreSQL's unnamed statement; a server statement's name
 * this execution parses; or one an earlier execution on the session parsed, which this one binds.
 */
export type StatementName =
	| { readonly _tag: "unnamed" }
	| { readonly _tag: "parsing"; readonly name: string }
	| { readonly _tag: "parsed"; readonly name: string }

export const unnamed: StatementName = { _tag: "unnamed" }

/**
 * One flight's view of its session's statements while it is built: the names to close in front of it, and the name each
 * server statement runs under, as the session's parsed names and the flight's own earlier statements decide. A draft
 * changes nothing of the session; the session adopts it once its flight is written (SessionStatements.adopt), so a
 * flight refused before it is written leaves the session as it was.
 */
export class StatementsDraft {
	readonly #parsed: ReadonlySet<string>
	readonly #parsing = new Set<string>()
	/** The names the flight closes in front of its queries. */
	readonly closes: ReadonlyArray<string>

	constructor(parsed: ReadonlySet<string>, closing: ReadonlyArray<string>) {
		this.#parsed = parsed
		this.closes = closing.slice()
	}

	/** The name `statement` runs under in this execution: parsed now, on its first use, or bound to its earlier Parse. */
	name(statement: ServerStatement): StatementName {
		if (this.#parsed.has(statement.name) || this.#parsing.has(statement.name)) {
			return { _tag: "parsed", name: statement.name }
		}
		this.#parsing.add(statement.name)
		return { _tag: "parsing", name: statement.name }
	}

	/** The names the flight parses. */
	get parsing(): ReadonlySet<string> {
		return this.#parsing
	}
}

/**
 * The server statements one session has parsed, by name, and the names to close in front of its next batch.
 *
 * A name whose Parse may not have run (the server skips every statement after a refused one), or that the server no
 * longer honors (26000, or 0A000 for a cached plan whose result type changed), is forgotten: closed in front of the next
 * batch, and parsed afresh at its next use. So is every name of a server statement its owner released. Closing a name
 * the server never parsed is no error.
 *
 * A flight is built over a draft (StatementsDraft) and adopted in the same synchronous step that writes it, so nothing
 * changes the session's names between the two: the names to close only grow until a flight adopts the ones it closed.
 */
export class SessionStatements {
	readonly #parsed = new Set<string>()
	#closing: Array<string> = []

	/** A draft of the next flight over these statements. */
	draft(): StatementsDraft {
		return new StatementsDraft(this.#parsed, this.#closing)
	}

	/** `draft`'s flight is written: the names it closed are closed, and the names it parses are parsed. */
	adopt(draft: StatementsDraft): void {
		this.#closing = this.#closing.slice(draft.closes.length)
		for (const name of draft.parsing) {
			this.#parsed.add(name)
		}
	}

	/** Forgets `name`: closed in front of the next batch, and parsed again at its next use. */
	forget(name: string): void {
		this.#parsed.delete(name)
		this.#closing.push(name)
	}

	/**
	 * Forgets each of `statements` this session parsed: their owner released them. A name another live program still
	 * runs (two programs of one text share it) is forgotten too, so that program's next use here parses it afresh behind
	 * the Close: this set, not the program, decides whether a name is bound or parsed.
	 */
	release(statements: ReadonlyArray<ServerStatement>): void {
		for (const statement of statements) {
			if (this.#parsed.delete(statement.name)) {
				this.#closing.push(statement.name)
			}
		}
	}
}

/**
 * A transaction control of a pipeline: BEGIN, read-only or not, or the transaction's end, COMMIT or ROLLBACK. Whoever
 * reads a pipeline reads which control it is from here, never from its text.
 */
export type TxControl =
	| { readonly kind: "begin"; readonly access: Transaction["access"] }
	| { readonly kind: "end"; readonly end: Transaction["end"] }

/** The text each BEGIN sends, printed from its statement. */
const beginText: { readonly [A in Transaction["access"]]: EmittedText } = {
	readOnly: emitText({ kind: "begin", readOnly: true }, emptyNameMap).text,
	readWrite: emitText({ kind: "begin", readOnly: false }, emptyNameMap).text
}

/** The text each end sends, printed from its statement. */
const endText: { readonly [E in Transaction["end"]]: EmittedText } = {
	COMMIT: emitText({ kind: "commit" }, emptyNameMap).text,
	ROLLBACK: emitText({ kind: "rollback" }, emptyNameMap).text
}

/** The text a control sends. */
export const controlText = (control: TxControl): EmittedText =>
	control.kind === "begin" ? beginText[control.access] : endText[control.end]

/**
 * One query of a pipeline: a statement, on the extended protocol with its own Sync, or a transaction control, a simple
 * Query message.
 */
export type WireQuery =
	| {
			readonly _tag: "statement"
			readonly sql: SentText
			readonly params: ReadonlyArray<Param>
			/** The session's name for the statement in this execution. */
			readonly name: StatementName
	  }
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

/**
 * pg remembers every name it parsed on a connection, to skip the Parse when the name is bound again, in a map its
 * types leave out. A closed name is never bound again, so it leaves the map with its Close.
 */
const forgetParsed = (client: PgClient, name: string): void => {
	const parsed: unknown = Reflect.get(client.connection, "parsedStatements")
	if (Predicate.isObjectKeyword(parsed)) {
		Reflect.deleteProperty(parsed, name)
	}
}

/** A result's rows whose every cell arrived as text: PostgreSQL's output texts, minted here, where they arrive. */
const outputRows = nominal<ReadonlyArray<ReadonlyArray<string>>, OutputRows>()

/** Rows every cell of which arrived as text: a native loop over every cell of the result. */
const isTextRows = (
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): rows is ReadonlyArray<ReadonlyArray<string>> => {
	for (const row of rows) {
		for (const cell of row) {
			if (typeof cell !== "string") {
				return false
			}
		}
	}
	return true
}

/**
 * The answer of one query, from pg's callback. pg passes its DatabaseError for an ErrorResponse, its own Error for a
 * failed connection or a query it would not send, and null and the result otherwise. Every type parser is the
 * identity, so a result cell is the text the server sent; a result with a NULL, or a cell that is no text, is
 * unreadable.
 */
const answerOf = (driver: PgDriver, error: unknown, result: PgArrayResult | undefined): Answer => {
	if (error instanceof driver.DatabaseError) {
		return serverFailure(error) ?? { _tag: "failed" }
	}
	if (error !== null && error !== undefined) {
		return { _tag: "failed" }
	}
	if (result === undefined) {
		return { _tag: "failed" }
	}
	const rows = result.rows
	if (!isTextRows(rows)) {
		return { _tag: "unreadable", command: result.command }
	}
	return { _tag: "result", outcome: { command: result.command, rows: outputRows(rows) } }
}

/** The identity of every type: each cell stays the text the server sent. */
const rawText = { getTypeParser: () => (text: string) => text } as const

/**
 * verify-full against the CA bundle and `servername`. The identity check names the server explicitly, so it holds
 * whatever pg sets as the SNI; the SNI is never an IP address. The bundle is a nonempty list of PEM texts, handed to TLS
 * as a list: Node trusts its own root certificates only in place of a `ca` that is falsy, never in place of a list, so
 * no bundle ever lets a public authority's certificate verify.
 */
const verifyFull = (transport: ParsedTransport): ConnectionOptions => {
	const servername = transport.servername
	return {
		ca: [...transport.ca],
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
 * The failures pg reports only by their message, as the pinned pg spells them: its connect timeout, which is the
 * connection's own (DbConnection.connectTimeoutMs), the server's answer to the SSLRequest (N, or neither S nor N), and
 * a connection that ended before ReadyForQuery with no ErrorResponse.
 */
const messageRefusals: ReadonlyMap<string, (spec: SessionSpec) => ConnectRefusal> = new Map<
	string,
	(spec: SessionSpec) => ConnectRefusal
>([
	["timeout expired", (spec) => new ConnectTimedOut({ millis: spec.connectTimeoutMs })],
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
 * The services a client's password Effect runs under: `current`, else its pool's or its caller's (`own`).
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
 * negotiation among them, so `PGCLIENT_ENCODING` and `PGSSLNEGOTIATION` reach no session, and a login's session its
 * options, so `PGOPTIONS` reaches none of a login's; the startup variables it cannot be told are
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
	...(spec.startup === "login" ? { options: loginStartupOptions } : {}),
	pipeline: true,
	types: rawText,
	connectionTimeoutMillis: spec.connectTimeoutMs,
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
 * One CancelRequest for whatever statement the session's backend is running, over a connection of its own: a socket
 * the transport opens, connected to its host and port, then the SSLRequest and verify-full TLS exactly as a session's
 * (sessionTls). It ends when the server closes that connection, or when it fails, or once the connection's connect
 * timeout has passed on the Clock, in which case the request may not have arrived; either way its sockets are
 * destroyed.
 */
const cancelRequest = (spec: SessionSpec, key: BackendKey): Effect.Effect<void> =>
	Effect.timeoutOrElse(
		Effect.callback<void>((resume) => {
			const transport = spec.transport
			const raw = transport.open()
			const sockets: Array<{ readonly destroy: () => unknown }> = [raw]
			let finished = false
			const finish = (): void => {
				if (finished) {
					return
				}
				finished = true
				for (const socket of sockets) {
					socket.destroy()
				}
				resume(Effect.void)
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
				secure.once("secureConnect", () => secure.write(cancelFrame(key)))
			})
			raw.setNoDelay(true)
			raw.connect(transport.port, transport.host)
			return Effect.sync(finish)
		}),
		{ duration: Duration.millis(spec.connectTimeoutMs), orElse: () => Effect.void }
	)

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

/** One connected client in pipeline mode, with what grizzle keeps beside it. */
export interface Session {
	/** The login role the session logged in as, which its statements run as unless a prologue enters another. */
	readonly role: string
	readonly statements: SessionStatements
	/**
	 * One CancelRequest for the statement the backend is running, within the connection's connect timeout: it never
	 * waits on the statement it cancels.
	 */
	readonly cancel: Effect.Effect<void>
	/** Where the session stands now (SessionState). */
	readonly state: () => SessionState
	/** Never reuse the session: it is retired, or stays ended. */
	readonly retire: () => void
	/**
	 * Ends the connection at once, failing whatever it was waiting for: its sockets are destroyed, nothing is awaited,
	 * and the session is ended from this call on.
	 */
	readonly destroy: () => void
	/**
	 * The most bytes one write of the session's connection carries, and so one flight (core/limits.ts flightMaxBytes):
	 * the flight's builder refuses a longer flight before any byte of it is written (wire/batch.ts send).
	 */
	readonly flightMaxBytes: number
	/**
	 * Writes `pipeline` in one corked write, behind a Close for each of `closes`, and reports each query's answer by its
	 * index, then the pipeline's end: the ReadyForQuery after its last query, or the connection's end once every query
	 * has failed. Its bytes, as pg writes them, are within flightMaxBytes. `onCut` reports, before any query fails for it,
	 * a write that failed while its stream stood: the end of the pipeline's last message never left the process
	 * (flightEnd).
	 */
	readonly send: (
		closes: ReadonlyArray<string>,
		pipeline: ReadonlyArray<WireQuery>,
		onAnswer: (index: number, answer: Answer) => void,
		onEnd: () => void,
		onCut: () => void
	) => void
}

/**
 * A statement on the extended protocol, named or unnamed. pg sends a query without parameters or a name as a simple
 * Query message, which accepts several statements in one text, unless its `queryMode` is "extended", which pg's types
 * leave out. pg refuses a query before its bytes go out only for what this never builds: no text, parameters that are no
 * array or that its value mapper throws on (every parameter is a string, or a Uint8Array it sends in binary, a view of
 * the same bytes), or a name it parsed for another text (a
 * server statement's name is its text's, serverStatement). So a pipeline is written whole: no statement is skipped while
 * the ones after it, COMMIT included, are sent.
 */
const statementQuery = (query: Extract<WireQuery, { readonly _tag: "statement" }>) =>
	query.name._tag === "unnamed"
		? {
				text: query.sql,
				values: query.params.slice(),
				rowMode: "array" as const,
				queryMode: "extended" as const
			}
		: {
				text: query.sql,
				values: query.params.slice(),
				rowMode: "array" as const,
				queryMode: "extended" as const,
				name: query.name.name
			}

const controlQuery = (sql: EmittedText) => ({ text: sql, rowMode: "array" as const })

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

/** The whole flight is written corked and flushed at once; the stream is uncorked whatever the writes threw. */
const makeSession = (
	client: PgClient,
	socket: PgSocket,
	spec: SessionSpec,
	key: BackendKey
): Session => {
	const statements = new SessionStatements()
	let state: SessionState = "open"
	const move = (event: SessionEvent): void => {
		state = sessionTransitions[state][event]
	}
	const end = (): void => {
		move("end")
	}
	client.on("error", end)
	client.on("end", end)
	const send: Session["send"] = (closes, pipeline, onAnswer, onEnd, onCut) => {
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
			for (const name of closes) {
				connection.close({ type: "S", name }, false)
				forgetParsed(client, name)
			}
			let next = 0
			for (const query of pipeline) {
				const index = next
				next += 1
				const answer = (error: unknown, result: PgArrayResult | undefined): void => {
					onAnswer(index, answerOf(spec.driver, error, result))
					answered += 1
					settle()
				}
				if (query._tag === "control") {
					client.query<Array<unknown>, Array<string>>(
						controlQuery(controlText(query.control)),
						answer
					)
				} else {
					client.query<Array<unknown>, Array<Param>>(statementQuery(query), answer)
				}
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
		statements,
		flightMaxBytes: flightMaxBytes.value,
		cancel: cancelRequest(spec, key),
		state: () => state,
		retire: () => {
			move("retire")
		},
		destroy: () => {
			destroyWire(client, socket)
			move("end")
		},
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
 * the connection's connect timeout, and the wait stays the lease's. Each client opens its socket through the transport
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
const ended = (): void => undefined

/**
 * One session outside any pool (the migration owner's), an owner's, closed with the scope: its Terminate is written and
 * its sockets destroyed at once, nothing awaited, and the session is ended from then on. The attempt is interruptible.
 */
export const connectSession = (
	given: Omit<SessionSpec, "startup">
): Effect.Effect<Session, ConnectRefusal, Scope.Scope> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const spec: SessionSpec = { ...given, startup: "owner" }
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
			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					client.end(ended)
					session.destroy()
				})
			)
			return session
		})
	)

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
 * What pg's answer to an attempt reaches in the pool that made it (makePool): the way a permit goes back, and the one
 * settling of an ask, its state and its `settled` together.
 */
interface AttemptOwner {
	readonly permitBack: () => void
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
		const waiter = attempt.waiter
		attempt.waiter = nobody
		if (waiter._tag === "nobody") {
			client?.release(false)
			owner.permitBack()
			return
		}
		if (client !== undefined) {
			owner.settle(waiter.ask, { _tag: "connected", client })
			return
		}
		owner.settle(waiter.ask, {
			_tag: "refused",
			failure: attemptFailed(spec, handshakes, error)
		})
		owner.permitBack()
	}

interface PoolConfig {
	/** The driver, the transport, the database, the derived login role, the password and the connect timeout. */
	readonly connection: Omit<SessionSpec, "startup">
	/** The pool's bounds (DbConfig.pool). */
	readonly bounds: PoolBounds
	/** The platform's hook, handed pg's Pool once, when it is built (DbConfig.attachPool). */
	readonly attachPool: (pool: ConnectionPool) => void
}

export interface SessionPool {
	readonly role: string
	/** pg's Pool, attached to the platform's pool integration when it was built, holding the pool's bounds. */
	readonly native: PgPool
	/** A session for the scope. */
	readonly lease: Effect.Effect<Session, AcquireRefusal, Scope.Scope>
	/** Open connections: leased, idle, or still being established. */
	readonly size: Effect.Effect<number>
	/** The sessions handed to a lease and not yet released; a connection still being established is none. */
	readonly leased: Effect.Effect<number>
	/** The sessions a release reaches: one for each connection pg's Pool connected that has not ended. */
	readonly live: Effect.Effect<number>
	/** Closes each of `statements` on every session that parsed it, in front of that session's next batch. */
	readonly release: (statements: ReadonlyArray<ServerStatement>) => void
}

/**
 * Builds the pool in the current scope; it ends when that scope closes. A pool is a login's: each of its sessions
 * starts under the login's pinned defaults (SessionSpec startup).
 *
 * pg's Pool is handed once, as it is built, to the platform's hook (Vercel's attachDatabasePool reads the idle timeout
 * and subscribes to release), whose throw is a defect of the caller's hook; the function's deadline never becomes a
 * statement or lock timeout. pg's Pool reports an idle client that failed after it has closed and dropped it, so its
 * `error` event wants nothing. The lease's services hold only while pg constructs and starts connecting a client inside
 * `connect`, and that client keeps them only until its connection is set up.
 *
 * Its end, when the scope closes: pg's Pool ends, which writes a Terminate to each idle client and refuses every later
 * ask; the sockets of every client constructed and not yet ended are destroyed, leased, idle or connecting alike; and
 * every ask still unsettled is refused with LayerReleased. Nothing is awaited.
 */
export const makePool = (config: PoolConfig): Effect.Effect<SessionPool, never, Scope.Scope> =>
	Effect.gen(function* () {
		const { bounds } = config
		const spec: SessionSpec = { ...config.connection, startup: "login" }
		const own = yield* Effect.context()
		const attemptServices: AttemptServices = { current: own, own }
		/**
		 * The session of each client pg's Pool connected, made when its client is ready, before anyone holds the
		 * client, and kept beside it; a client with none had no BackendKeyData. `live` holds each session from then
		 * until its connection ends, so it holds exactly the open ones, and an ended session goes with its client.
		 * `wires` holds every client constructed, with the socket the transport opened for it, until it ends: what the
		 * pool's end destroys.
		 */
		const sessions = new WeakMap<PgClient, Session>()
		const live = new Set<Session>()
		const wires = new Map<PgClient, PgSocket>()
		const handshakes: Handshakes = new WeakSet()
		const ReleasingPool = releasingPool(spec.driver.Pool)
		const native = new ReleasingPool({
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
					live.add(session)
					client.once("end", () => {
						live.delete(session)
					})
				}
			}),
			min: bounds.min,
			max: bounds.max,
			idleTimeoutMillis: bounds.idleTimeoutMs
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
		let leased = 0
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
			attemptServices.current = ask.services
			const started = Result.try(() => {
				native.connect(answerAttempt(spec, handshakes, attempt, owner))
			})
			attemptServices.current = own
			if (Result.isSuccess(started)) {
				return true
			}
			attempt.waiter = nobody
			settle(ask, { _tag: "refused", failure: Effect.die(started.failure) })
			return false
		}

		/**
		 * What pg's answers reach in this pool: the one settling of an ask, and a permit back, to the first ask waiting
		 * that pg's Pool takes it for, whose attempt's answer reaches this owner in turn, else free.
		 */
		const owner: AttemptOwner = {
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
					state.client.release(false)
					owner.permitBack()
					return
				case "refused":
					return
			}
		}

		/**
		 * The pool's end: pg's Pool ended; every wire destroyed, a ready client's through its session, which is ended from
		 * then on; and every ask still unsettled refused with LayerReleased, the queue emptied with them. A connecting
		 * ask's attempt answers nobody after: pg's later answer, if any comes, goes back to the ended pool with its permit.
		 */
		const end = (): void => {
			native.end(ended)
			for (const [client, socket] of wires) {
				const session = sessions.get(client)
				if (session === undefined) {
					destroyWire(client, socket)
				} else {
					session.destroy()
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
		}
		yield* Effect.addFinalizer(() => Effect.sync(end))
		yield* Effect.sync(() => {
			config.attachPool(native)
		})

		/**
		 * `client` back to pg's Pool, which closes it when `close` holds, and then its permit: pg's Pool counts a closed
		 * client out at once, so the permit admits no lease before the pool has room for it.
		 */
		const giveBack = (client: PgPoolClient, close: boolean): Effect.Effect<void> =>
			Effect.sync(() => {
				client.release(close)
				owner.permitBack()
			})

		/**
		 * A lease's end: the client leaves the leased count and goes back to pg's Pool, which keeps it exactly when the
		 * session is open; a retired or ended one is released with an error, so pg's Pool closes it.
		 */
		const release = (client: PgPoolClient, session: Session): Effect.Effect<void> =>
			Effect.suspend(() => {
				leased -= 1
				return giveBack(client, session.state() !== "open")
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
						yield* giveBack(client, true)
						return yield* new NoCancelKey()
					}
					if (session.state() !== "open" && replacements > 0) {
						yield* giveBack(client, true)
						return yield* restore(leaseWith(replacements - 1))
					}
					leased += 1
					yield* Effect.addFinalizer(() => release(client, session))
					return session
				})
			)

		return {
			role: spec.role,
			native,
			lease: leaseWith(bounds.max),
			size: Effect.sync(() => native.totalCount),
			leased: Effect.sync(() => leased),
			live: Effect.sync(() => live.size),
			release: (statements) => {
				for (const session of live) {
					session.statements.release(statements)
				}
			}
		}
	})
