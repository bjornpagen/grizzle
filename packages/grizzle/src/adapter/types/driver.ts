import type { ConnectionOptions } from "node:tls"
import type { ClientBase } from "pg"

/**
 * node-postgres as grizzle uses it: the module the caller imports and passes in (DbConnection.driver), so grizzle
 * imports nothing of pg at run time. Types only. Each member is exactly what grizzle reaches of pg 8.23, and a module
 * without one of them, or whose Client has no pipeline mode, is no PgDriver: a pg too old for pipelining is a type
 * error where the config is written, never a flight that silently takes a round trip per statement.
 *
 * - Client: the class grizzle extends for every session (wire/session.ts sessionClient), constructed with the
 *   configuration grizzle states in full (PgClientConfig). Its instances keep `pipeline`, which pg 8.23 added with the
 *   pipeline mode every flight is written in.
 * - Pool: the pool grizzle builds each session pool from (wire/releasing-pool.ts), which constructs its clients from the
 *   Client class grizzle derives from this driver's own (PgPoolConfig.Client).
 * - DatabaseError: the class pg reports an ErrorResponse with, which grizzle tells from its other failures by
 *   `instanceof`.
 */
export interface PgDriver {
	readonly Client: new (config: PgClientConfig) => PgClient
	readonly Pool: new (config: PgPoolConfig) => PgPool
	readonly DatabaseError: abstract new (...args: never) => PgDatabaseError
}

/**
 * What Node's TLS upgrades: the `socket` of `tls.connect`, which pg 8.23 hands every session's socket to
 * (lib/connection.js upgradeToSSL), as wire/session.ts hands a CancelRequest's, and which pg's own client configuration
 * takes its `stream` as.
 */
type TlsUpgradable = NonNullable<ConnectionOptions["socket"]>

/**
 * The socket a connection runs over, as the caller's transport opens it, unconnected: pg connects it
 * (`connect(port, host)`, pg 8.23 lib/connection.js), sets no-delay on it, refs and unrefs it, writes the SSLRequest on
 * it and upgrades it through `tls.connect({ socket })` (TlsUpgradable); a CancelRequest's connection is opened,
 * connected and upgraded the same way (wire/session.ts). A plain Node caller opens `new net.Socket()`.
 */
export interface PgSocket extends TlsUpgradable {
	connect(port: number, host: string): unknown
	setNoDelay(noDelay: boolean): unknown
	setKeepAlive(enable: boolean, initialDelay: number): unknown
	ref(): unknown
	unref(): unknown
}

/**
 * The configuration of every session's client, each setting stated, so pg reads none of them from the environment
 * (connection/environment.ts): the destination and login, the password as a function pg calls when the server asks for
 * one, verify-full TLS negotiated by SSLRequest over the transport's socket, the connect timeout, pipeline mode, text
 * results, and a login's pinned startup options, which an owner's session leaves out.
 */
export interface PgClientConfig {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly user: string
	readonly password: () => Promise<string>
	readonly client_encoding: string
	readonly sslnegotiation: "postgres"
	readonly options?: string
	readonly pipeline: true
	readonly types: { readonly getTypeParser: () => (text: string) => string }
	readonly connectionTimeoutMillis: number
	readonly ssl: ConnectionOptions
	readonly stream: () => PgSocket
}

/**
 * A connected client as grizzle reaches it: pg's own client, whose queries and events it uses, with its pipeline mode and
 * its connection. It is pg's ClientBase because pg's Pool takes a client class of it (PgPoolConfig.Client).
 */
export interface PgClient extends ClientBase {
	readonly pipeline: boolean
	readonly connection: PgConnection
	end(callback: () => void): void
}

/** A client of pg's Pool: one it handed over, which goes back to it, or is closed when `close` holds. */
export interface PgPoolClient extends PgClient {
	release(close: boolean): void
}

/**
 * A client's connection: the stream it writes a flight to, corked, and destroys; the Close of a server statement's
 * name; its `error` event, a failure of the client's own during startup; its `sslconnect`, once pg has upgraded its
 * stream to TLS and the handshake has begun; and its first ReadyForQuery, once the server has answered the startup and
 * sent its BackendKeyData.
 */
interface PgConnection {
	readonly stream: PgStream
	close(message: { readonly type: "S"; readonly name: string }, more: boolean): void
	on(event: "error", listener: () => void): unknown
	once(event: "readyForQuery" | "sslconnect", listener: () => void): unknown
}

/**
 * The stream of a client's connection: the transport's socket, or the TLS socket over it once upgraded, whose
 * handshake ends with `secureConnect` and whose failures are its `error` events.
 */
interface PgStream {
	cork(): void
	uncork(): void
	destroy(): unknown
	once(event: "secureConnect", listener: () => void): unknown
	prependListener(event: "error", listener: (error: unknown) => void): unknown
}

/** What grizzle builds pg's Pool with: its client class, and its bounds (DbConfig.pool). */
export interface PgPoolConfig {
	readonly Client: new () => PgClient
	readonly min: number
	readonly max: number
	readonly idleTimeoutMillis: number
}

/**
 * pg's Pool as grizzle reaches it: asked for a client, ended without awaiting, its counts, and its `error` and `release`
 * events, the last a platform's hook (types/layer.ts ConnectionPool).
 */
export interface PgPool {
	readonly options: { readonly idleTimeoutMillis: number | null }
	readonly ending: boolean
	readonly totalCount: number
	readonly idleCount: number
	readonly waitingCount: number
	connect(callback: (error: unknown, client: PgPoolClient | undefined) => void): void
	end(callback: () => void): void
	on(event: "error" | "release", listener: () => void): unknown
}

/** pg's report of an ErrorResponse: the server's fields grizzle keeps (wire/failure.ts serverFailure). */
export interface PgDatabaseError extends Error {
	readonly code: string | undefined
	readonly severity: string | undefined
	readonly detail: string | undefined
	readonly hint: string | undefined
	readonly schema: string | undefined
	readonly table: string | undefined
	readonly column: string | undefined
	readonly dataType: string | undefined
	readonly constraint: string | undefined
}

/** What pg answers one query in array row mode: its command tag and its rows. */
export interface PgArrayResult {
	readonly command: string
	readonly rows: ReadonlyArray<ReadonlyArray<unknown>>
}
