import { type Array as Arr, Effect, Result, type Scope } from "effect"
import {
	type BatchFailure,
	type CatalogRowRefused,
	ConnectionLost,
	type DriverFailure,
	type ServerError
} from "#adapter/errors/failures.ts"

import {
	ConnectRefused,
	type MigrateError,
	type StatementFailure,
	stopped
} from "#adapter/migrate/errors.ts"

import {
	type Alongside,
	type ApartAnswer,
	type ApartFailure,
	type BatchStatement,
	type FlightStatement,
	runAlongside,
	runApart,
	runTransaction,
	type Transaction
} from "#adapter/wire/batch.ts"

import {
	connectSession,
	type Password,
	type Session,
	type TlsConfig
} from "#adapter/wire/session.ts"
import { type CatalogQuery, catalogRow, catalogRows } from "#adapter/wire/statement.ts"

/**
 * The migration identity's session.
 *
 * `grizzle migrate` runs as the migration identity, which owns the schema. It is no login of the application: it has
 * none of the logins' fixed defaults and enters no role, so it does not go through the pool. It opens one session with the
 * adapter's verify-full TLS and per-attempt password (../wire/session.ts), holds it for the whole apply, and sends
 * every step itself. A step is a list of statements sent together, in one flight (../wire/batch.ts): every statement
 * of it is written before any answer is read, so no statement of a step can wait on another's answer, and the session
 * sends nothing else. A step is statements apart, each its own implicit transaction (`apart`); statements apart in
 * front of one transaction (`alongside`); or a transactional file's transaction, its statements and ledger rows ending
 * with COMMIT (`transaction`). Statements are unnamed: a migration statement runs once. Nothing sets
 * statement_timeout or lock_timeout; interruption cancels the flight in flight and the
 * session is closed, which rolls an open transaction back.
 */
export interface MigrationSession {
	/**
	 * One step of statements apart, each its own implicit transaction: each answers its outcome or the server's refusal
	 * of it, in order.
	 */
	readonly apart: (
		statements: Arr.NonEmptyReadonlyArray<BatchStatement>
	) => Effect.Effect<ReadonlyArray<ApartAnswer>, ApartFailure>
	/** One step of statements apart in front of one transaction (batch.ts runAlongside): the answers of both. */
	readonly alongside: (
		apart: ReadonlyArray<BatchStatement>,
		statements: ReadonlyArray<FlightStatement>,
		transaction: Transaction
	) => Effect.Effect<Alongside, ConnectionLost | DriverFailure>
	/**
	 * One step of statements in one transaction that ends with COMMIT: a transactional file with its ledger rows, or a
	 * ledger record alone.
	 */
	readonly transaction: (
		statements: ReadonlyArray<BatchStatement>
	) => Effect.Effect<void, BatchFailure>
}

/** The rows of a statement apart, each parsed by its query: its refusal, or a row the query refuses, fails. */
export const apartRows = <Row>(
	query: CatalogQuery<Row>,
	answer: ApartAnswer
): Result.Result<ReadonlyArray<Row>, ServerError | CatalogRowRefused> =>
	Result.flatMap(answer, (outcome) => catalogRows(query, outcome.rows))

/** The one row of a statement apart that answers exactly one, parsed by its query. */
export const apartRow = <Row>(
	query: CatalogQuery<Row>,
	answer: ApartAnswer
): Result.Result<Row, ServerError | CatalogRowRefused> =>
	Result.flatMap(answer, (outcome) => catalogRow(query, outcome.rows))

/**
 * A transaction's failure as one statement's: the server's refusal of the statement or COMMIT that decided it, or the
 * session's failure; a COMMIT whose answer never came is the connection lost.
 */
export const decidingFailure = (failure: BatchFailure): StatementFailure => {
	switch (failure._tag) {
		case "BatchRefused":
		case "StaleName":
		case "CommitRefused":
			return failure.failure
		case "CommitLost":
			return new ConnectionLost({ operation: "commit", ended: { by: "transport" } })
		case "ConnectionLost":
		case "DriverFailure":
		case "UnreadableAnswer":
			return failure
	}
}

/** A transactional file's transaction. */
const fileTransaction: Transaction = { access: "readWrite", end: "COMMIT" }

/** The migration identity's view of a session it holds for the scope. */
export const migrationSession = (session: Session): MigrationSession => ({
	apart: (statements) => runApart(session, statements),
	alongside: (apart, statements, transaction) =>
		runAlongside(session, apart, statements, transaction),
	transaction: (statements) => Effect.asVoid(runTransaction(session, statements, fileTransaction))
})

/**
 * Where the migration identity connects: the destination, the role, its password and TLS. The
 * command line reads it from its configuration.
 */
export interface MigrationConnection {
	readonly host: string
	readonly port: number
	readonly database: string
	readonly role: string
	readonly password: Password
	readonly tls: TlsConfig
}

export const applicationName = "grizzle migrate"

/**
 * Opens the migration identity's session, closed with the scope. A connection failure is a MigrateError whose reason,
 * ConnectRefused, carries the connection attempt's refusal (failures.ts ConnectRefusal), whose message states that
 * class, never the password.
 */
export const openMigrationSession = (
	spec: MigrationConnection
): Effect.Effect<MigrationSession, MigrateError, Scope.Scope> =>
	Effect.mapBoth(
		connectSession({
			host: spec.host,
			port: spec.port,
			database: spec.database,
			role: spec.role,
			password: spec.password,
			transport: { _tag: "tls", tls: spec.tls },
			applicationName
		}),
		{
			onFailure: (refusal) =>
				stopped(new ConnectRefused({ role: spec.role, host: spec.host, port: spec.port, refusal })),
			onSuccess: migrationSession
		}
	)
