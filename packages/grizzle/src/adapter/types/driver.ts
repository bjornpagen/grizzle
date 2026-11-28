import type { ConnectionOptions } from "node:tls"
import type { ClientBase, Submittable } from "pg"

/**
 * node-postgres as grizzle uses it: the module the caller imports and passes in (DbConnection.driver), so grizzle
 * imports nothing of pg at run time. Types only. Each member is exactly what grizzle reaches of pg 8.23, and a module
 * without one of them, or whose Client has no pipeline mode, is no PgDriver: a pg too old for pipelining is a type
 * error where the config is written, never a flight that silently takes a round trip per statement.
 *
 * - Client: the class grizzle extends for every session (wire/session.ts sessionClient), constructed with the
 *   configuration grizzle states in full (PgClientConfig). Its instances keep `pipeline`, which pg 8.23 added with the
 *   pipeline mode every flight is written in.
 * - Pool: the pool grizzle builds each session pool from (wire/pool.ts makePool), which constructs its clients from
 *   the Client class grizzle derives from this driver's own (PgPoolConfig.Client).
 * - Query: the query class every statement of a flight is submitted as (wire/session.ts submit), with listeners and no
 *   callback, so pg hands over each row as it arrives and keeps none: a pipelined client takes no other submittable.
 * - DatabaseError: the class pg reports an ErrorResponse with, which grizzle tells from its other failures by
 *   `instanceof`.
 */
export interface PgDriver {
	readonly Client: new (config: PgClientConfig) => PgClient
	readonly Pool: new (config: PgPoolConfig) => PgPool
	readonly Query: new (config: PgQueryConfig) => PgQuery
	readonly DatabaseError: abstract new (...args: never) => PgDatabaseError
}

/**
 * One query as grizzle submits it, in array row mode: a served statement under its name, a one-shot statement as the
 * unnamed statement on the extended protocol, or a transaction control's simple Query (wire/session.ts).
 */
export type PgQueryConfig =
	| {
			readonly name: string
			readonly text: string
			readonly values: Array<string | Uint8Array>
			readonly rowMode: "array"
	  }
	| {
			readonly text: string
			readonly values: Array<string | Uint8Array>
			readonly rowMode: "array"
			readonly queryMode: "extended"
	  }
	| { readonly text: string; readonly rowMode: "array" }

/**
 * A query of pg's own class, submitted to a client, reporting what pg 8.23 query.js emits: each row as it arrives, its
 * cells in column order; then its end, with its command tag, at the ReadyForQuery after it; or its error in place of
 * its end. A query with a row listener and no callback keeps no row (handleRowDescription's _accumulateRows), so its
 * end's result holds none. The listener's type follows the event as pg's own declaration states it.
 */
export interface PgQuery extends Submittable {
	on<E extends "row" | "error" | "end">(
		event: E,
		listener: E extends "row"
			? (row: ReadonlyArray<unknown>) => void
			: E extends "error"
				? (error: unknown) => void
				: (result: PgCompletion) => void
	): unknown
}

/**
 * What Node's TLS upgrades: the `socket` of `tls.connect`, which pg 8.23 hands every session's socket to
 * (lib/connection.js upgradeToSSL), as wire/session.ts hands a CancelRequest's, and which pg's own client configuration
 * takes its `stream` as.
 */
type TlsUpgradable = NonNullable<ConnectionOptions["socket"]>

/**
 * The socket a connection runs over, unconnected: a network transport's, as the caller's transport opens it, which pg
 * connects (`connect(port, host)`, pg 8.23 lib/connection.js), sets no-delay on, refs and unrefs, writes the SSLRequest
 * on and upgrades through `tls.connect({ socket })` (TlsUpgradable), a CancelRequest's connection opened, connected and
 * upgraded the same way (wire/session.ts); or a Unix socket transport's, a `net.Socket` grizzle opens itself, which pg
 * connects by its socket file's path alone (lib/client.js) and never upgrades. A plain Node caller opens
 * `new net.Socket()`.
 */
export interface PgSocket extends TlsUpgradable {
	connect(port: number, host: string): unknown
	setNoDelay(noDelay: boolean): unknown
	setKeepAlive(enable: boolean, initialDelay: number): unknown
	ref(): unknown
	unref(): unknown
}

/**
 * How a session's client meets the wire: in pipeline mode, every session but one, its flights each written at once; or
 * as a replication connection, the live leader's (wire/session.ts connectReplication), a walsender of its database,
 * which reads one simple Query at a time and whose stream is a Submittable of grizzle's own, which pg 8.23 refuses on a
 * pipelined client ("Custom query classes such as pg-cursor and pg-query-stream are not supported in pipeline mode",
 * lib/client.js), so it is never pipelined.
 */
export type PgWireMode =
	| { readonly pipeline: true }
	| { readonly pipeline: false; readonly replication: "database" }

/**
 * The configuration of every session's client, each setting stated, so pg reads none of them from the environment
 * (connection/environment.ts): the destination and login, the password as a function pg calls when the server asks for
 * one, verify-full TLS negotiated by SSLRequest over a network transport's socket, or `false` over a Unix socket, which
 * has none and which pg would otherwise read PGSSLMODE for, no connect timeout, its wire mode, text results, and a
 * login's pinned startup options, which an owner's session leaves out.
 *
 * `connectionTimeoutMillis` is 0, the one value pg 8.23 sets no timer for (lib/client.js `if
 * (this._connectionTimeoutMillis > 0)`): a connection attempt waits for its server's own answer or failure, never a
 * number of grizzle's or its caller's (types/layer.ts DbConnection).
 */
export type PgClientConfig = PgWireMode & {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly user: string
	readonly password: () => Promise<string>
	readonly client_encoding: string
	readonly sslnegotiation: "postgres"
	readonly options?: string
	readonly types: { readonly getTypeParser: () => (text: string) => string }
	readonly connectionTimeoutMillis: 0
	readonly ssl: ConnectionOptions | false
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
 * A client's connection: the stream it writes a flight to, corked, and destroys; its `error` event, a failure of the
 * client's own during startup; its `sslconnect`, once pg has upgraded its stream to TLS and the handshake has begun; and its first ReadyForQuery, once the server has answered the startup and
 * sent its BackendKeyData.
 */
interface PgConnection {
	readonly stream: PgStream
	on(event: "error", listener: () => void): unknown
	once(event: "readyForQuery" | "sslconnect", listener: () => void): unknown
}

/**
 * The stream of a client's connection: the transport's socket, or the TLS socket over it once upgraded, whose
 * handshake ends with `secureConnect` and whose failures are its `error` events. A write's callback reports how the
 * write ended, an Error when it failed, `destroyed` whether the stream was destroyed, and `readableEnded` whether its
 * read side ended, the server having closed it.
 */
interface PgStream {
	cork(): void
	uncork(): void
	write(chunk: Uint8Array, callback: (error: unknown) => void): unknown
	readonly destroyed: boolean
	readonly readableEnded: boolean
	destroy(): unknown
	once(event: "secureConnect", listener: () => void): unknown
	prependListener(event: "error", listener: (error: unknown) => void): unknown
}

/**
 * What grizzle builds pg's Pool with: its client class, its most sessions (DbConfig.pool), and an idle timeout of 0,
 * pg's own "never": pg's Pool sets an idle client's timer only when its idleTimeoutMillis is truthy (pg-pool 3.14.0
 * index.js 409, `if (this.options.idleTimeoutMillis && this._isAboveMin())`), and reads one left out as 10,000 (index.js
 * 98), so the 0 is stated, and its type admits no other: a session is kept for the pool's life (types/layer.ts
 * PoolBounds).
 */
export interface PgPoolConfig {
	readonly Client: new () => PgClient
	readonly max: number
	readonly idleTimeoutMillis: 0
}

/**
 * pg's Pool as grizzle reaches it: asked for a client, ended without awaiting, its counts, and its `error` event.
 */
export interface PgPool {
	readonly ending: boolean
	readonly totalCount: number
	readonly idleCount: number
	readonly waitingCount: number
	connect(callback: (error: unknown, client: PgPoolClient | undefined) => void): void
	end(callback: () => void): void
	on(event: "error", listener: (error: unknown) => void): unknown
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

/** What pg reports at a query's end: its command tag. */
export interface PgCompletion {
	readonly command: string
}
