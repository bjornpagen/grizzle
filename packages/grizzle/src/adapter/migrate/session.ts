import { type Array as Arr, Effect, Result, type Scope } from "effect"
import {
	type BatchFailure,
	type CatalogRowRefused,
	ConnectionLost,
	type DriverFailure,
	type InputTooLarge,
	type ServerError
} from "#adapter/errors/failures.ts"

import {
	ConnectRefused,
	type ConnectTarget,
	type MigrateError,
	type StatementFailure,
	stopped
} from "#adapter/migrate/errors.ts"

import {
	type Alongside,
	type ApartAnswer,
	type ApartFailure,
	type BatchOutcome,
	type BatchStatement,
	runAlongside,
	runApart,
	runTransaction,
	type SecondFlight,
	type Transaction,
	type Uncommitting
} from "#adapter/wire/batch.ts"

import type { ParsedConnection, ParsedTransport } from "#adapter/connection/config.ts"
import { connectSession, type Session } from "#adapter/wire/session.ts"
import { type CatalogQuery, catalogRow, catalogRows } from "#adapter/wire/statement.ts"
import { servedSession } from "#compiler/plan/common.ts"
import type { InstallationNames } from "#compiler/plan/migration.ts"

/**
 * The migration identity's session.
 *
 * `grizzle migrate` runs as the migration identity, which owns the schema. It is no login of the application: it has
 * none of the logins' fixed defaults and enters no role, so it does not go through the pool. It opens one session over
 * the connection's driver and transport, with the adapter's verify-full TLS and per-attempt password over the network
 * or the operating-system account over a Unix socket, waiting for the
 * server's own answer with no connect timeout (../wire/session.ts), holds it for the whole apply, and sends every step itself. A step is a list of
 * statements sent together, in one flight (../wire/batch.ts): every statement of it is written before any answer is
 * read, so no statement of a step can wait on another's answer, and the session sends nothing else. A step is
 * statements apart, each its own implicit transaction (`apart`); statements apart in front of one transaction that
 * commits nothing, the drift check's, which is two steps, the second made of the first's answers (`alongside`); or a
 * transactional file's transaction, its statements and ledger rows ending with COMMIT (`transaction`). Statements are unnamed: a migration statement runs once. Nothing sets statement_timeout or
 * lock_timeout; an interruption cancels the flight in flight until the server has stopped it (../wire/batch.ts abandon),
 * so an open transaction has rolled back once it ends, and the session is never used again. A step longer than one write carries is refused before any byte of it is written, as
 * InputTooLarge (../wire/batch.ts send): nothing of it ran.
 */
export interface MigrationSession {
	/**
	 * What the session's installation names a statement's variables (compiler/deploy/render/variables.ts): the database it is
	 * connected to and the role space of its connection.
	 */
	readonly installation: InstallationNames
	/**
	 * One step of statements apart, each its own implicit transaction: each answers its outcome or the server's refusal
	 * of it, in order.
	 */
	readonly apart: (
		statements: Arr.NonEmptyReadonlyArray<BatchStatement>
	) => Effect.Effect<ReadonlyArray<ApartAnswer>, ApartFailure>
	/**
	 * Statements apart in front of one transaction that commits nothing, over two flights (batch.ts runAlongside): the
	 * statements apart and the transaction's `first`, then the statements `then` makes of their answers and the
	 * transaction's end; the answers of all of them.
	 */
	readonly alongside: <A, E>(
		apart: ReadonlyArray<BatchStatement>,
		first: ReadonlyArray<BatchStatement>,
		then: (
			apart: ReadonlyArray<ApartAnswer>,
			first: ReadonlyArray<BatchOutcome>
		) => Result.Result<SecondFlight<A>, E>,
		transaction: Uncommitting
	) => Effect.Effect<Alongside<A, E>, ConnectionLost | DriverFailure | InputTooLarge>
	/**
	 * One step of statements in one transaction that ends with COMMIT: a transactional file with its ledger rows, or a
	 * ledger record alone.
	 */
	readonly transaction: (
		statements: ReadonlyArray<BatchStatement>
	) => Effect.Effect<void, BatchFailure | InputTooLarge>
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
const fileTransaction: Transaction = {
	access: "readWrite",
	isolation: "serializable",
	end: "COMMIT"
}

/** The migration identity's view of a session it holds for the scope, connected into `installation`'s database. */
export const migrationSession = (
	session: Session,
	installation: InstallationNames
): MigrationSession => ({
	installation,
	apart: (statements) => runApart(session, statements),
	alongside: (apart, first, then, transaction) =>
		runAlongside(session, apart, first, then, transaction),
	transaction: (statements) => Effect.asVoid(runTransaction(session, statements, fileTransaction))
})

/**
 * Where the migration identity connects: a connection parsed (connection/config.ts), and the role it logs in as. The
 * command line reads it from its configuration.
 */
export interface MigrationConnection extends ParsedConnection {
	readonly role: string
}

/** What a migration connection's installation names a statement's variables: its database, and its role space. */
export const connectionInstallation = (connection: MigrationConnection): InstallationNames => ({
	database: connection.database,
	roles: connection.roles
})

/** The server a parsed transport reaches for, as a refusal names it (errors.ts ConnectTarget). */
const targetOf = (transport: ParsedTransport): ConnectTarget => {
	switch (transport.kind) {
		case "sslRequest":
			return { kind: "sslRequest", host: transport.host, port: transport.port }
		case "unixSocket":
			return { kind: "unixSocket", directory: transport.directory, port: transport.port }
	}
}

/**
 * Opens the migration identity's session, closed with the scope. A connection failure is a MigrateError whose reason,
 * ConnectRefused, carries the connection attempt's refusal (failures.ts ConnectRefusal), whose message states that
 * class, never the password.
 */
export const openMigrationSession = (
	spec: MigrationConnection
): Effect.Effect<MigrationSession, MigrateError, Scope.Scope> =>
	Effect.mapBoth(connectSession({ ...spec, controls: servedSession }), {
		onFailure: (refusal) =>
			stopped(
				new ConnectRefused({
					role: spec.role,
					target: targetOf(spec.transport),
					refusal
				})
			),
		onSuccess: (session) => migrationSession(session, connectionInstallation(spec))
	})
