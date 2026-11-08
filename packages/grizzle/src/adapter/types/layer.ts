import type { Effect, Layer, Redacted } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CredentialError, TokenError } from "#adapter/errors/failures.ts"
import type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
import type { AnyLogin, LoginReadsContext, RolesOf, phantom } from "#compiler/plan/common.ts"

/**
 * The connection layer. Types only: packages/grizzle/src/adapter implements DbLayer. A platform's credentials (an RDS IAM token, a
 * secret manager's lookup) and its pool integration (Vercel's attachDatabasePool) are the caller's, through `password`
 * and `attachPool`: grizzle names no platform's SDK.
 *
 * A layer is built for one login: one credential and one pool, which serves every role of the login, and the login's
 * workloads, compiled once. Db.open(Web.roles.member) requires DbLayer<role>, and the layer of a login provides
 * DbLayer<R> for each of its roles R (DbLayerOf), so a role of another login does not open on it.
 *
 * The Effect service Db.open requires: a layer that serves the role R, invariantly, so DbLayer<R> provides the
 * requirement DbLayer<R> and no other role's. No runtime value holds the phantom (core/phantom.ts).
 */
export interface DbLayerService<in out R> {
	readonly [phantom]?: { readonly role: R; readonly serves: (serves: R) => void } | undefined
}

/** What the layer of login L provides: DbLayer<R> for every role R of the login. */
export type DbLayerOf<L> =
	RolesOf<L> extends infer R ? (R extends unknown ? DbLayerService<R> : never) : never

/**
 * A session pool DbLayer.make builds, as a platform that manages idle connections between invocations reads it: its idle
 * timeout, and its release event, emitted each time a session goes back to it. It is the Pool of the caller's driver
 * (PgDriver); on Vercel Fluid compute, `attachDatabasePool` from @vercel/functions/db-connections takes it as it is.
 */
export interface ConnectionPool {
	readonly options: { readonly idleTimeoutMillis: number | null }
	on(event: "release", listener: () => void): unknown
}

/**
 * How a connection reaches the server, the one way there is: the transport's socket, which `open` makes unconnected
 * and the driver connects to `host` and `port`, then the SSLRequest, and verify-full TLS over the socket, the server
 * certificate chained to `ca` and naming `servername`. A plain Node caller opens `() => new net.Socket()`; a tunnel
 * connects to its local end and names the server it reaches. A server that answers the SSLRequest with no is refused:
 * nothing is ever sent in plaintext.
 */
export interface Transport {
	readonly kind: "sslRequest"
	/**
	 * The host the socket connects to, nonempty: a name or an IP address, never a path (a host starting with /), which
	 * node-postgres reads as a Unix socket's directory, over which PostgreSQL offers no TLS.
	 */
	readonly host: string
	/** The port the socket connects to, an integer from 1 to 65535. */
	readonly port: number
	/** A new, unconnected socket, for each session and for each CancelRequest. */
	readonly open: () => PgSocket
	/** PEM certificates the server certificate must chain to: one text, or a nonempty list of them. */
	readonly ca: string | ReadonlyArray<string>
	/** The name the server certificate must carry, nonempty. */
	readonly servername: string
}

/**
 * Where a connection goes and how it authenticates, which a DbLayer's config and the migration connection share: the
 * driver, the transport, the database, the password, and the connect timeout.
 */
export interface DbConnection {
	/** node-postgres, as the caller imports it (`import pg from "pg"`): grizzle imports no driver itself. */
	readonly driver: PgDriver
	readonly transport: Transport
	readonly database: string
	/** Evaluated for each connection attempt when it is an Effect, so a rotating credential needs no restart. */
	readonly password: Redacted.Redacted | Effect.Effect<Redacted.Redacted, CredentialError>
	/**
	 * How long one connection attempt may take, in milliseconds, an integer from 1 to 2,147,483,647: the password
	 * Effect, TCP, TLS, startup and authentication, past which it fails with ConnectTimedOut; and how long the one
	 * CancelRequest an interrupted statement sends may take.
	 */
	readonly connectTimeoutMs: number
}

/**
 * The session pool a DbLayer builds for its login, sized by the caller: grizzle chooses no size and no timeout. A lease
 * waits for a session as long as its caller lets it: no deadline of grizzle's bounds the wait, which is interruptible
 * and holds nothing, so the caller's own timeout ends it.
 */
export interface PoolBounds {
	/** The most sessions open at once, leased, idle or being established: an integer from 1. */
	readonly max: number
	/** The sessions kept open once opened, however long they stay idle: an integer from 0 to `max`. */
	readonly min: number
	/**
	 * How long a session idle above `min` stays open, in milliseconds, an integer from 1 to 2,147,483,647: a platform's
	 * hook reads it as the pool's idle timeout (ConnectionPool).
	 */
	readonly idleTimeoutMs: number
}

/**
 * Turns a Db's token into the payload its contexts are decoded from, once per Db.open: a JWT verifier, for instance.
 * It fails with TokenError when the token is refused.
 */
export type Verify = (token: string) => Effect.Effect<unknown, TokenError>

/** `verify` is required exactly when a role of the login reads a context. */
type VerifyOf<L> =
	LoginReadsContext<L> extends true ? { readonly verify: Verify } : { readonly verify?: Verify }

/**
 * DbLayer.make's config: a connection for the login L, whose PostgreSQL login role is the one roleNameOf(L) names,
 * fixed for the connection's lifetime, and the snapshot the application knows.
 */
export type DbConfigShape<L> = DbConnection & {
	readonly login: L
	/**
	 * The login's base's committed migrations/<schema>/snapshot.json, as the JSON value an import of it yields: what
	 * every Db's admission compares the catalog with, and what the login's workloads' access is checked against when
	 * the layer is built. None is ever derived from the schema alone.
	 */
	readonly snapshot: { readonly fingerprint: string }
	/** The login's one session pool, which serves every role of the login. */
	readonly pool: PoolBounds
	/**
	 * Called once with each session pool the layer builds, when it is built: the platform's hook for idle connections
	 * (on Vercel, `attachPool: attachDatabasePool`). Without it, nothing is attached.
	 */
	readonly attachPool?: (pool: ConnectionPool) => void
} & VerifyOf<L>

/**
 * DbLayer.make; packages/grizzle/src/adapter/public/layer.ts implements it. The config is parsed where it is given: one
 * no connection can use (a driver that is no driver, an empty host or one that is a path, a port outside 1 to 65535, an
 * empty CA bundle, no servername, a connect timeout or a pool bound outside its range) fails the layer with
 * OpenError{stage: "config"}.
 * Building the layer compiles every program of the login's workloads, once, for every role it runs on, and checks their
 * access against the snapshot: a snapshot that does not parse, a program that does not compile, or a workload whose
 * access is not the snapshot's fails the layer with OpenError{stage: "schema"}.
 */
export interface DbLayerConstructor {
	make<const L extends AnyLogin>(config: DbConfigShape<L>): Layer.Layer<DbLayerOf<L>, OpenError>
}
