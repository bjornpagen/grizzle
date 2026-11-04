import { Array as Arr, Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import {
	LedgerDamaged,
	LedgerUncompiled,
	LedgerUnread,
	type MigrateError,
	type StatementFailure,
	stopped
} from "#adapter/migrate/errors.ts"
import type { ParsedFile, ParsedFolder } from "#adapter/migrate/input.ts"
import { apartRow } from "#adapter/migrate/session.ts"
import type { ApartAnswer, BatchStatement } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { rowText } from "#compiler/core/decoder.ts"
import { SchemaFingerprint } from "#compiler/core/ids.ts"
import {
	type LedgerRow,
	type LedgerState,
	type LedgerStatements,
	ledgerState,
	ledgerStatements
} from "#compiler/deploy/ledger/ledger.ts"
import { emptyFingerprint } from "#compiler/deploy/snapshot/build.ts"
import { ledgerTableName } from "#compiler/physical/ddl/ledger.ts"
import * as C from "#compiler/sql/catalog.ts"
import { emitCatalog } from "#compiler/sql/emit.ts"

const relations = C.from("pg_class", "c")
const namespaces = C.from("pg_namespace", "n")

/** One row, the number of ledger tables of the schema $1, named $2: 0 before its first migration, else 1. */
const ledgerExists: CatalogQuery<boolean> = {
	sql: emitCatalog(
		C.query(
			[C.asText(C.countStar)],
			[
				C.join(
					relations.item,
					namespaces.item,
					C.eq(namespaces.col("oid"), relations.col("relnamespace"))
				)
			],
			C.and([
				C.eq(namespaces.col("nspname"), C.param(1, "text")),
				C.eq(relations.col("relname"), C.param(2, "name")),
				C.eq(relations.col("relkind"), C.letter("r"))
			])
		)
	),
	what: "a ledger table count of 0 or 1",
	row: ([count]) => (count === "1" ? true : count === "0" ? false : undefined)
}

/**
 * Reading and writing a schema's `__migrations` ledger from the apply runner.
 *
 * Bootstrap. Before its first migration a schema has no ledger, and the database holds the schema's empty snapshot,
 * whose fingerprint depends on the schema identifier alone (snapshot/build.ts emptyFingerprint). The
 * runner reads an absent ledger as exactly that state: no folder recorded, latest target the empty snapshot. The
 * first migration's Setup file creates the schema and then the ledger, so the first file's own row is inserted in
 * the transaction that created the table, after its statements, and a failure of that file rolls the schema and the
 * ledger back together, leaving the empty state to resume from. A folder whose first transaction cannot find the
 * ledger to record in (a custom migration applied before the schema exists) fails at its record with the ledger's
 * absence named, and its transaction rolls back.
 *
 * The statements are ledger/ledger.ts's, emitted like every other text: the rows, and the folder and file records,
 * each a parameterized INSERT whose parameters are text.
 *
 * The ledger is read by two statements apart, sent together with the rest of their step: whether the ledger table
 * exists, then its rows, which the server refuses when it does not (42P01, or 3F000 before the schema exists). The
 * catalog's answer decides which: the rows are read exactly when the table exists, and the refusal is read as nothing
 * only when it does not.
 */
export const statementsFor = (schema: string): Result.Result<LedgerStatements, MigrateError> =>
	Result.mapError(toResult(ledgerStatements(schema)), (error) =>
		stopped(LedgerUncompiled.make({ schema, error }))
	)

/**
 * A row of the rows statement, converted: the ledger is grizzle's own table, written only by the apply runner's
 * records, so each text is the one a record wrote and each integer PostgreSQL's output of the one it wrote.
 */
const ledgerRowOf = (row: ReadonlyArray<string>): LedgerRow => ({
	folder: rowText(row, 0),
	ordinal: Number(rowText(row, 1)),
	file: rowText(row, 2),
	source: SchemaFingerprint(rowText(row, 3)),
	target: SchemaFingerprint(rowText(row, 4)),
	files: Number(rowText(row, 5)),
	digest: rowText(row, 6)
})

/**
 * The ledger's state from the rows statement's rows exactly as the server sent them, the empty snapshot's for no rows.
 * The one reading of the ledger's rows: the apply runner's and the drift check's (ledgerOfAnswers). Rows that are damage
 * no apply leaves behind (ledgerState) are refused.
 */
const ledgerOfRows = (
	schema: string,
	rows: ReadonlyArray<ReadonlyArray<string>>
): Result.Result<LedgerState, LedgerDamaged> =>
	Result.mapError(
		toResult(ledgerState(Arr.map(rows, ledgerRowOf), emptyFingerprint(schema))),
		(error) => LedgerDamaged.make({ schema, error })
	)

/** The two statements that read a schema's ledger: whether it exists, then its rows. */
type LedgerReads = readonly [exists: BatchStatement, rows: BatchStatement]

/** The two statements that read a schema's ledger, apart (see the header). */
export const ledgerReads = (schema: string, statements: LedgerStatements): LedgerReads => [
	{ sql: ledgerExists.sql, params: [schema, ledgerTableName] },
	{ sql: statements.rows.text, params: [] }
]

/** The ledger as its two reads found it: whether its table exists, and its state, the empty snapshot's when absent. */
export interface LedgerRead {
	readonly table: "absent" | "present"
	readonly state: LedgerState
}

/**
 * The ledger from the answers of its two reads (ledgerReads): its state, the empty snapshot's when the ledger does not
 * exist yet, whatever the server answered its rows then. A ledger whose rows are damage no apply leaves behind
 * (ledgerState) is refused.
 */
export const ledgerOfAnswers = (
	schema: string,
	exists: ApartAnswer,
	rows: ApartAnswer
): Result.Result<LedgerRead, LedgerUnread | LedgerDamaged> => {
	const unread = (failure: StatementFailure) => Result.fail(LedgerUnread.make({ schema, failure }))
	const present = apartRow(ledgerExists, exists)
	if (Result.isFailure(present)) {
		return unread(present.failure)
	}
	if (present.success && Result.isFailure(rows)) {
		return unread(rows.failure)
	}
	return Result.map(
		ledgerOfRows(schema, present.success && Result.isSuccess(rows) ? rows.success.rows : []),
		(state): LedgerRead => ({ table: present.success ? "present" : "absent", state })
	)
}

/** The folder row, if absent: $1 folder, $2 source, $3 target, $4 files, $5 digest of meta.json. */
export const folderParams = (folder: ParsedFolder): ReadonlyArray<string> => [
	folder.name,
	folder.meta.source,
	folder.meta.target,
	String(folder.files.length),
	folder.metaDigest
]

/** A file's row: $1 folder, $2 ordinal, $3 file, $4 source, $5 target, $6 files, $7 digest of the applied text. */
export const fileParams = (folder: ParsedFolder, file: ParsedFile): ReadonlyArray<string> => [
	folder.name,
	String(file.ordinal),
	file.name,
	folder.meta.source,
	folder.meta.target,
	String(folder.files.length),
	file.digest
]
