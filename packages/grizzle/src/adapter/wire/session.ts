/**
 * Sessions over pg, a hot path: every query of every flight is written, and every cell of every row it answers is
 * checked, here, in native loops with no Option or closure per row.
 */
import { isIP, connect as netConnect } from "node:net"
import { type ConnectionOptions, checkServerIdentity, connect as tlsConnect } from "node:tls"
import {
	Array as Arr,
	Brand,
	Cause,
	Clock,
	type Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Formatter,
	pipe,
	Predicate,
	Redacted,
	Result,
	Schema,
	type Scope,
	String as Str
} from "effect"

import {
	Client,
	type ClientConfig,
	DatabaseError,
	Pool,
	type PoolClient,
	type QueryArrayResult
} from "pg"

import {
	type AcquireRefusal,
	AcquisitionBudgetExceeded,
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
import { type AcquisitionBudgets, connectBudgetMs } from "#adapter/pool/budgets.ts"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import type { BatchOutcome, Transaction } from "#adapter/wire/batch.ts"
import { type ServerAnswer, serverFailure } from "#adapter/wire/failure.ts"
import { sha256Hex } from "#compiler/core/sha256.ts"

/**
 * Sessions: node-postgres clients (pg 8.23) in pipeline mode, pooled by pg's own Pool.
 *
 * This module is grizzle's only contact with pg, whose types expose `any` (rows, values, pool callbacks): every value
 * pg hands back is narrowed here, by its class (DatabaseError), by a type argument that pins rows to unknown cells, or
 * by a checked read of a field its types leave out (BackendKeyData, the parsed-statement map), so batch.ts sees only
 * grizzle's types.
 *
 * - Transport. TLS is always verify-full: the certificate must chain to the CA bundle and name `servername`, which the
 *   connection's configuration gives as `host` when it names none (connection/config.ts), and an empty bundle is
 *   refused before connecting. pg replaces the `servername` it gives TLS with
 *   the host whenever the host is a name, so the name is verified by the identity check itself, and the SNI a server
 *   sees is the host. A server that answers the SSLRequest with N is refused: pg has no fallback to plaintext. The
 *   `stream` transport hands pg a stream that is already secured instead, and every CancelRequest opens another one
 *   (the protocol tap, test/support/wire-tap.ts).
 * - Password. A Redacted, or an Effect evaluated once per connection attempt, under the services of the lease it is
 *   opened for: pg calls the password function of each new client when the server asks for it. A client holds those
 *   services only until its connection is set up, so one the server never asked for a password keeps no lease's
 *   context. Its CredentialError fails the attempt at the stage credential, as the failure's reason; a defect or an
 *   interruption of the Effect is the operation's defect.
 * - Failure. A connection attempt that fails is classified once, here, from what pg reports (failures.ts
 *   ConnectRefusal): the CredentialError, no answer within the connect budget, a socket error code, the server's
 *   refusal of the startup with its ErrorResponse as it gave it, TLS, a connection closed before it was ready, pg's own
 *   refusal, or no cancellation key.
 * - Startup. pg sends user, database and application_name. Session settings are never sent: the fixed context is the
 *   login's role defaults, which Db.open's admission verifies, and grizzle never issues a session-level SET. pg
 *   also reads PGOPTIONS from the environment and sends it as `options`; no config value turns that off, since pg
 *   treats an empty value as unset.
 * - Values. Every type parser is the identity and results are requested as text, so every cell is the text the server
 *   sent, and parameters are bound as untyped text. grizzle's own SQL never delivers NULL (absence is zero rows), so a
 *   result with a NULL cell is an unreadable answer: the statement ran, and its rows are none grizzle reads. Every row
 *   past this module is texts only.
 * - Statements. A statement runs as PostgreSQL's unnamed statement, parsed with each execution, unless it is one of the
 *   pool's server statements (ServerStatement): grizzle's fixed prologue, and the programs it compiled ahead and keeps
 *   for a stated lifetime. Each server statement has the pool's name for it, which a session parses on its first use and
 *   binds after (SessionStatements), and each runs as one role only, so its cached plan is never replanned for another.
 * - Cancellation. pg's JavaScript client has no supported cancel: Client#cancel is undocumented and writes the
 *   CancelRequest on a plaintext socket. A session cancels over a connection of its own, through the same TLS
 *   settings, with the BackendKeyData pg read at startup.
 * - Pool. pg's own Pool, handed once, when it is built, to the config's attachPool: a platform's hook for idle
 *   connections, which on Vercel is attachDatabasePool (its pg branch reads `options.idleTimeoutMillis` and subscribes
 *   to `release`), and nothing elsewhere. Its floor is one session
 *   (core/policy.ts poolBounds): pg's Pool closes an idle client above the floor the idle timeout after its release,
 *   and keeps the floor open. It opens the floor on the first lease, not when it is built. The wait for a session is the
 *   lease's own: its ask takes one of the pool's `max` permits, or waits for one in order, before pg's Pool is asked for
 *   a client, and the permit is held until pg has that client back, so pg's Pool always has an idle client or room and
 *   never queues a lease. The lease waits, interruptibly and within the acquisition wait budget (../pool/budgets.ts),
 *   only for its ask to settle; a permit and a client move between the ask, pg's callback and the lease only in plain
 *   synchronous code, so no interruption at any step can drop one. A wait that is interrupted or runs out of budget
 *   leaves nothing behind: a client that arrives for a lease abandoned while pg connected it goes back to the pool, and
 *   its permit with it. The pool ends when the scope it was built in closes (a DbLayer's), and a lease of an ended pool
 *   is refused with LayerReleased, before pg is asked for a client. The sessions a release reaches are the open
 *   connections: a session joins them when pg's Pool connects its client and leaves when its connection ends.
 * - Retirement. A session is retired on an interruption with a statement in flight, a lost connection, a failure
 *   batch.ts cannot account for, or a transaction it could not end; a retired session is released with an error, so
 *   pg's Pool closes it instead of keeping it.
 *
 * PEM certificates, and the name the certificate must carry: the host, or the name a tunnel's server is known by. A
 * DbConfig and a migration connection are parsed into it once, where they are given (connection/config.ts).
 */
export interface TlsConfig {
	readonly ca: string | ReadonlyArray<string>
	readonly servername: string
}

export type Password = Redacted.Redacted | Effect.Effect<Redacted.Redacted, CredentialError>

/**
 * No password, for a role the server authenticates without one (trust, peer, a client certificate). pg spells it as the
 * empty password, which also keeps it from reading PGPASSWORD or ~/.pgpass, and a server that asks for a password
 * refuses it.
 */
export const noPassword: Redacted.Redacted = Redacted.make("")

/** Node's x509 verification codes (node:tls, "X509 certificate error codes"), plus its own TLS error namespaces. */
const certificateCodes: ReadonlySet<string> = new Set([
	"UNABLE_TO_GET_ISSUER_CERT",
	"UNABLE_TO_GET_CRL",
	"UNABLE_TO_DECRYPT_CERT_SIGNATURE",
	"UNABLE_TO_DECRYPT_CRL_SIGNATURE",
	"UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
	"CERT_SIGNATURE_FAILURE",
	"CRL_SIGNATURE_FAILURE",
	"CERT_NOT_YET_VALID",
	"CERT_HAS_EXPIRED",
	"CRL_NOT_YET_VALID",
	"CRL_HAS_EXPIRED",
	"ERROR_IN_CERT_NOT_BEFORE_FIELD",
	"ERROR_IN_CERT_NOT_AFTER_FIELD",
	"ERROR_IN_CRL_LAST_UPDATE_FIELD",
	"ERROR_IN_CRL_NEXT_UPDATE_FIELD",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"CERT_CHAIN_TOO_LONG",
	"CERT_REVOKED",
	"INVALID_CA",
	"PATH_LENGTH_EXCEEDED",
	"INVALID_PURPOSE",
	"CERT_UNTRUSTED",
	"CERT_REJECTED",
	"HOSTNAME_MISMATCH"
])

export const isTlsCode = (code: unknown): boolean =>
	Predicate.isString(code) &&
	(certificateCodes.has(code) ||
		Str.startsWith("ERR_TLS_")(code) ||
		Str.startsWith("ERR_SSL_")(code))

/** The duplex stream pg runs a connection over, as pg's own configuration types it. */
type WireStream = NonNullable<ReturnType<NonNullable<ClientConfig["stream"]>>>

/** How a session reaches the server: pg negotiating verify-full TLS itself, or a stream that is already secured. */
export type Transport =
	| { readonly _tag: "tls"; readonly tls: TlsConfig }
	| { readonly _tag: "stream"; readonly open: () => WireStream }

interface SessionSpec {
	readonly host: string
	readonly port: number
	readonly database: string
	/** The login role. */
	readonly role: string
	readonly password: Password
	readonly transport: Transport
	readonly applicationName: string
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
	readonly sql: string
} & Brand.Brand<"ServerStatement">
const mintServerStatement = Brand.nominal<ServerStatement>()

/**
 * The server statement of `sql`, named `grizzle_` and the first 40 hex digits of the text's SHA-256: one name for one
 * text on every session, whichever pool's Db minted it. Two programs of one text share the name; releasing one closes it
 * on every session that parsed it, and each session's parsed set, not the program, decides that the other parses it
 * again at its next use (SessionStatements.release).
 */
export const serverStatement = (sql: string): ServerStatement =>
	mintServerStatement({ name: `grizzle_${pipe(sha256Hex(sql), Str.slice(0, 40))}`, sql })

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
 * The server statements one session has parsed, by name, and the names to close in front of its next batch.
 *
 * A name whose Parse may not have run (the server skips every statement after a refused one), or that the server no
 * longer honors (26000, or 0A000 for a cached plan whose result type changed), is forgotten: closed in front of the next
 * batch, and parsed afresh at its next use. So is every name of a server statement its owner released. Closing a name
 * the server never parsed is no error.
 */
export class SessionStatements {
	readonly #parsed = new Set<string>()
	#closing: Array<string> = []

	/** The name `statement` runs under in this execution: parsed now, on its first use, or bound to its earlier Parse. */
	name(statement: ServerStatement): StatementName {
		if (this.#parsed.has(statement.name)) {
			return { _tag: "parsed", name: statement.name }
		}
		this.#parsed.add(statement.name)
		return { _tag: "parsing", name: statement.name }
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

	/** The names to close in front of the next batch. */
	takeClosing(): ReadonlyArray<string> {
		const closing = this.#closing
		this.#closing = []
		return closing
	}
}

/**
 * A transaction control of a pipeline: BEGIN, read-only or not, or the transaction's end, COMMIT or ROLLBACK. Whoever
 * reads a pipeline reads which control it is from here, never from its text.
 */
export type TxControl =
	| { readonly kind: "begin"; readonly access: Transaction["access"] }
	| { readonly kind: "end"; readonly end: Transaction["end"] }

/** The text each BEGIN sends. */
const beginText: { readonly [A in Transaction["access"]]: string } = {
	readOnly: "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY",
	readWrite: "BEGIN ISOLATION LEVEL SERIALIZABLE"
}

/** The text a control sends. */
export const controlText = (control: TxControl): string =>
	control.kind === "begin" ? beginText[control.access] : control.end

/**
 * One query of a pipeline: a statement, on the extended protocol with its own Sync, or a transaction control, a simple
 * Query message.
 */
export type WireQuery =
	| {
			readonly _tag: "statement"
			readonly sql: string
			readonly params: ReadonlyArray<string>
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
const backendKeyOf = (client: Client): BackendKey | undefined => {
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
const forgetParsed = (client: Client, name: string): void => {
	const parsed: unknown = Reflect.get(client.connection, "parsedStatements")
	if (Predicate.isObjectKeyword(parsed)) {
		Reflect.deleteProperty(parsed, name)
	}
}

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
 * The answer of one query, from pg's callback. pg passes a DatabaseError for an ErrorResponse, its own Error for a
 * failed connection or a query it would not send, and null and the result otherwise. Every type parser is the
 * identity, so a result cell is the text the server sent; a result with a NULL, or a cell that is no text, is
 * unreadable.
 */
const answerOf = (error: unknown, result: QueryArrayResult<Array<unknown>> | undefined): Answer => {
	if (error instanceof DatabaseError) {
		return serverFailure(error) ?? { _tag: "failed" }
	}
	if (error !== null && error !== undefined) {
		return { _tag: "failed" }
	}
	if (result === undefined) {
		return { _tag: "failed" }
	}
	const rows: ReadonlyArray<ReadonlyArray<unknown>> = result.rows
	if (!isTextRows(rows)) {
		return { _tag: "unreadable", command: result.command }
	}
	return { _tag: "result", outcome: { command: result.command, rows } }
}

/** The identity of every type: each cell stays the text the server sent. */
const rawText = { getTypeParser: () => (text: string) => text } as const

const caCount = (tls: TlsConfig): number =>
	Predicate.isString(tls.ca) ? (Str.trim(tls.ca) === "" ? 0 : 1) : tls.ca.length

/**
 * verify-full against the CA bundle and `servername`. The identity check names the server explicitly, so it holds
 * whatever pg sets as the SNI; the SNI is never an IP address.
 */
const verifyFull = (tls: TlsConfig): ConnectionOptions => {
	const servername = tls.servername
	return {
		ca: Predicate.isString(tls.ca) ? tls.ca : [...tls.ca],
		rejectUnauthorized: true,
		...(isIP(servername) === 0 ? { servername } : {}),
		checkServerIdentity: (...[, certificate]) => checkServerIdentity(servername, certificate)
	}
}

/**
 * The failures pg reports only by their message, as the pinned pg spells them: its connect timeout, the server's
 * answer to the SSLRequest (N, or neither S nor N), and a connection that ended before ReadyForQuery with no
 * ErrorResponse.
 */
const messageRefusals: ReadonlyMap<string, () => ConnectRefusal> = new Map<
	string,
	() => ConnectRefusal
>([
	["timeout expired", () => ConnectTimedOut.make({ millis: connectBudgetMs })],
	[
		"The server does not support SSL connections",
		() => TlsRefused.make({ fault: { kind: "notOffered" } })
	],
	[
		"There was an error establishing an SSL connection",
		() => TlsRefused.make({ fault: { kind: "unanswered" } })
	],
	["Connection terminated unexpectedly", () => ConnectionClosed.make()]
])

/**
 * The password Effect of an attempt died or was interrupted: a defect of the operation that opened the session, never
 * a connection failure. The password function rejects with it, so the attempt's end can tell it from pg's failures.
 */
class PasswordDefect extends Schema.TaggedError<
	PasswordDefect,
	{ readonly brand: unique symbol }
>()("PasswordDefect", {
	defect: Schema.Unknown
}) {}

const isPasswordDefect = Schema.is(PasswordDefect)

/** What pg said with a failure it reports by message alone: the message, or the value it failed with, rendered. */
const saidBy = (error: unknown): string =>
	Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
		? error.message
		: Formatter.format(error)

/**
 * The class of a failed connection attempt, from what pg reported (failures.ts ConnectRefusal): the CredentialError the
 * password function rejected with; an ErrorResponse, the server's refusal of the startup as it gave it; a Node error by
 * its code, a TLS code as TLS and any other as the socket's; pg's own failures that carry no code by their message; and
 * anything else pg ended the startup with as its own refusal, with pg's words.
 */
const connectRefusalOf = (error: unknown): ConnectRefusal => {
	if (Schema.is(CredentialError)(error)) {
		return error
	}
	if (error instanceof DatabaseError) {
		const answer = serverFailure(error)
		return answer === undefined
			? DriverRefused.make({ said: error.message })
			: StartupRefused.make({ error: answer.error })
	}
	if (Predicate.hasProperty(error, "code") && Predicate.isString(error.code)) {
		return isTlsCode(error.code)
			? TlsRefused.make({ fault: { kind: "handshake", code: error.code } })
			: SocketFailed.make({ code: error.code })
	}
	const said = saidBy(error)
	const known = messageRefusals.get(said)
	return known === undefined ? DriverRefused.make({ said }) : known()
}

/** The end of a failed connection attempt: a defect of the password Effect is the operation's; any other its class. */
const attemptFailed = (error: unknown): Effect.Effect<never, ConnectRefusal> =>
	isPasswordDefect(error) ? Effect.die(error.defect) : Effect.fail(connectRefusalOf(error))

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
 * The password of one connection attempt: the Redacted itself, or a function pg calls when the server asks for it,
 * which runs the Effect under the services `current` holds then.
 *
 * A typed failure rejects with the CredentialError, which fails the attempt at the credential stage; a defect or
 * an interruption of the Effect rejects with a PasswordDefect, the operation's defect.
 */
const passwordOf = (
	spec: SessionSpec,
	services: AttemptServices
): string | (() => Promise<string>) => {
	const configured = spec.password
	return Redacted.isRedacted(configured)
		? Redacted.value(configured)
		: () =>
				Effect.runPromiseWith(services.current)(
					configured.pipe(
						Effect.map(Redacted.value),
						Effect.sandbox,
						Effect.mapError((cause) => {
							const error = Cause.findError(cause)
							return Result.isSuccess(error)
								? error.success
								: PasswordDefect.make({ defect: Cause.squash(cause) })
						})
					)
				)
}

const clientConfig = (spec: SessionSpec): ClientConfig => {
	const base = {
		host: spec.host,
		port: spec.port,
		database: spec.database,
		user: spec.role,
		application_name: spec.applicationName,
		pipeline: true,
		types: rawText,
		connectionTimeoutMillis: connectBudgetMs
	}
	const transport = spec.transport
	return transport._tag === "tls"
		? { ...base, ssl: verifyFull(transport.tls) }
		: { ...base, ssl: false, stream: transport.open }
}

/**
 * The client class of the sessions over `spec`. pg's Pool constructs each client with its own copy of its options,
 * from which it hides the password, and reads `connectionTimeoutMillis` from those options as its own bound on the
 * wait for a free client; so a client takes its configuration from here instead, with the connect budget, and the
 * wait stays the lease's. An `error` event of a client in use is also the failure of its queries, which their
 * callbacks receive, so the event is dropped rather than left to crash the process. A connection that failed is
 * destroyed: pg leaves it open when the failure is the client's own, a rejected password function or a SCRAM proof
 * that does not verify. The client's password runs under the services of the attempt that constructs it until its
 * connection is set up, and under `own` after.
 */
const sessionClient = (spec: SessionSpec, attempt: AttemptServices) => {
	const config = clientConfig(spec)
	return class SessionClient extends Client {
		constructor() {
			const services: AttemptServices = { current: attempt.current, own: attempt.own }
			super({ ...config, password: passwordOf(spec, services) })
			this.once("connect", () => {
				services.current = services.own
			})
			this.on("error", () => undefined)
			this.connection.on("error", () => this.connection.stream.destroy())
		}
	}
}

/** The SSLRequest message: its length, 8, and the request code 80877103. */
const sslRequest = (): Uint8Array => Uint8Array.of(0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f)

/** The CancelRequest message: its length, 16, the request code 80877102, and the backend's key. */
const cancelFrame = (key: BackendKey): Uint8Array => {
	const frame = new Uint8Array(16)
	const view = new DataView(frame.buffer)
	view.setInt32(0, 16)
	view.setInt32(4, 80877102)
	view.setInt32(8, key.processId)
	view.setInt32(12, key.secretKey)
	return frame
}

/**
 * How long a CancelRequest's connection may take before it is abandoned: the server closes it once it has read the
 * request.
 */
const cancelRequestTimeout = Duration.seconds(5)

/**
 * One CancelRequest for whatever statement the session's backend is running, over a connection of its own: SSLRequest
 * and verify-full TLS as the session's, or a stream of the session's transport. It ends when the server closes that
 * connection, or when it fails or times out on the Clock, in which case the request may not have arrived and the
 * connection is destroyed.
 */
const cancelRequest = (spec: SessionSpec, key: BackendKey): Effect.Effect<void> =>
	Effect.timeoutOrElse(
		Effect.callback<void>((resume) => {
			const sockets: Array<WireStream> = []
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
			const watch = <S extends WireStream>(socket: S): S => {
				sockets.push(socket)
				socket.once("error", finish)
				socket.once("close", finish)
				return socket
			}
			const transport = spec.transport
			if (transport._tag === "stream") {
				watch(transport.open()).write(cancelFrame(key))
			} else {
				const raw = watch(netConnect({ host: spec.host, port: spec.port, noDelay: true }))
				raw.once("connect", () => raw.write(sslRequest()))
				raw.once("data", (answer: Uint8Array) => {
					if (answer.length !== 1 || answer[0] !== 0x53) {
						finish()
						return
					}
					const secure = watch(tlsConnect({ socket: raw, ...verifyFull(transport.tls) }))
					secure.once("secureConnect", () => secure.write(cancelFrame(key)))
				})
			}
			return Effect.sync(finish)
		}),
		{ duration: cancelRequestTimeout, orElse: () => Effect.void }
	)

/** One connected client in pipeline mode, with what grizzle keeps beside it. */
export interface Session {
	/** The login role the session logged in as, which its statements run as unless a prologue enters another. */
	readonly role: string
	readonly statements: SessionStatements
	/** One CancelRequest for the statement the backend is running. */
	readonly cancel: Effect.Effect<void>
	/**
	 * Whether the session must not be reused: a statement in flight was interrupted, so its cancellation is unconfirmed;
	 * the connection was lost, the server ended it, or it answered what the pipeline cannot account for; or a
	 * transaction it opened could not be ended.
	 */
	readonly retired: () => boolean
	readonly retire: () => void
	/** The connection failed or ended: nothing can run on it. */
	readonly lost: () => boolean
	/** Ends the connection at once, failing whatever it was waiting for. */
	readonly destroy: () => void
	/**
	 * Writes `pipeline` in one corked write, behind a Close for each of `closes`, and reports each query's answer by its
	 * index, then the pipeline's end: the ReadyForQuery after its last query, or the connection's end once every query
	 * has failed.
	 */
	readonly send: (
		closes: ReadonlyArray<string>,
		pipeline: ReadonlyArray<WireQuery>,
		onAnswer: (index: number, answer: Answer) => void,
		onEnd: () => void
	) => void
}

/**
 * A statement on the extended protocol, named or unnamed. pg sends a query without parameters or a name as a simple
 * Query message, which accepts several statements in one text, unless its `queryMode` is "extended", which pg's types
 * leave out. pg refuses a query before its bytes go out only for what this never builds: no text, parameters that are no
 * array or that its value mapper throws on (every parameter is a string), or a name it parsed for another text (a
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

const controlQuery = (sql: string) => ({ text: sql, rowMode: "array" as const })

/** The whole flight is written corked and flushed at once; the stream is uncorked whatever the writes threw. */
const makeSession = (client: Client, spec: SessionSpec, key: BackendKey): Session => {
	const statements = new SessionStatements()
	let retired = false
	let lost = false
	const lose = (): void => {
		lost = true
	}
	client.on("error", lose)
	client.on("end", lose)
	const send: Session["send"] = (closes, pipeline, onAnswer, onEnd) => {
		const connection = client.connection
		let answered = 0
		let drained = false
		const settle = (): void => {
			if (answered < pipeline.length || !(drained || lost)) {
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
				const answer = (
					error: unknown,
					result: QueryArrayResult<Array<unknown>> | undefined
				): void => {
					onAnswer(index, answerOf(error, result))
					answered += 1
					settle()
				}
				if (query._tag === "control") {
					client.query<Array<unknown>, Array<string>>(
						controlQuery(controlText(query.control)),
						answer
					)
				} else {
					client.query<Array<unknown>, Array<string>>(statementQuery(query), answer)
				}
			}
		})
		connection.stream.uncork()
		if (Result.isFailure(written)) {
			throw written.failure
		}
	}
	return {
		role: spec.role,
		statements,
		cancel: cancelRequest(spec, key),
		retired: () => retired,
		retire: () => {
			retired = true
		},
		lost: () => lost,
		destroy: () => client.connection.stream.destroy(),
		send
	}
}

/** A session from a client pg has just connected: its BackendKeyData must be there. */
const sessionOf = (client: Client, spec: SessionSpec): Session | undefined => {
	const key = backendKeyOf(client)
	return key === undefined ? undefined : makeSession(client, spec, key)
}

/**
 * One session outside any pool (the migration owner's, the protocol tap's), closed with the scope. The attempt is
 * interruptible.
 */
export const connectSession = (
	spec: SessionSpec
): Effect.Effect<Session, ConnectRefusal, Scope.Scope> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const transport = spec.transport
			if (transport._tag === "tls" && caCount(transport.tls) === 0) {
				return yield* TlsRefused.make({ fault: { kind: "noAuthority" } })
			}
			const services = yield* Effect.context()
			const SessionClient = sessionClient(spec, { current: services, own: services })
			const client = new SessionClient()
			const connected = Effect.callback<void, ConnectRefusal>((resume) => {
				client.connect((error: unknown) => {
					resume(error === null || error === undefined ? Effect.void : attemptFailed(error))
				})
				return Effect.sync(() => client.connection.stream.destroy())
			})
			yield* restore(connected)
			const session = sessionOf(client, spec)
			if (session === undefined) {
				client.connection.stream.destroy()
				return yield* NoCancelKey.make()
			}
			yield* Effect.addFinalizer(() =>
				session.lost()
					? Effect.sync(() => {
							session.destroy()
						})
					: Effect.promise(() => client.end())
			)
			return session
		})
	)

/**
 * Where one lease's ask for a client stands, and so who holds its permit: queued for a permit, holding none; connecting,
 * its permit given to pg's Pool, which was asked for a client and has not answered; connected, pg's client and its
 * permit held for the lease; or refused, its permit back, with what the attempt failed with.
 */
type AskState =
	| { readonly _tag: "queued" }
	| { readonly _tag: "connecting"; readonly attempt: Attempt }
	| { readonly _tag: "connected"; readonly client: PoolClient }
	| { readonly _tag: "refused"; readonly failure: Effect.Effect<never, AcquireRefusal> }

/**
 * One lease's ask for a client. It moves only in plain synchronous code, never across a fiber's steps: the lease waits
 * for `settled` alone, interruptibly, and then claims what the ask holds at once, without interruption, so neither a
 * permit nor a client is ever in flight between fibers where an interruption could drop it.
 */
interface Ask {
	state: AskState
	/** The services of the lease the ask is for, under which its connection attempt's password runs. */
	readonly services: Context.Context<never>
	/** Done once the ask is connected or refused. */
	readonly settled: Deferred.Deferred<void>
}

/**
 * The pool's permits, one for each session up to `pool.max`, as they stand between asks: some free and no ask waiting
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

/**
 * pg's callback for one attempt. For the ask waiting for it, the client is held for the lease with its permit, or the
 * failure is the ask's and the permit goes back. When nobody waits, the client goes back to pg's Pool and the permit
 * with it. pg keeps the callback for the client's life (the connection's `connect` listener holds pg's own callback,
 * which holds this), so it is made here, apart from any lease, and drops the ask once it has answered: a connected
 * client keeps no lease's context.
 */
const answerAttempt =
	(attempt: Attempt, permitBack: () => void) =>
	(error: unknown, client: PoolClient | undefined): void => {
		const waiter = attempt.waiter
		attempt.waiter = nobody
		if (waiter._tag === "nobody") {
			client?.release()
			permitBack()
			return
		}
		const ask = waiter.ask
		if (client === undefined) {
			ask.state = { _tag: "refused", failure: attemptFailed(error) }
			permitBack()
		} else {
			ask.state = { _tag: "connected", client }
		}
		Deferred.doneUnsafe(ask.settled, Effect.void)
	}

/**
 * What a lease takes from its ask once its wait ends: pg's client, the lease's now with its permit; pg's refusal; or
 * nothing, the ask withdrawn from the queue or from pg's Pool, whose later answer goes back to the pool.
 */
type Claim =
	| { readonly _tag: "client"; readonly client: PoolClient }
	| { readonly _tag: "refused"; readonly failure: Effect.Effect<never, AcquireRefusal> }
	| { readonly _tag: "unanswered" }

const unanswered: Claim = { _tag: "unanswered" }

/**
 * pg's Pool, whose `release` listeners each run on their own. A listener is foreign code (Vercel's integration), and a
 * release happens in a lease's finalizer: one that throws never skips the other listeners or the release itself, which
 * pg's Pool would otherwise leave half done, its client neither idle nor closed, so the pool would lose a session for
 * good.
 */
class ReleasingPool extends Pool {
	override emit(event: string | symbol, ...args: Array<unknown>): boolean {
		if (event !== "release") {
			return super.emit(event, ...args)
		}
		const listeners = this.listeners(event)
		for (const listener of listeners) {
			Result.try(() => {
				Reflect.apply(listener, this, args)
			})
		}
		return listeners.length > 0
	}
}

interface PoolConfig {
	/** The destination, the derived login role and the password. */
	readonly connection: Omit<SessionSpec, "applicationName" | "transport">
	/** The transport: verify-full TLS, or a stream a test taps the protocol through. */
	readonly transport: Transport
	/** The pool's bounds (core/policy.ts poolBounds in production); tests pass smaller ones to observe them. */
	readonly pool: { readonly idleTimeoutMs: number; readonly min: number; readonly max: number }
	/** The acquisition budgets; tests pass smaller ones to observe them. */
	readonly budgets: AcquisitionBudgets
	/** The platform's hook, handed pg's Pool once, when it is built (DbConfig.attachPool). */
	readonly attachPool: (pool: ConnectionPool) => void
}

export interface SessionPool {
	readonly role: string
	/** pg's Pool, attached to Vercel's pool integration when it was built. */
	readonly native: Pool
	readonly idleTimeoutMillis: number
	readonly maxSessions: number
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
 * Builds the pool in the current scope; it ends, closing every session, when that scope closes.
 *
 * pg destroys a client released with true instead of returning it to the pool.
 *
 * An idle client that failed, which pg's Pool has already closed and dropped.
 *
 * Once, at construction: the platform's hook (Vercel's attachDatabasePool reads the idle timeout and subscribes to
 * release), or nothing. The function's deadline never becomes a statement or lock timeout. A throw is a defect of
 * the caller's hook.
 *
 * The lease's services hold only while pg constructs and starts connecting a client inside `connect`, and that client
 * keeps them only until its connection is set up.
 */
export const makePool = (config: PoolConfig): Effect.Effect<SessionPool, never, Scope.Scope> =>
	Effect.gen(function* () {
		const { pool, budgets } = config
		const spec: SessionSpec = {
			...config.connection,
			transport: config.transport,
			applicationName: "grizzle"
		}
		const own = yield* Effect.context()
		const attemptServices: AttemptServices = { current: own, own }
		const native = new ReleasingPool({
			Client: sessionClient(spec, attemptServices),
			min: pool.min,
			max: pool.max,
			idleTimeoutMillis: pool.idleTimeoutMs
		})
		native.on("error", () => undefined)
		/**
		 * The session of each client pg's Pool connected, made as it connects, before anyone holds the client, and kept
		 * beside it; a client with none had no BackendKeyData. `live` holds each session from then until its connection
		 * ends, so it holds exactly the open ones, and an ended session goes with its client.
		 */
		const sessions = new WeakMap<PoolClient, Session>()
		const live = new Set<Session>()
		native.on("connect", (client) => {
			const session = sessionOf(client, spec)
			if (session === undefined) {
				return
			}
			sessions.set(client, session)
			live.add(session)
			client.once("end", () => {
				live.delete(session)
			})
		})
		yield* Effect.addFinalizer(() => Effect.promise(() => native.end()))
		yield* Effect.sync(() => {
			config.attachPool(native)
		})
		const transport = spec.transport
		const refused = transport._tag === "tls" && caCount(transport.tls) === 0
		/**
		 * The permits. An ask takes a permit before pg's Pool is asked for a client for it, and the permit comes back
		 * once pg has that client back or the attempt has failed; an attempt abandoned while pg connects or hands over
		 * its client keeps its permit until pg answers. So pg's Pool always has an idle client or room for the attempt,
		 * and never queues one.
		 */
		let permits: Permits = pool.max > 0 ? { _tag: "free", count: pool.max } : exhausted
		/**
		 * The clients handed to a lease and not yet released. pg's Pool counts a client still connecting in totalCount
		 * and not in idleCount, so its difference would count a session being established as leased.
		 */
		let leased = 0

		/**
		 * Asks pg's Pool for a client for `ask`, which holds a permit, under the services of its lease; whether pg holds
		 * the permit now. pg's Pool ends only in this pool's finalizer, so an ending pool is a released layer: the ask is
		 * refused with LayerReleased, read in the same turn as `connect`, so no end can come between, and the permit is
		 * the caller's again, as it is when pg's Pool throws.
		 */
		const attemptFor = (ask: Ask): boolean => {
			if (native.ending) {
				ask.state = { _tag: "refused", failure: Effect.fail(LayerReleased.make()) }
				Deferred.doneUnsafe(ask.settled, Effect.void)
				return false
			}
			const attempt: Attempt = { waiter: { _tag: "waiting", ask } }
			ask.state = { _tag: "connecting", attempt }
			attemptServices.current = ask.services
			const started = Result.try(() => {
				native.connect(answerAttempt(attempt, permitBack))
			})
			attemptServices.current = own
			if (Result.isSuccess(started)) {
				return true
			}
			attempt.waiter = nobody
			ask.state = { _tag: "refused", failure: Effect.die(started.failure) }
			Deferred.doneUnsafe(ask.settled, Effect.void)
			return false
		}

		/** A permit back: to the first ask waiting that pg's Pool takes it for, else free. */
		const permitBack = (): void => {
			while (permits._tag === "waiting") {
				const [first, ...rest] = permits.queue
				permits = waitingFor(rest)
				if (attemptFor(first)) {
					return
				}
			}
			permits = { _tag: "free", count: permits._tag === "free" ? permits.count + 1 : 1 }
		}

		/** A new ask for the lease whose services are `services`: given a free permit and pg asked at once, or queued. */
		const newAsk = (services: Context.Context<never>): Ask => {
			const made: Ask = {
				state: { _tag: "queued" },
				services,
				settled: Deferred.makeUnsafe<void>()
			}
			if (permits._tag !== "free") {
				permits = {
					_tag: "waiting",
					queue: permits._tag === "waiting" ? Arr.append(permits.queue, made) : [made]
				}
				return made
			}
			permits = permits.count === 1 ? exhausted : { _tag: "free", count: permits.count - 1 }
			if (!attemptFor(made)) {
				permitBack()
			}
			return made
		}

		/**
		 * What the lease takes from `ask` once its wait ends, in one step: the client pg connected or its refusal; or, if
		 * neither came, the ask withdrawn, from the queue, or from pg's Pool, whose later answer goes back with its permit.
		 */
		const claim = (ask: Ask): Claim => {
			const state = ask.state
			switch (state._tag) {
				case "queued":
					permits = withdrawn(permits, ask)
					return unanswered
				case "connecting":
					state.attempt.waiter = nobody
					return unanswered
				case "connected":
					return { _tag: "client", client: state.client }
				case "refused":
					return { _tag: "refused", failure: state.failure }
			}
		}

		/** `client` back to pg's Pool, which closes it when `close` holds, and then its permit. */
		const giveBack = (client: PoolClient, close: boolean): Effect.Effect<void> =>
			Effect.sync(() => {
				client.release(close)
				permitBack()
			})

		/**
		 * A lease's end: the client leaves the leased count and goes back to pg's Pool; a retired or lost session is
		 * released with an error, so pg's Pool closes it.
		 */
		const release = (client: PoolClient, session: Session): Effect.Effect<void> =>
			Effect.suspend(() => {
				leased -= 1
				return giveBack(client, session.retired() || session.lost())
			})

		/**
		 * One client, waited for until `deadline` (clock milliseconds), as a session for the scope. A pooled client found
		 * lost before anything ran on it is closed and another leased in its place, while `replacements` remain: this is
		 * pool hygiene, never a retry, at most `pool.max` times and within the same wait budget, so no flight is ever sent
		 * twice, and a connection attempt that fails is the acquisition's failure. A lease of a pool already ending is
		 * refused at once, before it asks for a permit.
		 *
		 * Only the wait for the ask to settle is interruptible, and it carries nothing: whatever ended it, the lease then
		 * claims what the ask holds in one step, without interruption, so a client that arrived for an interrupted lease
		 * goes back with its permit, and a leased client is always released. A wait that runs out of the budget with the
		 * ask unanswered withdraws it and fails with AcquisitionBudgetExceeded.
		 */
		const leaseUntil = (
			deadline: number,
			replacements: number
		): Effect.Effect<Session, AcquireRefusal, Scope.Scope> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (refused) {
						return yield* TlsRefused.make({ fault: { kind: "noAuthority" } })
					}
					if (native.ending) {
						return yield* LayerReleased.make()
					}
					const now = yield* Clock.currentTimeMillis
					const asked = newAsk(yield* Effect.context())
					const waited = yield* Effect.exit(
						restore(
							Effect.timeoutOption(
								Deferred.await(asked.settled),
								Duration.millis(Math.max(0, deadline - now))
							)
						)
					)
					const claimed = claim(asked)
					if (Exit.isFailure(waited)) {
						if (claimed._tag === "client") {
							yield* giveBack(claimed.client, false)
						}
						return yield* Effect.failCause(waited.cause)
					}
					if (claimed._tag === "unanswered") {
						return yield* AcquisitionBudgetExceeded.make({
							millis: budgets.waitMs,
							sessions: native.totalCount,
							leased,
							max: pool.max
						})
					}
					if (claimed._tag === "refused") {
						return yield* claimed.failure
					}
					const client = claimed.client
					const session = sessions.get(client)
					if (session === undefined) {
						yield* giveBack(client, true)
						return yield* NoCancelKey.make()
					}
					if (session.lost() && replacements > 0) {
						yield* giveBack(client, true)
						return yield* restore(leaseUntil(deadline, replacements - 1))
					}
					leased += 1
					yield* Effect.addFinalizer(() => release(client, session))
					return session
				})
			)

		const lease = Effect.flatMap(Clock.currentTimeMillis, (now) =>
			leaseUntil(now + budgets.waitMs, pool.max)
		)

		return {
			role: spec.role,
			native,
			idleTimeoutMillis: pool.idleTimeoutMs,
			maxSessions: pool.max,
			lease,
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
