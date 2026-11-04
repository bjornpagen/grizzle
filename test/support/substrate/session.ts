import { Effect, Option, type Redacted, Ref, type Scope, String as Str } from "effect"
import type { InitializedClusterShape } from "#test/support/cluster.ts"
import { pgPin } from "#test/support/env.ts"
import { type PgConnection, type RawQueryResult, type SqlError, session } from "#test/support/pg.ts"
import { TransactionRolledBack } from "#test/support/substrate/errors.ts"

/** A login role and its password. */
export interface Credentials {
	readonly role: string
	readonly password: Redacted.Redacted
}

/** A world role as a session takes it on: log in as the login that holds it, then SET ROLE to it. */
export interface SubstrateWorld {
	readonly login: Credentials
	readonly role: string
}

/** The migration identity and database owner (Rules), whose password is the initialised cluster's. */
export const ownerCredentials = (cluster: InitializedClusterShape): Credentials => ({
	role: pgPin.devRole,
	password: cluster.devPassword
})

/** The BEGIN of every transaction a direct writer runs. */
export const beginSerializable = "BEGIN ISOLATION LEVEL SERIALIZABLE"

/**
 * A level below SERIALIZABLE: only a planted writer begins at one, and grizzle's guard refuses its writes (25000).
 * PostgreSQL runs READ UNCOMMITTED as READ COMMITTED but reports it as itself.
 */
export type BelowSerializable = "read uncommitted" | "read committed" | "repeatable read"

/** The BEGIN of a planted below-SERIALIZABLE writer. */
export const beginBelowStatement = (level: BelowSerializable): string =>
	`BEGIN ISOLATION LEVEL ${Str.toUpperCase(level)}`

export interface RawSession {
	readonly label: string
	readonly role: string
	readonly database: string
	/**
	 * The server backend running this session's statements, as pg_backend_pid() reports it, read once when the session
	 * opens, so it is available while a statement is in flight. The connection's BackendKeyData is never used.
	 */
	readonly pid: Effect.Effect<number, SqlError>
	/** One statement per call, through the extended protocol; parameters are text-cast by the caller's SQL. */
	readonly query: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<RawQueryResult, SqlError>
	readonly values: (
		sql: string,
		params: ReadonlyArray<unknown>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, SqlError>
	/** BEGIN ISOLATION LEVEL SERIALIZABLE. */
	readonly begin: Effect.Effect<void, SqlError>
	/** A planted below-SERIALIZABLE BEGIN, for a writer whose writes grizzle must refuse. */
	readonly beginBelow: (level: BelowSerializable) => Effect.Effect<void, SqlError>
	/** COMMIT, failing with TransactionRolledBack when PostgreSQL answers it with ROLLBACK (an aborted transaction). */
	readonly commit: Effect.Effect<void, SqlError | TransactionRolledBack>
	readonly rollback: Effect.Effect<void, SqlError>
	/** Every statement sent through this session, BEGIN and COMMIT included, whether or not it succeeded. */
	readonly statements: Effect.Effect<number>
	readonly log: Effect.Effect<ReadonlyArray<string>>
	readonly resetStatements: Effect.Effect<void>
}

/** A substrate connection: the database, the login and the session's name in reports. */
interface SessionOptions {
	readonly database: string
	readonly credentials: Credentials
	readonly label: string
}

/**
 * A verify-full TLS connection to the cluster as `credentials.role`, the server's certificate chained to the cluster's
 * CA for the local host, closed when the scope closes.
 */
export const connect = (
	cluster: InitializedClusterShape,
	options: SessionOptions
): Effect.Effect<PgConnection, SqlError, Scope.Scope> =>
	session(cluster, {
		database: options.database,
		username: options.credentials.role,
		password: options.credentials.password,
		applicationName: Option.some(`grizzle-substrate ${options.label}`)
	})

const backendPidQuery = "SELECT pg_catalog.pg_backend_pid()"

/**
 * Raw pinned sessions: one backend each, explicit BEGIN, and a per-session statement counter.
 *
 * A raw session is a direct SQL client, not grizzle: schedules use it to play a concurrent writer, as direct SQL
 * writers need. Every transaction it begins is SERIALIZABLE, as every transaction grizzle's guard admits; a planted
 * below-SERIALIZABLE BEGIN exists only to be refused. It connects as the adapter does, over TCP with verify-full TLS and
 * a SCRAM password, through the one connection helper the TLS tests exercise (test/support/pg.ts). Statements are
 * counted by this wrapper; pg_stat_statements is not used.
 *
 * Opens a session as `credentials.role` and pins its backend until the scope closes.
 */
export const openSession = Effect.fnUntraced(function* (
	cluster: InitializedClusterShape,
	options: SessionOptions
): Effect.fn.Return<RawSession, SqlError, Scope.Scope> {
	const label = options.label
	const connection = yield* connect(cluster, options)
	const pinned = yield* connection.pin
	const log = yield* Ref.make<ReadonlyArray<string>>([])
	const record = (sql: string) => Ref.update(log, (entries) => [...entries, sql])

	const query = (sql: string, params: ReadonlyArray<unknown>) =>
		Effect.andThen(record(sql), pinned.query(sql, params))
	const values = (sql: string, params: ReadonlyArray<unknown>) =>
		Effect.andThen(record(sql), pinned.queryValues(sql, params))
	const backendPid = yield* Effect.map(pinned.queryValues(backendPidQuery, []), (rows) =>
		Number(rows[0]?.[0])
	)
	const pid = Effect.succeed(backendPid)

	return {
		label,
		role: options.credentials.role,
		database: options.database,
		pid,
		query,
		values,
		begin: Effect.asVoid(query(beginSerializable, [])),
		beginBelow: (level) => Effect.asVoid(query(beginBelowStatement(level), [])),
		commit: Effect.flatMap(query("COMMIT", []), (result) =>
			result.command === "COMMIT"
				? Effect.void
				: Effect.fail(new TransactionRolledBack({ label, command: result.command }))
		),
		rollback: Effect.asVoid(query("ROLLBACK", [])),
		statements: Effect.map(Ref.get(log), (entries) => entries.length),
		log: Ref.get(log),
		resetStatements: Ref.set(log, [])
	}
})
