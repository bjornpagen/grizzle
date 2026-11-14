import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { isNonEmpty, mapNonEmpty, type NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import type * as Result from "#compiler/core/result.ts"
import { compareCodePoints } from "#compiler/core/text.ts"
import type { PhysicalObject } from "#compiler/ir/products.ts"
import { isolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import { folderOrdinal, ledgerTableName, snapshotGuardName } from "#compiler/physical/ddl/ledger.ts"
import { namedIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDef,
	CreateTable,
	EmittedSql,
	Expr,
	Grant,
	Insert,
	LockTable,
	ObjectName,
	Revoke,
	Select,
	SqlStatement,
	Update
} from "#compiler/sql/ast.ts"

import {
	asc,
	call,
	cast,
	col,
	cUtf8Collation,
	eq,
	ge,
	lit,
	objectName,
	param,
	provedSelect,
	qualifiedCall,
	table,
	tableCol,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { emit } from "#compiler/sql/emit.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { claimsSettingName } from "#compiler/sql/print.ts"

/** The folder row's file. */
const folderFile = "meta.json"

const ledgerName = (schema: string): ObjectName => objectName(schema, ledgerTableName)

/** The graph identities of the ledger's objects in a snapshot manifest (`InstallBuilder` names the others). */
const ledgerIdent = (schema: string): string => qualifiedIdent("table", schema, ledgerTableName)
export const ledgerPrivilegesIdent = (schema: string): string =>
	namedIdent("privileges", `${schema}.${ledgerTableName}`)

const text = (name: string): ColumnDef => ({
	name,
	type: types.text,
	collation: cUtf8Collation,
	generated: undefined
})

const integer = (name: string): ColumnDef => ({
	name,
	type: types.integer,
	collation: undefined,
	generated: undefined
})

/** The ledger's columns in table order: the rows statement's columns c1 to c7. */
export const ledgerColumns = [
	"folder",
	"ordinal",
	"file",
	"source",
	"target",
	"files",
	"digest"
] as const
export type LedgerColumn = (typeof ledgerColumns)[number]

/** Each ledger column's type: a text, or an integer, which the rows statement reads as its text. */
const ledgerColumnTypes: { readonly [C in LedgerColumn]: "text" | "integer" } = {
	folder: "text",
	ordinal: "integer",
	file: "text",
	source: "text",
	target: "text",
	files: "integer",
	digest: "text"
}

/** The migrations ledger `<schema>.<ledger>` (identity.ledger).
 *
 * Each declared schema keeps its own ledger in its own PostgreSQL schema, so two declared schemas in one database each
 * keep their own snapshot and ledger. The ledger is one grizzle-owned table, every column NOT NULL with a
 * primary key, like every table:
 *
 *   CREATE TABLE "<schema>"."<ledger>" (
 *     "folder" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,   -- <timestamp>_<name>
 *     "ordinal" integer NOT NULL,                             -- 0 for the folder, NN for the file NN-<phase>.sql
 *     "file" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,     -- meta.json for the folder, else the file's name
 *     "source" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,   -- the folder's source snapshot fingerprint
 *     "target" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,   -- the folder's target snapshot fingerprint
 *     "files" integer NOT NULL,                               -- how many SQL files the folder holds
 *     "digest" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,   -- SHA-256 of the applied text
 *     CONSTRAINT "<ledger key>" PRIMARY KEY ("folder", "ordinal"),
 *     CONSTRAINT "<ledger check of ordinal>" CHECK (("ordinal" >= 0) IS TRUE),
 *     CONSTRAINT "<ledger check of files>" CHECK (("files" >= 0) IS TRUE)
 *   )
 *
 * The ledger holds a folder row (ordinal 0) plus one row per file, and a file's row is inserted inside that file's own
 * transaction, after its statements, so a file is recorded exactly when its effects committed. The folder row is
 * inserted, if absent, in the transaction of the folder's first file (ON CONFLICT DO NOTHING), or alone for a folder
 * with no file, such as an untouched custom migration. A no-transaction file runs each statement alone
 * and its row is inserted in a transaction of its own once the last statement succeeded, so a failure reruns the whole
 * file, which its drafted statements make safe. A folder is applied once every one of its files has a
 * row; the latest applied folder's target is the database's snapshot, and a folder whose source is not
 * that fingerprint fails before any statement runs.
 *
 * Every row of a folder carries the folder's facts: its source and target and its file count. A row is never deleted,
 * and only one write updates rows: a partial folder resumed under a redraft (deploy/ledger/decide.ts) takes the
 * redraft's target on every row and its meta.json's digest on the folder row, in the transaction of the file it resumes
 * at (redraftFolder), so the ledger records the redraft exactly when that file committed.
 *
 * The ledger is created by the first migration of its schema: the drafted Setup file creates the schema, the
 * SERIALIZABLE guard's function, the ledger and its guard trigger, as every table grizzle installs carries one, so the
 * first file's row, inserted at SERIALIZABLE, can be recorded in the same transaction. Before that the database holds
 * the schema's empty snapshot (`emptySnapshot`). Its PUBLIC privileges are revoked at once, and every
 * login holds SELECT on it, granted in Publish beside its other grants: the privilege LOCK ... IN ACCESS SHARE MODE
 * needs, which the fence (see `snapshotGuardDdl`) takes as the login, before any role is entered. */
export const ledgerTable = (schema: string): CreateTable => ({
	kind: "createTable",
	table: ledgerName(schema),
	columns: mapNonEmpty(ledgerColumns, (c) =>
		ledgerColumnTypes[c] === "integer" ? integer(c) : text(c)
	),
	primaryKey: {
		kind: "primaryKey",
		name: identifierOf(identity.ledgerKey()),
		columns: [
			{ column: "folder", withoutOverlaps: false },
			{ column: "ordinal", withoutOverlaps: false }
		]
	},
	secondary: [
		{
			kind: "check",
			name: identifierOf(identity.ledgerCheck("ordinal")),
			predicate: ge(tableCol("ordinal"), lit.int(0n, types.integer))
		},
		{
			kind: "check",
			name: identifierOf(identity.ledgerCheck("files")),
			predicate: ge(tableCol("files"), lit.int(0n, types.integer))
		}
	]
})

const revokePublic = (schema: string): Revoke => ({
	kind: "revoke",
	privileges: ["ALL"],
	on: { kind: "TABLE", names: [ledgerName(schema)] },
	from: [{ kind: "PUBLIC" }]
})

/** The ledger as an object of a snapshot manifest, created in Setup right after the isolation function its guard runs. */
export const ledgerObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "ledger",
	ident: ledgerIdent(schema),
	ddl: [ledgerTable(schema), revokePublic(schema)],
	reasons: [{ kind: "enforcement", of: "the migrations ledger" }],
	state: "needed",
	phase: "setup"
})

/** The ledger's guard trigger, created in Setup right after the ledger: every table grizzle installs refuses a write
 * below SERIALIZABLE. */
export const ledgerGuardObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "isolationTrigger",
	...isolationTrigger(schema, ledgerName(schema)),
	reasons: [{ kind: "enforcement", of: "the SERIALIZABLE writes of the migrations ledger" }],
	state: "needed",
	phase: "setup"
})

/** SELECT on the ledger for every login's role, in Publish, the grantees in the order given (login name order); none
 * when no login is installed. */
export const ledgerPrivilegesObject = (
	schema: string,
	roles: ReadonlyArray<string>
): PhysicalObject<SqlStatement> | undefined => {
	if (!isNonEmpty(roles)) {
		return undefined
	}
	const grant: Grant = {
		kind: "grant",
		privileges: ["SELECT"],
		on: { kind: "TABLE", names: [ledgerName(schema)] },
		to: mapNonEmpty(roles, (name) => ({ kind: "role", name }))
	}
	return {
		kind: "privileges",
		ident: ledgerPrivilegesIdent(schema),
		ddl: [grant],
		reasons: [{ kind: "enforcement", of: "the fence's lock every login takes" }],
		state: "needed",
		phase: "publish"
	}
}

/**
 * `statement`, with the ledger among the tables it publishes, whole, after its footprint tables, where it creates the
 * installation's live source's publication (physical/ddl/live.ts); any other statement as it is. Each file of a
 * migration and each folder inserts its row in its own transaction, so the leader decodes every migration applied, a
 * folder of no file among them, and ends every watch as stale. The ledger's primary key is its replica identity:
 * migrate deletes no row of it, and updates rows only to resume a folder under a redraft (redraftFolder), in the
 * transaction of a file whose row it inserts too, a change of the ledger the leader reads as a migration like any other.
 */
export const publishingLedger = (schema: string, statement: SqlStatement): SqlStatement =>
	statement.kind === "createPublication"
		? {
				...statement,
				tables: [...statement.tables, { table: ledgerName(schema), columns: { kind: "whole" } }]
			}
		: statement

/** The live source's publication `publication` with the ledger among its tables (publishingLedger). */
export const ledgerPublished = (
	schema: string,
	publication: PhysicalObject<SqlStatement>
): PhysicalObject<SqlStatement> => ({
	...publication,
	ddl: publication.ddl.map((s) => publishingLedger(schema, s))
})

const emitted = (statement: SqlStatement): EmittedSql => {
	const e = emit(statement, emptyNameMap)
	if (!e.ok) {
		throw new Refusal(e.error)
	}
	return e.value
}

const insertRow = (schema: string, ordinal: "param" | "folder", onConflict: boolean): Insert => {
	let n = 0
	const next = (type: typeof types.text) => param(++n, type)
	const values: NonEmptyReadonlyArray<Expr> =
		ordinal === "folder"
			? [
					next(types.text),
					lit.int(BigInt(folderOrdinal), types.integer),
					lit.text(folderFile, types.text),
					next(types.text),
					next(types.text),
					next(types.integer),
					next(types.text)
				]
			: [
					next(types.text),
					next(types.integer),
					next(types.text),
					next(types.text),
					next(types.text),
					next(types.integer),
					next(types.text)
				]
	return {
		kind: "insert",
		with: undefined,
		table: ledgerName(schema),
		alias: undefined,
		columns: [...ledgerColumns],
		overriding: undefined,
		source: { kind: "values", rows: [values] },
		onConflict: onConflict
			? { kind: "columns", columns: ["folder", "ordinal"], action: { kind: "doNothing" } }
			: undefined,
		returning: []
	}
}

export interface LedgerStatements {
	/** INSERT the folder row if absent: $1 folder, $2 source, $3 target, $4 files, $5 digest of meta.json. */
	readonly recordFolder: EmittedSql
	/**
	 * UPDATE the rows of a folder resumed under a redraft (deploy/ledger/decide.ts Redraft), in the transaction of the
	 * file it resumes at: every row of the folder $1 takes the redraft's target $2, and its folder row the digest $3 of
	 * the redraft's meta.json.
	 */
	readonly redraftFolder: EmittedSql
	/** INSERT a file row: $1 folder, $2 ordinal, $3 file, $4 source, $5 target, $6 files, $7 digest of the file. */
	readonly recordFile: EmittedSql
	/** Every row as its seven columns in ledgerColumns order, the integers as text, by folder and ordinal. */
	readonly rows: EmittedSql
	/** The fence a Db transaction and admission take first (see `snapshotGuardDdl`): the ledger's ACCESS SHARE lock, NOWAIT. */
	readonly fence: EmittedSql
	/** The lock a migration's transaction takes first, before any statement of its file: the ledger's ACCESS EXCLUSIVE. */
	readonly exclusive: EmittedSql
	/** Admission's check: the guard of $1, the snapshot's fingerprint. */
	readonly guard: EmittedSql
	/**
	 * A Db transaction's prologue statement, the first that takes its snapshot: the guard of $1, the Db's snapshot
	 * fingerprint, then the role $2 and the claims setting $3, both local to the transaction.
	 */
	readonly enter: EmittedSql
}

const ledgerLock = (
	schema: string,
	mode: LockTable["mode"],
	wait: LockTable["wait"]
): LockTable => ({
	kind: "lockTable",
	tables: [ledgerName(schema)],
	mode,
	wait
})

/** The rows of the folder $1 re-recorded under a redraft (LedgerStatements.redraftFolder). */
const redraftUpdate = (schema: string): Update => {
	const r1 = "r1"
	return {
		kind: "update",
		with: undefined,
		table: ledgerName(schema),
		alias: r1,
		set: [
			{ column: "target", value: param(2, types.text) },
			{
				column: "digest",
				value: {
					kind: "case",
					operand: undefined,
					whens: [
						{
							when: eq(col(r1, "ordinal"), lit.int(BigInt(folderOrdinal), types.integer)),
							result: param(3, types.text)
						}
					],
					else: col(r1, "digest")
				}
			}
		],
		from: [],
		where: eq(col(r1, "folder"), param(1, types.text)),
		returning: []
	}
}

/** The guard of the fingerprint at `$1`. */
const guardCall = (schema: string): Expr =>
	qualifiedCall(schema, snapshotGuardName, [param(1, types.text)])

/** A setting local to the transaction, `set_config('<name>', $n, true)`. */
const localSetting = (name: string, index: number): Expr =>
	call("set_config", [lit.text(name, types.text), param(index, types.text), lit.bool(true)])

/** The statements the apply runner, admission and every Db transaction run against a schema's ledger, emitted like
 * every other text. */
export const ledgerStatements = (schema: string): Result.Result<LedgerStatements, CompileError> =>
	catchRefusal(() => {
		const name = ledgerName(schema)
		const r1 = "r1"
		const rows: Select = {
			...provedSelect(
				"keyed",
				ledgerColumns.map((c, i) =>
					targetAs(
						ledgerColumnTypes[c] === "integer" ? cast(col(r1, c), types.text) : col(r1, c),
						`c${i + 1}`
					)
				),
				[table(name.schema, name.name, r1)],
				undefined
			),
			orderBy: [asc(col(r1, "folder")), asc(col(r1, "ordinal"))]
		}
		const enter = provedSelect(
			"oneRow",
			[
				targetAs(guardCall(schema), "c1"),
				targetAs(localSetting("role", 2), "c2"),
				targetAs(localSetting(claimsSettingName, 3), "c3")
			],
			[],
			undefined
		)
		return {
			recordFolder: emitted(insertRow(schema, "folder", true)),
			redraftFolder: emitted(redraftUpdate(schema)),
			recordFile: emitted(insertRow(schema, "param", false)),
			rows: emitted(rows),
			fence: emitted(ledgerLock(schema, "ACCESS SHARE", "nowait")),
			exclusive: emitted(ledgerLock(schema, "ACCESS EXCLUSIVE", "wait")),
			guard: emitted(provedSelect("oneRow", [targetAs(guardCall(schema), "c1")], [], undefined)),
			enter: emitted(enter)
		}
	})

/** One ledger row, as the shell converts the rows statement's row: the ledger is grizzle's own table, written only by
 * the apply runner's records, so every text is nonempty and every integer at least zero as written, and read back
 * without a check. */
export interface LedgerRow {
	readonly folder: string
	readonly ordinal: number
	readonly file: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
	readonly files: number
	readonly digest: string
}

/** A recorded file row: the SQL file of its ordinal that completed, and the digest of the text that ran. */
interface RecordedFile {
	readonly ordinal: number
	readonly file: string
	readonly digest: string
}

/** A folder the ledger records: the fingerprints and file count its folder row states, the digest of the meta.json its
 * folder row records, and its file rows by ordinal, the files that completed: what an apply compares the folder's texts
 * with, so an applied file edited afterwards is refused. */
export interface RecordedFolder {
	readonly folder: string
	readonly source: SchemaFingerprint
	readonly target: SchemaFingerprint
	readonly files: number
	readonly meta: string
	readonly completed: ReadonlyArray<RecordedFile>
}

/** The ledger as an apply reads it: the folders every file of which completed, and the one folder a failed apply left
 * with some files completed and some not, which sorts after every complete one. */
export interface LedgerState {
	/** The latest complete folder's target, or the schema's empty snapshot when no folder completed. */
	readonly latest: SchemaFingerprint
	/** In name order. */
	readonly complete: ReadonlyArray<RecordedFolder>
	/** The one a rerun resumes, none when every recorded folder completed. */
	readonly partial: RecordedFolder | undefined
}

/** The ordinals of a recorded folder's files that completed. */
export const completedFiles = (f: RecordedFolder): ReadonlyArray<number> =>
	f.completed.map((r) => r.ordinal)

/** Folders by name, in code point order. */
const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]): number =>
	compareCodePoints(a, b)

/** The ledger's state: which folders completed, the database's latest target, and the partial folder if any. A
 * partial folder that is not the last one, two partial folders, or file rows without their folder row are damage no
 * apply leaves behind, refused as MalformedArtifact. */
export const ledgerState = (
	rows: ReadonlyArray<LedgerRow>,
	empty: SchemaFingerprint
): Result.Result<LedgerState, CompileError> =>
	catchRefusal(() => {
		const byFolder = new Map<string, Array<LedgerRow>>()
		for (const r of rows) {
			const list = byFolder.get(r.folder) ?? []
			list.push(r)
			byFolder.set(r.folder, list)
		}
		const complete: Array<RecordedFolder> = []
		let partial: RecordedFolder | undefined
		for (const [name, list] of [...byFolder.entries()].toSorted(byName)) {
			const head = list.find((r) => r.ordinal === folderOrdinal)
			if (head === undefined) {
				throw new Refusal(malformedArtifact("ledger", [name], "the folder row of the folder"))
			}
			if (
				list.some(
					(r) => r.source !== head.source || r.target !== head.target || r.files !== head.files
				)
			) {
				throw new Refusal(
					malformedArtifact(
						"ledger",
						[name],
						"rows that agree on the folder's source, target and file count"
					)
				)
			}
			if (partial !== undefined) {
				throw new Refusal(
					malformedArtifact(
						"ledger",
						[partial.folder],
						"the partially applied folder as the last one, and at most one of them"
					)
				)
			}
			const folder: RecordedFolder = {
				folder: name,
				source: head.source,
				target: head.target,
				files: head.files,
				meta: head.digest,
				completed: list
					.filter((r) => r.ordinal !== folderOrdinal)
					.toSorted(mapInput(compareNumbers, (r: (typeof list)[number]) => r.ordinal))
					.map((r) => ({ ordinal: r.ordinal, file: r.file, digest: r.digest }))
			}
			if (completedFiles(folder).length === head.files) {
				complete.push(folder)
			} else {
				partial = folder
			}
		}
		const last = complete.at(-1)
		return {
			latest: last === undefined ? empty : last.target,
			complete,
			partial
		}
	})
