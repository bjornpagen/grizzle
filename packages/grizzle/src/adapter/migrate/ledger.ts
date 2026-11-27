import { Array as Arr, Result } from "effect"
import { toResult } from "#adapter/engine.ts"
import {
	LedgerDamaged,
	LedgerUncompiled,
	LedgerUnread,
	type MigrateError,
	stopped
} from "#adapter/migrate/errors.ts"
import type { ParsedFile, ParsedFolder } from "#adapter/migrate/input.ts"
import { apartRow } from "#adapter/migrate/session.ts"
import { type ApartAnswer, type BatchStatement, oneShotStatement } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { C } from "#compiler/plan/catalog.ts"
import {
	emitCatalog,
	type OutputRows,
	type OutputText,
	type ParamText,
	rowText,
	SchemaFingerprint
} from "#compiler/plan/common.ts"
import type { Redraft } from "#compiler/plan/migration.ts"
import { countParam, textParam } from "#compiler/plan/read.ts"
import {
	emptyFingerprint,
	type LedgerRow,
	type LedgerState,
	ledgerState,
	type LedgerStatements,
	ledgerStatements,
	ledgerTableName
} from "#compiler/plan/serve.ts"

const relations = C.from("pg_class", "c")
const namespaces = C.from("pg_namespace", "n")

/**
 * One row, the number of tables of the schema $1 named $2, the ledger's or the drift check's proofs': 0 before the
 * migration that creates it, else 1.
 */
export const tableExists: CatalogQuery<boolean> = {
	sql: emitCatalog(
		C.query(
			[C.asText(C.countStar)],
			[C.inNamespace(relations.item, namespaces, relations.col("relnamespace"))],
			C.and([
				C.eq(namespaces.col("nspname"), C.param(1, "text")),
				C.eq(relations.col("relname"), C.param(2, "name")),
				C.eq(relations.col("relkind"), C.letter("r"))
			])
		)
	),
	what: "a table count of 0 or 1",
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
 * The statements are ledger/ledger.ts's, emitted like every other text: the rows, the folder and file records, each a
 * parameterized INSERT whose parameters are text, and a redraft's re-record, a parameterized UPDATE.
 *
 * The ledger is read in two steps: whether its table exists, a catalog read sent with the rest of its step
 * (ledgerExistsRead), then, only where the catalog holds it, its rows (ledgerRowsRead). No statement names a ledger the
 * catalog does not hold, so a schema's first migration meets no refusal of a missing relation (42P01, or 3F000 before
 * the schema exists) and its server logs none: an absent ledger is the catalog's answer (LedgerRead `absent`), never a
 * refusal read as one.
 */
export const statementsFor = (schema: string): Result.Result<LedgerStatements, MigrateError> =>
	Result.mapError(toResult(ledgerStatements(schema)), (error) =>
		stopped(new LedgerUncompiled({ schema, error }))
	)

/**
 * A row of the rows statement, converted: the ledger is grizzle's own table, written only by the apply runner's
 * records, so each text is the one a record wrote and each integer PostgreSQL's output of the one it wrote.
 */
const ledgerRowOf = (row: ReadonlyArray<OutputText>): LedgerRow => ({
	folder: rowText(row, 0),
	ordinal: Number(rowText(row, 1)),
	file: rowText(row, 2),
	source: SchemaFingerprint(rowText(row, 3)),
	target: SchemaFingerprint(rowText(row, 4)),
	files: Number(rowText(row, 5)),
	digest: rowText(row, 6)
})

/**
 * The ledger's state from the rows statement's rows exactly as the server sent them. The one reading of the ledger's
 * rows: the apply runner's and the drift check's (installedLedger). Rows that are damage no apply leaves behind
 * (ledgerState) are refused.
 */
const ledgerOfRows = (
	schema: string,
	rows: OutputRows
): Result.Result<LedgerState, LedgerDamaged> =>
	Result.mapError(
		toResult(ledgerState(Arr.map(rows, ledgerRowOf), emptyFingerprint(schema))),
		(error) => new LedgerDamaged({ schema, error })
	)

/** The catalog read of whether a schema's ledger table exists (see the header). */
export const ledgerExistsRead = (schema: string): BatchStatement =>
	oneShotStatement(tableExists.sql, [textParam(schema), textParam(ledgerTableName)])

/** The read of a schema's ledger rows, sent only where its catalog read found the table (see the header). */
export const ledgerRowsRead = (statements: LedgerStatements): BatchStatement =>
	oneShotStatement(statements.rows.text, [])

/**
 * A schema's ledger as the apply reads it: absent before the schema's first migration, the database holding the
 * schema's empty snapshot (snapshot/build.ts emptyFingerprint); or installed, with the state its rows record.
 */
export type LedgerRead =
	| { readonly kind: "absent" }
	| { readonly kind: "installed"; readonly state: LedgerState }

/** Whether a schema's ledger table exists, from its catalog read's answer (ledgerExistsRead). */
export const ledgerPresence = (
	schema: string,
	exists: ApartAnswer
): Result.Result<LedgerRead["kind"], LedgerUnread> =>
	Result.mapBoth(apartRow(tableExists, exists), {
		onFailure: (failure) => new LedgerUnread({ schema, failure }),
		onSuccess: (present) => (present ? "installed" : "absent")
	})

/** An installed ledger from its rows read's answer (ledgerRowsRead); rows that are damage are refused (ledgerOfRows). */
export const installedLedger = (
	schema: string,
	rows: ApartAnswer
): Result.Result<LedgerRead, LedgerUnread | LedgerDamaged> =>
	Result.isFailure(rows)
		? Result.fail(new LedgerUnread({ schema, failure: rows.failure }))
		: Result.map(ledgerOfRows(schema, rows.success.rows), (state): LedgerRead => ({
				kind: "installed",
				state
			}))

/** The state a ledger read records: its rows', or, absent, the schema's empty snapshot's, no folder recorded. */
export const ledgerStateOf = (schema: string, read: LedgerRead): LedgerState => {
	switch (read.kind) {
		case "absent":
			return { latest: emptyFingerprint(schema), complete: [], partial: undefined }
		case "installed":
			return read.state
	}
}

/** The folder row, if absent: $1 folder, $2 source, $3 target, $4 files, $5 digest of meta.json. */
export const folderParams = (folder: ParsedFolder): ReadonlyArray<ParamText> => [
	textParam(folder.name),
	textParam(folder.meta.source),
	textParam(folder.meta.target),
	countParam(folder.files.length),
	textParam(folder.metaDigest)
]

/**
 * A folder's rows re-recorded under its redraft `record` (decide.ts Redraft): $1 folder, $2 the redraft's target, $3
 * the digest of its meta.json.
 */
export const redraftParams = (folder: ParsedFolder, record: Redraft): ReadonlyArray<ParamText> => [
	textParam(folder.name),
	textParam(record.target),
	textParam(record.meta)
]

/**
 * The ledger's head as the transaction recording the row of `ordinal` of `folder` leaves it (LedgerStatements
 * `recordHead`): $1 folder, $2 its target, $3 the ordinal, $4 its file count, so its folder is complete exactly when the
 * ordinal recorded is its last file's, or is the folder row's of a folder of no file.
 */
export const headParams = (folder: ParsedFolder, ordinal: number): ReadonlyArray<ParamText> => [
	textParam(folder.name),
	textParam(folder.meta.target),
	countParam(ordinal),
	countParam(folder.files.length)
]

/** A file's row: $1 folder, $2 ordinal, $3 file, $4 source, $5 target, $6 files, $7 digest of the applied text. */
export const fileParams = (folder: ParsedFolder, file: ParsedFile): ReadonlyArray<ParamText> => [
	textParam(folder.name),
	countParam(file.ordinal),
	textParam(file.name),
	textParam(folder.meta.source),
	textParam(folder.meta.target),
	countParam(folder.files.length),
	textParam(file.digest)
]
