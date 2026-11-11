import type { Effect, Layer, Redacted } from "effect"
import type { OpenError } from "#adapter/errors/execution.ts"
import type { CredentialError, TokenError } from "#adapter/errors/failures.ts"
import type { PgDriver, PgSocket } from "#adapter/types/driver.ts"
import type {
	AnyLogin,
	AnyRole,
	Invariant,
	LoginReadsContext,
	LoginRole,
	Phantom,
	RolesOf,
	phantom
} from "#compiler/plan/common.ts"
import type { ServedFile } from "#compiler/plan/serve.ts"

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
 * driver, the transport, the database and its installation's role prefix, the password, and the connect timeout.
 */
export interface DbConnection {
	/** node-postgres, as the caller imports it (`import pg from "pg"`): grizzle imports no driver itself. */
	readonly driver: PgDriver
	readonly transport: Transport
	readonly database: string
	/**
	 * The installation's role prefix: every login's and role's PostgreSQL role is `<rolePrefix>__<role>` (roleNameOf),
	 * so two installations of one schema share a cluster, each in its own database under its own prefix. A declared
	 * name, installed as its conversion; without it, each role is the name `grizzle generate` committed.
	 */
	readonly rolePrefix?: string
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
	/**
	 * The sessions kept open once opened, however long they stay idle: an integer from 0 to `max`. It opens none ahead:
	 * a session is opened only when a lease asks for one.
	 */
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
 * A role of a served login, reached through it by name, `Ledger.roles.member`: what Db.open takes. It names its login's
 * base and the login by their declared names, and itself by its name in the login, the key its layer is provided under
 * and the role the layer serves; R, the role, and P, the programs of the login's workloads a Db of it runs, are a
 * phantom no runtime value holds, so its Db is typed exactly as the login's type states and nothing of the schema is
 * evaluated. Only served(...) builds one.
 */
export interface ServedRole<R, P> extends Phantom<{
	readonly role: Invariant<R>
	readonly workload: Invariant<P>
}> {
	readonly kind: "servedRole"
	readonly base: string
	readonly login: string
	readonly role: string
}

/** The roles of a served login of L by name, each reached through it with the programs its Dbs run (LoginRole). */
export type ServedRoles<L> = L extends { readonly roles: infer Rs }
	? {
			readonly [K in keyof Rs]: Rs[K] extends LoginRole<infer R extends AnyRole, infer P>
				? ServedRole<R, P>
				: never
		}
	: never

/**
 * A login's served workload, the file `grizzle generate` committed as `migrations/<schema>/served/<login>.json`, read
 * once by served(file, name), under the login type L it serves: its name, L's, its base's, and its roles, the tokens
 * Db.open takes. Nothing of it is loaded until DbLayer.make builds the layer over it, and no schema module is
 * evaluated: L is a type alone. Only served(...) builds one.
 */
export interface ServedLogin<L> extends Phantom<{ readonly login: Invariant<L> }> {
	readonly kind: "servedLogin"
	readonly name: string
	/** The declared name of the level the login is over, as its file names it: its layer's key, with the name. */
	readonly base: string
	readonly roles: ServedRoles<L>
	/** The file, read once by served(...) (served/json.ts servedFile); DbLayer.make loads it. */
	readonly file: ServedFile
}

/**
 * The config of a layer compiled in-process (pool/registry.ts compiledDbLayer): a connection for the login value L and
 * its snapshot. Only the tests still on that path build one; the deletion commit removes it.
 */
export type CompiledDbConfigShape<L> = DbConnection & {
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
 * DbLayer.make's config: a connection for the login L, whose PostgreSQL login role is the one its served file names
 * (roleNameOf), fixed for the connection's lifetime, and the login's served workload, the one thing the layer reads of
 * the login.
 */
export type DbConfigShape<L> = DbConnection & {
	readonly login: ServedLogin<L>
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
 * OpenError{stage: "config"}, as does a served file of another login than the name served(...) was given.
 * Building the layer reads the served file once and rebuilds what runs each of its programs (codecs, readers,
 * decoders, the refusal classifier and the prologue); it compiles nothing and evaluates no schema. L is read off the
 * served login alone, and the rest of the config is checked against it (NoInfer), so a setting left out or mistyped is
 * named where it is, never as a login of another type.
 */
export interface DbLayerConstructor {
	make<const L extends AnyLogin>(
		config: DbConfigShape<NoInfer<L>> & { readonly login: ServedLogin<L> }
	): Layer.Layer<DbLayerOf<L>, OpenError>
}

/** served(file, name), building a ServedLogin of L from its committed file and L's name. */
export type ServedConstructor = <L extends AnyLogin>(
	file: unknown,
	name: NoInfer<L["name"]>
) => ServedLogin<L>
