import { Effect, Record as Rec, Redacted, type Scope } from "effect"
import type { CredentialError } from "#adapter/errors/failures.ts"
import type { BatchFailure } from "#adapter/errors/failures.ts"
import { type AcquisitionBudgets, acquisitionBudgets } from "#adapter/pool/budgets.ts"
import type { ConnectionPool } from "#adapter/types/layer.ts"
import { runAlone } from "#adapter/wire/batch.ts"
import { makePool, type Session, type SessionPool, type Transport } from "#adapter/wire/session.ts"
import { poolBounds } from "#compiler/core/policy.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { pgPin } from "#test/support/env.ts"
import type { SqlError } from "#test/support/pg.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Shared helpers for the adapter tests (test/pg/adapter).
 *
 * A login here is what an installation's migration makes of a login: a role `<schema>__<name>` that logs in, whose role
 * defaults pin jit = off, the four locale categories at C.UTF-8 and extra_float_digits = 1.
 *
 * The settings an installation stores as role defaults for every login, and their values.
 */
export const roleDefaultParameters = [
	"jit",
	"lc_monetary",
	"lc_numeric",
	"lc_time",
	"lc_messages",
	"extra_float_digits"
] as const
export type RoleDefault = (typeof roleDefaultParameters)[number]

export const roleDefaults: { readonly [P in RoleDefault]: string } = {
	jit: "off",
	lc_monetary: "C.UTF-8",
	lc_numeric: "C.UTF-8",
	lc_time: "C.UTF-8",
	lc_messages: "C.UTF-8",
	extra_float_digits: "1"
}

/**
 * Creates the login `<schema>__<name>` with a random password and the given role defaults (an installed login's by
 * default).
 */
export const substrateLogin = (
	schema: string,
	name: string,
	defaults: Readonly<Record<string, string>>
): Effect.Effect<Credentials, SqlError, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const credentials = yield* s.role(schema, name)
		for (const [setting, value] of Rec.toEntries(defaults)) {
			yield* s.admin.query(
				`ALTER ROLE ${quoteIdent(credentials.role)} SET ${setting} = ${quoteString(value)}`,
				[]
			)
		}
		return credentials
	})

export interface PoolOptions {
	readonly host: string
	/** The CA bundle the sessions verify the server's certificate against: the cluster's own CA, or another bundle. */
	readonly ca: { readonly kind: "cluster" } | { readonly kind: "given"; readonly pem: string }
	/** The name the server's certificate must carry: the host connected to, or an override (a tunnel's name). */
	readonly servername:
		| { readonly kind: "host" }
		| { readonly kind: "given"; readonly servername: string }
	/**
	 * What the pool's sessions send as their password: the credentials' own, or another (a rotating Effect, a wrong one).
	 */
	readonly password:
		| { readonly kind: "credentials" }
		| {
				readonly kind: "given"
				readonly password: Redacted.Redacted | Effect.Effect<Redacted.Redacted, CredentialError>
		  }
	readonly pool: { readonly idleTimeoutMs: number; readonly min: 1; readonly max: number }
	readonly budgets: AcquisitionBudgets
	/**
	 * The platform's pool hook (DbConfig.attachPool): nothing, or Vercel's attachDatabasePool in the serverless suite.
	 */
	readonly attachPool: (pool: ConnectionPool) => void
	/**
	 * How the sessions reach the server: verify-full TLS from `ca` and `servername`, or a transport a test supplies (a tap,
	 * a fake server).
	 */
	readonly transport:
		| { readonly kind: "tls" }
		| { readonly kind: "given"; readonly transport: Transport }
}

/**
 * The adapter's own pool for the local cluster: the cluster's CA certificate for the local host, the credentials'
 * password, production's pool bounds, the default acquisition budgets. A test spreads it and overrides
 * what it means.
 */
export const defaultPool: PoolOptions = {
	host: pgPin.host,
	ca: { kind: "cluster" },
	servername: { kind: "host" },
	password: { kind: "credentials" },
	pool: poolBounds,
	budgets: acquisitionBudgets,
	attachPool: () => undefined,
	transport: { kind: "tls" }
}

/** A session pool for `credentials` in this file's database at `port`, closed with the scope. */
const poolAt = (
	credentials: Credentials,
	port: number,
	options: PoolOptions
): Effect.Effect<SessionPool, never, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const pool = yield* makePool({
			connection: {
				host: options.host,
				port,
				database: s.database,
				role: credentials.role,
				password:
					options.password.kind === "credentials" ? credentials.password : options.password.password
			},
			transport:
				options.transport.kind === "given"
					? options.transport.transport
					: {
							_tag: "tls",
							tls: {
								ca: options.ca.kind === "cluster" ? s.cluster.caPem : options.ca.pem,
								servername:
									options.servername.kind === "host" ? options.host : options.servername.servername
							}
						},
			pool: options.pool,
			budgets: options.budgets,
			attachPool: options.attachPool
		})
		return pool
	})

/**
 * A session pool for `credentials` in this file's database, reaching the server through the substrate's target, closed
 * with the scope.
 */
export const poolFor = (
	credentials: Credentials,
	options: PoolOptions
): Effect.Effect<SessionPool, never, Substrate | Scope.Scope> =>
	Effect.flatMap(Substrate, () => poolAt(credentials, pgPin.port, options))

/** A pool aimed at a local fake server, not at PostgreSQL: the one endpoint a test names by its port. */
export const fakeServerPool = (
	credentials: Credentials,
	port: number
): Effect.Effect<SessionPool, never, Substrate | Scope.Scope> =>
	poolAt(credentials, port, defaultPool)

/** The rows of one statement sent alone on `session`, parameters as their texts. */
export const rowsOn = (
	session: Session,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, BatchFailure> =>
	Effect.map(runAlone(session, { sql, params }), (outcome) => outcome.rows)

/** The backend a session runs on, as pg_backend_pid() reports it. */
export const backendPidOf = (session: Session): Effect.Effect<number, BatchFailure> =>
	Effect.map(rowsOn(session, "SELECT pg_catalog.pg_backend_pid()::text", []), (rows) =>
		Number(rows[0]?.[0])
	)

/** A password Effect over a mutable secret, counting its evaluations. */
export const countingPassword = (initial: string) => {
	const state = { secret: initial, evaluations: 0 }
	const password = Effect.sync(() => {
		state.evaluations += 1
		return Redacted.make(state.secret)
	})
	return { state, password }
}

/**
 * Polls `check` until it holds, yielding between polls and never reading a clock: the verdict waits on the fact, and
 * a wait that never ends is the test runner's hung test, never a verdict of the suite. A comment at each call names
 * the fact.
 */
export const until = <E, R>(check: Effect.Effect<boolean, E, R>): Effect.Effect<void, E, R> =>
	Effect.gen(function* () {
		for (;;) {
			if (yield* check) {
				return
			}
			yield* Effect.yieldNow
		}
	})

/** The state of backend `pid` in pg_stat_activity, or "gone". */
export const backendState = (pid: number) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const rows = yield* s.admin.queryValues(
			"SELECT state::text, wait_event::text FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
			[pid]
		)
		const row = rows[0]
		return row === undefined
			? { state: "gone", waitEvent: "" }
			: { state: String(row[0]), waitEvent: String(row[1]) }
	})
