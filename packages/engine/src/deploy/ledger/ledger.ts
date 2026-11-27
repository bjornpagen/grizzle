import {
	isNonEmpty,
	mapNonEmpty,
	type NonEmptyReadonlyArray
} from "@bjornpagen/grizzle-text/base/nonempty"
import type * as Result from "@bjornpagen/grizzle-text/base/result"
import { compareCodePoints } from "@bjornpagen/grizzle-text/text"
import { catchRefusal, Refusal, unwrap } from "#compiler/core/canonical.ts"
import { type CompileError, malformedArtifact } from "#compiler/core/errors.ts"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import { compareNumbers, mapInput } from "#compiler/core/order.ts"
import type { PhysicalObject } from "#compiler/ir/products.ts"
import { isolationTrigger } from "#compiler/physical/ddl/isolation.ts"
import {
	digestOfHex,
	folderOrdinal,
	hexOfDigest,
	ledgerTableName,
	proofsTableName,
	snapshotGuardName
} from "#compiler/physical/ddl/ledger.ts"
import { namedIdent, qualifiedIdent } from "#compiler/physical/obligations/graph.ts"
import type {
	ColumnDef,
	CreateTable,
	Delete,
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
import { installedTypes } from "#compiler/sql/type-schemas.ts"

import {
	arrays,
	asc,
	call,
	cast,
	col,
	cUtf8Collation,
	eq,
	ge,
	lit,
	namedType,
	objectName,
	param,
	provedSelect,
	qualifiedCall,
	table,
	tableCol,
	targetAs,
	types
} from "#compiler/sql/build.ts"
import { costChosen, emit } from "#compiler/sql/emit.ts"
import { assignments, ungenerated } from "#compiler/sql/generation.ts"
import { emptyNameMap } from "#compiler/sql/naming.ts"
import { adviceSettingName, claimsSettingName } from "#compiler/sql/print.ts"

/** The folder row's file. */
const folderFile = "meta.json"

const ledgerName = (schema: string): ObjectName => objectName(schema, ledgerTableName)

const proofsName = (schema: string): ObjectName => objectName(schema, proofsTableName)

/** The graph identities of the ledger's objects in a snapshot manifest (`InstallBuilder` names the others). */
const ledgerIdent = (schema: string): string => qualifiedIdent("table", schema, ledgerTableName)
const ledgerPrivilegesIdent = (schema: string): string =>
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

/**
 * A SHA-256 digest's column of `schema`'s bookkeeping, typed by the installation's digest domain (core/identity.ts
 * digestDomain, physical/ddl/context.ts), its 32 bytes, as every digest column is. The domain is created in Setup among
 * the installation's domains, before the isolation function the bookkeeping tables follow (deploy/snapshot/build.ts
 * targetState), so the ledger and the proofs are created after it, and their objects' statements name it, so the
 * manifest's edges hold them after it (physical/obligations/graph.ts namedEdges).
 */
const digestColumn = (schema: string, name: string): ColumnDef => ({
	name,
	type: namedType(installedTypes(schema), identifierOf(identity.digestDomain()), []),
	collation: undefined,
	generated: undefined
})

/** The bytes a digest's text parameter $n spells (physical/ddl/ledger.ts digestOfHex). */
const digestParam = (n: number): Expr => digestOfHex(param(n, types.text))

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

/**
 * Each ledger column's type: a text, an integer, which the rows statement reads as its text, or a SHA-256 digest, a
 * snapshot's fingerprint or a text's digest, stored as its 32 bytes and read as its hex.
 */
const ledgerColumnTypes: { readonly [C in LedgerColumn]: "text" | "integer" | "digest" } = {
	folder: "text",
	ordinal: "integer",
	file: "text",
	source: "digest",
	target: "digest",
	files: "integer",
	digest: "digest"
}

/** A ledger column of `schema` as its type (ledgerColumnTypes) makes it. */
const ledgerColumn = (schema: string, c: LedgerColumn): ColumnDef => {
	switch (ledgerColumnTypes[c]) {
		case "text":
			return text(c)
		case "integer":
			return integer(c)
		case "digest":
			return digestColumn(schema, c)
	}
}

/** A ledger column's value as the rows statement reads it: a text as itself, an integer as its text, a digest as its hex. */
const ledgerText = (c: LedgerColumn, value: Expr): Expr => {
	switch (ledgerColumnTypes[c]) {
		case "text":
			return value
		case "integer":
			return cast(value, types.text)
		case "digest":
			return hexOfDigest(value)
	}
}

/** The ledger's digest columns, each of the installation's digest domain. */
export const ledgerDigests = ledgerColumns.filter((c) => ledgerColumnTypes[c] === "digest")

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
 *     "source" "<schema>"."__sha256" NOT NULL,               -- the folder's source snapshot fingerprint
 *     "target" "<schema>"."__sha256" NOT NULL,               -- the folder's target snapshot fingerprint
 *     "files" integer NOT NULL,                               -- how many SQL files the folder holds
 *     "digest" "<schema>"."__sha256" NOT NULL,               -- SHA-256 of the applied text
 *     CONSTRAINT "<ledger key>" PRIMARY KEY ("folder", "ordinal"),
 *     CONSTRAINT "<ledger check of ordinal>" CHECK (("ordinal" >= 0) IS TRUE),
 *     CONSTRAINT "<ledger check of files>" CHECK (("files" >= 0) IS TRUE)
 *   )
 *
 * Each digest, a snapshot's fingerprint or a text's, is its 32 bytes under the installation's digest domain
 * (`digestColumn`), written from the hex the shell holds it in and read back as that hex (physical/ddl/ledger.ts
 * digestOfHex, hexOfDigest).
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
	columns: mapNonEmpty(ledgerColumns, (c) => ledgerColumn(schema, c)),
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
const ledgerObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "ledger",
	ident: ledgerIdent(schema),
	ddl: [ledgerTable(schema), revokePublic(schema)],
	reasons: [{ kind: "enforcement", of: "the migrations ledger" }],
	state: "needed",
	phase: "setup"
})

/** The ledger's guard trigger, created in Setup right after the ledger: every table grizzle installs refuses a write
 * below SERIALIZABLE. */
const ledgerGuardObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "isolationTrigger",
	...isolationTrigger(schema, ledgerName(schema)),
	reasons: [{ kind: "enforcement", of: "the SERIALIZABLE writes of the migrations ledger" }],
	state: "needed",
	phase: "setup"
})

/** The drift check's proofs' columns in table order: the proof rows statement's columns c1 to c3. */
export const proofColumns = ["object", "ddl", "description"] as const

/** The proofs' digest columns: each a SHA-256 digest of 32 bytes, read and written as its hex. */
const proofDigests = ["ddl", "description"] as const satisfies ReadonlyArray<
	(typeof proofColumns)[number]
>

/** Whether a proofs column is a digest's (proofDigests). */
const isProofDigest = (c: (typeof proofColumns)[number]): boolean =>
	proofDigests.some((d) => d === c)

/**
 * The drift check's proofs `<schema>.<proofs>` (identity.proofs), beside the ledger: one row for each object of the
 * installation PostgreSQL describes, as the last drift check of a migrate that found no drift left it (adapter/admission
 * drift.ts), every column NOT NULL with a primary key, like every table:
 *
 *   CREATE TABLE "<schema>"."<proofs>" (
 *     "object" text COLLATE pg_catalog.pg_c_utf8 NOT NULL,       -- the object's graph identity
 *     "ddl" "<schema>"."__sha256" NOT NULL,                     -- its proof digest (deploy/admission/proof.ts)
 *     "description" "<schema>"."__sha256" NOT NULL,             -- the digest of PostgreSQL's description of it
 *     CONSTRAINT "<proofs key>" PRIMARY KEY ("object")
 *   )
 *
 * Each digest is its 32 bytes under the installation's digest domain (`digestColumn`), written from the hex the drift
 * check holds it in and read back as that hex.
 *
 * A row is a fact about the server, never about the installation's state: the description PostgreSQL gives the object
 * its proof digest names, which digests the object's recorded statements, what it depends on and everything else a
 * description is a function of. So a row is read apart from any snapshot, and one whose digest an installation no
 * longer has proves nothing of it. The drift check replays only the objects no row proves (one whose digest or live
 * description is not its row's) with what they depend on, and a migrate whose drift check found no drift replaces the
 * rows, in a transaction of its own under the apply lock, when they differ from the ones it read. No Db reads it, so
 * no login holds a privilege on it and no fence takes it, and the live source publishes nothing of it. Its PUBLIC
 * privileges are revoked at once.
 */
const proofsTable = (schema: string): CreateTable => ({
	kind: "createTable",
	table: proofsName(schema),
	columns: mapNonEmpty(proofColumns, (c) => (isProofDigest(c) ? digestColumn(schema, c) : text(c))),
	primaryKey: {
		kind: "primaryKey",
		name: identifierOf(identity.proofsKey()),
		columns: [{ column: "object", withoutOverlaps: false }]
	},
	secondary: []
})

/** The manifest identity of the drift check's proofs of `schema`. */
export const proofsIdent = (schema: string): string =>
	qualifiedIdent("table", schema, proofsTableName)

/** The drift check's proofs as an object of a snapshot manifest, created in Setup right after the ledger. */
const proofsObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "ledger",
	ident: proofsIdent(schema),
	ddl: [
		proofsTable(schema),
		{
			kind: "revoke",
			privileges: ["ALL"],
			on: { kind: "TABLE", names: [proofsName(schema)] },
			from: [{ kind: "PUBLIC" }]
		}
	],
	reasons: [{ kind: "enforcement", of: "the drift check's proofs" }],
	state: "needed",
	phase: "setup"
})

/** The proofs' guard trigger, created in Setup right after the proofs: every table grizzle installs refuses a write
 * below SERIALIZABLE. */
const proofsGuardObject = (schema: string): PhysicalObject<SqlStatement> => ({
	kind: "isolationTrigger",
	...isolationTrigger(schema, proofsName(schema)),
	reasons: [{ kind: "enforcement", of: "the SERIALIZABLE writes of the drift check's proofs" }],
	state: "needed",
	phase: "setup"
})

/**
 * One of grizzle's bookkeeping tables: its table's name, in whatever schema the installation is, and in a schema its
 * CREATE TABLE, with its key, its object of a snapshot manifest (the table and its PUBLIC revoke), and its SERIALIZABLE
 * guard trigger's.
 */
export interface BookkeepingTable {
	readonly name: string
	readonly table: (schema: string) => CreateTable
	readonly object: (schema: string) => PhysicalObject<SqlStatement>
	readonly guard: (schema: string) => PhysicalObject<SqlStatement>
}

/**
 * grizzle's bookkeeping tables, the deployment's own beside an installation's tables, which no schema declares and only
 * a migration makes: the migrations ledger, then the drift check's proofs, each created in Setup right after the
 * isolation function, under its guard. The one roster of them: the snapshot creates each (snapshot/build.ts
 * targetState), and whatever reads an installation's catalog sets each aside by it, so a bookkeeping table is one
 * entry here. What the ledger alone is (every login reads it, the live source publishes it) is the ledger's.
 */
export const bookkeepingTables: NonEmptyReadonlyArray<BookkeepingTable> = [
	{
		name: ledgerTableName,
		table: ledgerTable,
		object: ledgerObject,
		guard: ledgerGuardObject
	},
	{
		name: proofsTableName,
		table: proofsTable,
		object: proofsObject,
		guard: proofsGuardObject
	}
]

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
	return unwrap(emit(statement, emptyNameMap, costChosen()))
}

/** The INSERT of a ledger row: a folder's row (ordinal 0, file meta.json), if absent; or a file's. */
const insertRow = (schema: string, row: "folder" | "file"): Insert => {
	let n = 0
	const next = (type: typeof types.text) => param(++n, type)
	const digest = () => digestParam(++n)
	const values: NonEmptyReadonlyArray<Expr> =
		row === "folder"
			? [
					next(types.text),
					lit.int(BigInt(folderOrdinal), types.integer),
					lit.text(folderFile, types.text),
					digest(),
					digest(),
					next(types.integer),
					digest()
				]
			: [
					next(types.text),
					next(types.integer),
					next(types.text),
					digest(),
					digest(),
					next(types.integer),
					digest()
				]
	return {
		kind: "insert",
		with: undefined,
		table: ledgerName(schema),
		alias: undefined,
		columns: [...ledgerColumns],
		source: { kind: "values", rows: [values] },
		onConflict:
			row === "folder"
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
	 * fingerprint, then the role $2, the claims setting $3 and the plan advice $4 of everything the transaction sends,
	 * each local to the transaction.
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
		/** The ledger table generates no column (physical/ddl/ledger.ts). */
		set: assignments(ungenerated, r1, [
			{ column: "target", value: digestParam(2) },
			{
				column: "digest",
				value: {
					kind: "case",
					operand: undefined,
					whens: [
						{
							when: eq(col(r1, "ordinal"), lit.int(BigInt(folderOrdinal), types.integer)),
							result: digestParam(3)
						}
					],
					else: col(r1, "digest")
				}
			}
		]),
		from: [],
		where: eq(col(r1, "folder"), param(1, types.text)),
		returning: []
	}
}

/**
 * The statements the apply runner sends in a file's transaction besides the file's own (adapter/migrate/apply.ts
 * runFile), as the transaction's locks count them (deploy/locks/demand.ts): the ledger's ACCESS EXCLUSIVE first, then
 * the folder's and the file's rows, and a redraft's re-record of its folder.
 */
export const runnerStatements = (
	schema: string
): { readonly fence: LockTable; readonly rows: ReadonlyArray<SqlStatement> } => ({
	fence: ledgerLock(schema, "ACCESS EXCLUSIVE", "wait"),
	rows: [insertRow(schema, "folder"), insertRow(schema, "file"), redraftUpdate(schema)]
})

/** The proofs' rows by object, each column named c1 to c3 in proofColumns order. */
const proofRows = (schema: string): Select => {
	const r1 = "r1"
	return {
		...provedSelect(
			"keyed",
			proofColumns.map((c, i) =>
				targetAs(isProofDigest(c) ? hexOfDigest(col(r1, c)) : col(r1, c), `c${i + 1}`)
			),
			[table(schema, proofsTableName, r1)],
			undefined
		),
		orderBy: [asc(col(r1, "object"))]
	}
}

/** Every row of the proofs deleted. */
const clearProofs = (schema: string): Delete => ({
	kind: "delete",
	with: undefined,
	table: proofsName(schema),
	alias: "r1",
	using: [],
	where: undefined,
	returning: []
})

/** The proofs' rows inserted from three text arrays, $1 to $3 in proofColumns order, read in lockstep. */
const recordProofs = (schema: string): Insert => {
	const a1 = "a1"
	const source = arrays(
		{
			kind: "columns",
			columns: mapNonEmpty(proofColumns, (name, i) => ({
				definition: { name, type: types.text, collation: cUtf8Collation },
				array: { placeholder: "value", number: i + 1 },
				check: { kind: "base" }
			})),
			ordinal: undefined
		},
		a1
	)
	return {
		kind: "insert",
		with: undefined,
		table: proofsName(schema),
		alias: undefined,
		columns: [...proofColumns],
		source: {
			kind: "query",
			query: provedSelect(
				"input",
				proofColumns.map((c) =>
					targetAs(isProofDigest(c) ? digestOfHex(col(a1, c)) : col(a1, c), c)
				),
				[source],
				undefined
			)
		},
		onConflict: undefined,
		returning: []
	}
}

/** The guard of the fingerprint at `$1`. */
const guardCall = (schema: string): Expr =>
	qualifiedCall(
		{ kind: "qualified", schema: schema, name: snapshotGuardName, volatility: "VOLATILE" },
		[param(1, types.text)]
	)

/** A setting local to the transaction, `set_config('<name>', $n, true)`. */
const localSetting = (name: string, index: number): Expr =>
	call("set_config", [lit.text(name, types.text), param(index, types.text), lit.bool(true)])

/**
 * A Db transaction's prologue statement over the ledger of `schema` (LedgerStatements `enter`): the guard's call, then the
 * role, the claims setting and the plan advice (sql/print.ts adviceSettingName), each local to the transaction. The
 * advice is the transaction's, every statement and unit it may send joined (sql/advice.ts joinAdvice), set by every
 * transaction before its first statement, so each plan and replan of each of them, a prepared statement's cached for
 * the session included, is made under it in whichever transaction PostgreSQL makes it.
 */
export const enterQuery = (schema: string): Select =>
	provedSelect(
		"oneRow",
		[
			targetAs(guardCall(schema), "c1"),
			targetAs(localSetting("role", 2), "c2"),
			targetAs(localSetting(claimsSettingName, 3), "c3"),
			targetAs(localSetting(adviceSettingName, 4), "c4")
		],
		[],
		undefined
	)

/** The statements the apply runner, admission and every Db transaction run against a schema's ledger, emitted like
 * every other text. */
export const ledgerStatements = (schema: string): Result.Result<LedgerStatements, CompileError> =>
	catchRefusal(() => {
		const name = ledgerName(schema)
		const r1 = "r1"
		const rows: Select = {
			...provedSelect(
				"keyed",
				ledgerColumns.map((c, i) => targetAs(ledgerText(c, col(r1, c)), `c${i + 1}`)),
				[table(name.schema, name.name, r1)],
				undefined
			),
			orderBy: [asc(col(r1, "folder")), asc(col(r1, "ordinal"))]
		}
		const enter = enterQuery(schema)
		return {
			recordFolder: emitted(insertRow(schema, "folder")),
			redraftFolder: emitted(redraftUpdate(schema)),
			recordFile: emitted(insertRow(schema, "file")),
			rows: emitted(rows),
			fence: emitted(ledgerLock(schema, "ACCESS SHARE", "nowait")),
			exclusive: emitted(ledgerLock(schema, "ACCESS EXCLUSIVE", "wait")),
			guard: emitted(provedSelect("oneRow", [targetAs(guardCall(schema), "c1")], [], undefined)),
			enter: emitted(enter)
		}
	})

/** The statements the drift check reads and migrate writes the drift check's proofs by (proofsTable), emitted like every
 * other text; no Db and no admission runs one. */
export interface ProofStatements {
	/** Every row as its three columns in proofColumns order, by object. */
	readonly rows: EmittedSql
	/** DELETE every row, which `record` then writes afresh. */
	readonly clear: EmittedSql
	/**
	 * INSERT the rows: $1 the objects, $2 their proof digests and $3 their descriptions' digests, three text arrays read
	 * in lockstep, one row per element.
	 */
	readonly record: EmittedSql
}

/** The statements of `schema`'s proofs. */
export const proofStatements = (schema: string): Result.Result<ProofStatements, CompileError> =>
	catchRefusal(() => ({
		rows: emitted(proofRows(schema)),
		clear: emitted(clearProofs(schema)),
		record: emitted(recordProofs(schema))
	}))

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
			const list = byFolder.getOrInsertComputed(r.folder, () => [])
			list.push(r)
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
