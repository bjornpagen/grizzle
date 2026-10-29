import type { Effect, Layer, Redacted } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CredentialError, TokenError } from "#adapter/errors/failures.ts"
import type { phantom } from "#compiler/core/phantom.ts"
import type { AnyLogin, LoginReadsContext, RolesOf } from "#compiler/types/schema/world.ts"

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
 * timeout, and its release event, emitted each time a session goes back to it. It is node-postgres's Pool, but no driver
 * type appears in grizzle's API; on Vercel Fluid compute, `attachDatabasePool` from @vercel/functions/db-connections
 * takes it as it is.
 */
export interface ConnectionPool {
	readonly options: { readonly idleTimeoutMillis: number | null }
	on(event: "release", listener: () => void): unknown
}

/**
 * Where a connection goes and how it authenticates: the destination, the credentials and verify-full TLS, which a
 * DbLayer's config and the migration connection share.
 */
export interface DbConnection {
	readonly host: string
	readonly port: number
	readonly database: string
	/** Evaluated for each connection attempt when it is an Effect, so a rotating credential needs no restart. */
	readonly password: Redacted.Redacted | Effect.Effect<Redacted.Redacted, CredentialError>
	/** Always verify-full: the server certificate must chain to `ca` and name `servername`, or `host` when absent. */
	readonly tls: {
		/** PEM certificates. */
		readonly ca: string | ReadonlyArray<string>
		/** For tunnels: connect to localhost, verify the RDS hostname. */
		readonly servername?: string
	}
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
 * DbLayer.make's config: a connection for the login L, whose PostgreSQL login role is derived from it (schema "blog",
 * login "web": role blog__web) and fixed for the connection's lifetime, and the snapshot the application knows.
 */
export type DbConfigShape<L> = DbConnection & {
	readonly login: L
	/**
	 * The login's base's committed migrations/<schema>/snapshot.json, as the JSON value an import of it yields: what
	 * every Db's admission compares the catalog with, and what the login's workloads' access is checked against when
	 * the layer is built. None is ever derived from the schema alone.
	 */
	readonly snapshot: { readonly fingerprint: string }
	/**
	 * Called once with each session pool the layer builds, when it is built: the platform's hook for idle connections
	 * (on Vercel, `attachPool: attachDatabasePool`). Without it, nothing is attached.
	 */
	readonly attachPool?: (pool: ConnectionPool) => void
} & VerifyOf<L>

/**
 * DbLayer.make; packages/grizzle/src/adapter/public/layer.ts implements it. The config is parsed where it is given: one
 * no connection can use (an empty host, a port outside 1 to 65535, an empty CA bundle) fails the layer with
 * OpenError{stage: "config"}. Building the layer compiles every program of the login's workloads, once, for every role
 * it runs on, and checks their access against the snapshot: a snapshot that does not parse, a program that does not
 * compile, or a workload whose access is not the snapshot's fails the layer with OpenError{stage: "schema"}.
 */
export interface DbLayerConstructor {
	make<const L extends AnyLogin>(config: DbConfigShape<L>): Layer.Layer<DbLayerOf<L>, OpenError>
}
