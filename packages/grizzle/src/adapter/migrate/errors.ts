import { Array as Arr, Data, Formatter } from "effect"
import type { DriftMismatch } from "#adapter/admission/drift.ts"
import type {
	CatalogRowRefused,
	ConnectionLost,
	ConnectRefusal,
	DriverFailure,
	InputTooLarge,
	ServerError,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import {
	type CompileError,
	compileReasonText,
	type LawId,
	quoteIdent,
	sqlstates
} from "#compiler/plan/common.ts"
import type { findMarkers, VariableFault } from "#compiler/plan/migration.ts"

/**
 * The failure of `grizzle migrate` and `grizzle drift`.
 *
 * The apply runner is not part of the library's public API: the command line drives it, so its failure is one internal
 * MigrateError the CLI reports, whose classified case is its `reason`: one of the classes here, each a
 * Data.TaggedError carrying exactly what happened and rendering its own `message`. What follows from a reason is a
 * getter of the error, never a stored field: the stage, the schema and the place in its migrations directory it
 * concerns, and what the server said. A failure underneath is grizzle's own classified failure (a connection attempt's
 * refusal, a ServerError, a lost connection, a CompileError), kept as it is, so no `cause` wraps a foreign value here.
 *
 * The stage says where the apply stopped and so what the database holds:
 *
 * - Before any statement of any folder ran: `connect`, `owner`, `input`, `busy`, `ledger`, `edited`, `order`,
 *   `marker` and `decision`. Nothing was written; the ledger and the catalog are as they were. `edited` is an applied
 *   file whose text is no longer the one its ledger row's digest records, or one deleted from or added to an applied
 *   folder: the database ran another text than the repository holds, so the repository must be restored.
 * - In a file: `statement` (one of its statements failed), `record` (its ledger row could not be written) or
 *   `commit` (its COMMIT was refused, or the connection was lost while it ran). A transactional file rolled back
 *   whole, and its ledger row with it; a no-transaction file stopped at its failing statement, and the statements
 *   before it stay applied, which its drafted statements make safe to run again. A rerun resumes at the
 *   failed file. Only a lost connection during COMMIT leaves the outcome unknown, and the ledger answers it: the file's
 *   row is inserted inside its own transaction, so the file committed exactly when its row exists.
 * - `grizzle roles` and `grizzle uninstall`: `uninstall`, the installation's roles or schemas could not be read, or
 *   the transaction that drops them was refused and rolled back whole, as PostgreSQL refuses DROP ROLE while anything of
 *   another database depends on a role (2BP01, its DETAIL naming the database). Nothing was dropped.
 * - After every folder applied: `drift`, the drift check of the catalog against the target snapshot
 *   (adapter/admission/drift.ts; edits are allowed, drift is not), with every mismatch; or `unchecked`, a drift check
 *   that reached no verdict, because the snapshot did not render, the ledger or the catalog could not be read, or the
 *   replay that builds the snapshot beside the schema was refused. The check changed nothing: it rolled back.
 */
export type MigrateStage =
	| "connect"
	| "server"
	| "owner"
	| "input"
	| "busy"
	| "ledger"
	| "edited"
	| "order"
	| "marker"
	| "decision"
	| "statement"
	| "record"
	| "commit"
	| "drift"
	| "unchecked"
	| "uninstall"

/**
 * What ran before a stage stopped the command, as the report's outcome line says it: nothing at all, the files before
 * the failed one (a rerun resumes), every folder with a catalog that differs, or every folder with no verdict.
 */
export type MigrateOutcome = "nothingRan" | "resumes" | "drifted" | "noVerdict"

/** The outcome of each stage. */
export const stageOutcome: { readonly [S in MigrateStage]: MigrateOutcome } = {
	connect: "nothingRan",
	server: "nothingRan",
	owner: "nothingRan",
	input: "nothingRan",
	busy: "nothingRan",
	ledger: "nothingRan",
	edited: "nothingRan",
	order: "nothingRan",
	marker: "nothingRan",
	decision: "nothingRan",
	statement: "resumes",
	record: "resumes",
	commit: "resumes",
	drift: "drifted",
	unchecked: "noVerdict",
	uninstall: "nothingRan"
}

/** A statement apart's answer that is no row its query reads: the server's refusal, or a row the catalog cannot give. */
type RowFailure = ServerError | CatalogRowRefused

/**
 * A step that failed as a whole: the connection lost, the driver, or an answer grizzle cannot read; or a step longer than
 * one write carries, refused before any byte of it was written.
 */
type FlightFailure = ConnectionLost | DriverFailure | UnreadableAnswer | InputTooLarge

/** How a read fails: the server refused it, the session failed, or it answered what the read cannot. */
type ReadFailure = RowFailure | FlightFailure

/**
 * How one statement fails: the server refused it, or refused it for want of shared memory in a migration's transaction
 * (LockTableExhausted), the session failed, it answered rows grizzle's SQL cannot deliver, or the catalog answered what
 * the statement cannot.
 */
export type StatementFailure = ReadFailure | LockTableExhausted

const serverSaid = (e: ServerError): string =>
	`SQLSTATE ${e.sqlstate}${e.constraint === undefined ? "" : ` (constraint ${e.constraint})`}: ${e.message}`

/**
 * The server's lock table as its settings size it, read in the migration's session once the refused transaction rolled
 * back: about max_locks_per_transaction × (max_connections + max_prepared_transactions) locks, which every
 * transaction of the server shares; or the read's own failure, when that session could not answer it.
 */
export type ServerLockTable =
	| {
			readonly kind: "read"
			readonly maxLocksPerTransaction: string
			readonly maxConnections: string
			readonly maxPreparedTransactions: string
	  }
	| { readonly kind: "unread"; readonly failure: ReadFailure }

/** The lock table's size, as a refusal states it. */
const lockTableText = (table: ServerLockTable): string => {
	const formula = "max_locks_per_transaction × (max_connections + max_prepared_transactions)"
	switch (table.kind) {
		case "read":
			return `${formula} = ${table.maxLocksPerTransaction} × (${table.maxConnections} + ${table.maxPreparedTransactions}) locks`
		case "unread":
			return `${formula} locks (its settings could not be read: ${failureText(table.failure)})`
	}
}

/**
 * A statement of a migration's transaction, a file's or the drift check's replay, the server refused for want of shared
 * memory (SQLSTATE 53200, its report kept): a transaction holds one lock per object it creates or alters until it ends,
 * and the server's lock table, `table`, is shared by every transaction at once, so a migration that creates more
 * objects than it holds stops, and rolls back whole. The fix is the server's setting, max_locks_per_transaction, which
 * takes a restart; the migration's one transaction stays whole.
 */
export class LockTableExhausted extends Data.TaggedError("LockTableExhausted")<{
	readonly error: ServerError
	readonly table: ServerLockTable
}> {
	override get message(): string {
		return `the server ran out of shared memory for locks (${serverSaid(this.error)}): a migration's transaction holds one lock per object it creates or alters until it ends, and the server's lock table holds ${lockTableText(this.table)} for every transaction at once; raise max_locks_per_transaction (a server restart) until it holds more than the objects the migration creates, then run grizzle migrate again`
	}
}

/** A statement's failure, as a refusal's message states it after a colon. */
const failureText = (failure: StatementFailure): string => {
	switch (failure._tag) {
		case "ServerError":
			return serverSaid(failure)
		case "LockTableExhausted":
			return failure.message
		case "ConnectionLost":
			return `the connection was lost${failure.ended.by === "server" ? `: ${serverSaid(failure.ended.error)}` : ""}`
		case "CatalogRowRefused":
			return `the catalog's answer is not ${failure.what}`
		case "DriverFailure":
			return "the driver refused it"
		case "UnreadableAnswer":
			return "it answered rows grizzle cannot read"
		case "InputTooLarge":
			return failure.message
	}
}

/**
 * What the server said of a failure: its refusal, or the report it ended the connection with (a FATAL or PANIC, or its
 * refusal of BEGIN); nothing when no server answered, such as a lost connection.
 */
export type ServerReport =
	| { readonly by: "server"; readonly error: ServerError }
	| { readonly by: "none" }

const noServerReport: ServerReport = Object.freeze({ by: "none" })

const serverReport = (failure: StatementFailure): ServerReport => {
	switch (failure._tag) {
		case "ServerError":
			return { by: "server", error: failure }
		case "LockTableExhausted":
			return { by: "server", error: failure.error }
		case "ConnectionLost":
			return failure.ended.by === "server" ? failure.ended : noServerReport
		case "CatalogRowRefused":
		case "DriverFailure":
		case "UnreadableAnswer":
		case "InputTooLarge":
			return noServerReport
	}
}

/**
 * Where in a schema's migrations directory a failure is: the directory as a whole, one folder, one file of it, or one
 * statement (1-based) of that file.
 */
export type MigrationPlace =
	| { readonly kind: "directory" }
	| { readonly kind: "folder"; readonly folder: string }
	| { readonly kind: "file"; readonly folder: string; readonly file: string }
	| {
			readonly kind: "statement"
			readonly folder: string
			readonly file: string
			readonly statement: number
	  }

const directory: MigrationPlace = Object.freeze({ kind: "directory" })

/**
 * What a ledger write records: a folder's row alone (a folder without files, or a no-transaction file's folder before
 * its first statement), or a file's rows.
 */
export type RecordPlace =
	| { readonly kind: "folder"; readonly folder: string }
	| { readonly kind: "file"; readonly folder: string; readonly file: string }

const recordText = (at: RecordPlace): string =>
	at.kind === "folder" ? at.folder : `${at.folder}/${at.file}`

/** An unresolved placeholder marker in a file the apply would run; its line is 1-based. */
export type UnresolvedMarker = {
	readonly folder: string
	readonly file: string
	readonly kind: ReturnType<typeof findMarkers>[number]["kind"]
	readonly line: number
}

/**
 * A loss of stored data in a folder the apply would run that the reviewer has not decided, a schema's first migration
 * beside a schema the configuration no longer lists: its statement still commented (lossDecisions).
 */
export type UnresolvedLoss = {
	readonly folder: string
	readonly file: string
	/** What it loses (deploy/render/folder.ts lossText). */
	readonly loses: string
}

/**
 * An applied folder's file that no longer matches its ledger row: its text was edited after it ran, it was deleted,
 * or it was added to a folder every file of which had already run.
 */
export type AppliedEdit = {
	readonly folder: string
	readonly file: string
	readonly kind: "edited" | "missing" | "added"
}

/** What each applied edit says after its file's path, with its fix. */
export const appliedEditPhrase: Readonly<Record<AppliedEdit["kind"], string>> = {
	edited: "was edited after it was applied; restore it from git",
	missing: "was applied but is missing; restore it from git",
	added:
		"was added after its folder was applied; move it into a new migration (grizzle generate <config> --custom --name <name>)"
}

const fileOf = (first: { readonly folder: string; readonly file: string }): MigrationPlace => ({
	kind: "file",
	folder: first.folder,
	file: first.file
})

/** The migration identity could not connect to `host`:`port` as `role`, for `refusal`; no schema is concerned yet. */
export class ConnectRefused extends Data.TaggedError("ConnectRefused")<{
	readonly role: string
	readonly host: string
	readonly port: number
	readonly refusal: ConnectRefusal
}> {
	override get message(): string {
		return `the migration identity ${this.role} could not connect to ${this.host}:${this.port}: ${this.refusal.message}`
	}
}

/** The survey step, which reads the session's role and each schema's owner, apply lock and ledger, failed whole. */
export class SurveyFailed extends Data.TaggedError("SurveyFailed")<{
	readonly failure: FlightFailure
}> {
	override get message(): string {
		return `the session's role and its schemas' owners, apply locks and ledgers could not be read: ${failureText(this.failure)}`
	}
}

/**
 * The server's max_stack_depth, `observed` kilobytes as pg_settings reports it, is below `required`, the default the
 * limits grizzle holds every pattern to were measured at, so a domain's pattern could be refused as too complex.
 */
export class StackTooShallow extends Data.TaggedError("StackTooShallow")<{
	readonly observed: string
	readonly required: string
}> {
	override get message(): string {
		return `the server's max_stack_depth is ${this.observed} kB, below ${this.required}; a superuser raises it`
	}
}

/** The session's role could not be read, which concerns no schema. */
export class RoleUnread extends Data.TaggedError("RoleUnread")<{ readonly failure: RowFailure }> {
	override get message(): string {
		return `the session's role could not be read: ${failureText(this.failure)}`
	}
}

/** The installation's namespace could not be read: the cluster's roles, or the schemas of its database. */
export class NamespaceUnread extends Data.TaggedError("NamespaceUnread")<{
	readonly what: "roles" | "schemas" | "publications"
	readonly failure: RowFailure | FlightFailure
}> {
	override get message(): string {
		return `the installation's ${this.what} could not be read: ${failureText(this.failure)}`
	}
}

/**
 * The transaction that uninstalls the installation, its schemas and its roles, was refused and rolled back whole: by
 * PostgreSQL's DROP ROLE while a role holds a privilege or an object anywhere else (2BP01, whose DETAIL names the
 * database), or for any other failure of a statement of it.
 */
export class UninstallRefused extends Data.TaggedError("UninstallRefused")<{
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `the uninstall was refused and rolled back, nothing dropped: ${failureText(this.failure)}`
	}
}

/** The owner of `schema` could not be read. */
export class OwnerUnread extends Data.TaggedError("OwnerUnread")<{
	readonly schema: string
	readonly failure: RowFailure
}> {
	override get message(): string {
		return `the owner of ${this.schema} could not be read: ${failureText(this.failure)}`
	}
}

/** `schema` is owned by `owner`, another role than `user`, the connecting one. */
export class OwnedByAnother extends Data.TaggedError("OwnedByAnother")<{
	readonly schema: string
	readonly owner: string
	readonly user: string
}> {
	override get message(): string {
		return `schema ${this.schema} is owned by ${this.owner}, not by the connecting role ${this.user}; migrations run as the schema's owner`
	}
}

/**
 * What a schema's input refuses, before anything is read (input.ts): its schema given twice, a folder's name, a folder
 * given twice, its meta.json malformed or another schema's, a file named twice or meta.json among its SQL files, its
 * files' names (`error`, render/folder.ts orderFolderFiles), or a statement that controls the transaction itself.
 */
export type InputFault =
	| { readonly kind: "repeatedSchema" }
	| { readonly kind: "folderName"; readonly folder: string }
	| { readonly kind: "repeatedFolder"; readonly folder: string }
	| { readonly kind: "malformedMeta"; readonly folder: string; readonly error: CompileError }
	| {
			readonly kind: "foreignMeta"
			readonly folder: string
			readonly belongs: { readonly schemaName: string; readonly schema: string }
			readonly schemaName: string
	  }
	| { readonly kind: "repeatedFile"; readonly folder: string }
	| { readonly kind: "metaAmongFiles"; readonly folder: string }
	| { readonly kind: "fileNames"; readonly folder: string; readonly error: CompileError }
	| {
			readonly kind: "transactionControl"
			readonly folder: string
			readonly file: string
			readonly statement: number
			readonly control: string
	  }
	| {
			readonly kind: "variable"
			readonly folder: string
			readonly file: string
			readonly statement: number
			readonly fault: VariableFault
	  }

/** What a statement's variable that no installation fills is, as a refusal states it (deploy/render/variables.ts). */
const variableFaultText = (fault: VariableFault): string => {
	switch (fault.kind) {
		case "unknownVariable":
			return `names the variable :${quoteIdent(fault.name)}, which is neither :"DBNAME" nor a role's name: its stem <schema>__<name>, the name a rename sets it aside under, __aside_<digest>, or the installation's decoder login's, __live_<digest>; write a slice with a space after its colon`
		case "roleTooLong":
			return `names the role ${fault.name}, which the installation's role prefix makes ${fault.role}, past PostgreSQL's ${fault.limit} bytes`
	}
}

/** `schema`'s snapshot and folders, as the command line read them, are refused for `fault`. */
export class InputRefused extends Data.TaggedError("InputRefused")<{
	readonly schema: string
	readonly fault: InputFault
}> {
	/** The folder, meta.json or statement the fault is at; the directory for the schema given twice. */
	get place(): MigrationPlace {
		const fault = this.fault
		switch (fault.kind) {
			case "repeatedSchema":
				return directory
			case "folderName":
			case "repeatedFolder":
			case "repeatedFile":
			case "metaAmongFiles":
			case "fileNames":
				return { kind: "folder", folder: fault.folder }
			case "malformedMeta":
			case "foreignMeta":
				return { kind: "file", folder: fault.folder, file: "meta.json" }
			case "transactionControl":
			case "variable":
				return {
					kind: "statement",
					folder: fault.folder,
					file: fault.file,
					statement: fault.statement
				}
		}
	}

	override get message(): string {
		const fault = this.fault
		switch (fault.kind) {
			case "repeatedSchema":
				return `schema ${this.schema} is given twice; each declared schema has one snapshot and one migrations directory`
			case "folderName":
				return `migration folder ${Formatter.format(fault.folder)} is not named <YYYYMMDDHHMMSS>_<name>`
			case "repeatedFolder":
				return `migration folder ${fault.folder} is given twice`
			case "malformedMeta":
				return `${fault.folder}/meta.json is malformed: ${compileReasonText(fault.error.reason)}`
			case "foreignMeta":
				return `${fault.folder}/meta.json belongs to schema ${fault.belongs.schemaName} (${fault.belongs.schema}), not ${fault.schemaName} (${this.schema})`
			case "repeatedFile":
				return `migration ${fault.folder} names a file twice`
			case "metaAmongFiles":
				return `migration ${fault.folder} passes meta.json among its SQL files`
			case "fileNames":
				return `migration ${fault.folder}: ${compileReasonText(fault.error.reason)}`
			case "transactionControl":
				return `${fault.folder}/${fault.file} statement ${fault.statement} is ${fault.control}: a migration file runs as one transaction, or each statement alone with -- grizzle: no-transaction, and its ledger row is recorded in its own transaction`
			case "variable":
				return `${fault.folder}/${fault.file} statement ${fault.statement} ${variableFaultText(fault.fault)}`
		}
	}
}

/** The apply lock of `schema` could not be taken: its statement did not answer whether it was. */
export class LockUnread extends Data.TaggedError("LockUnread")<{
	readonly schema: string
	readonly failure: RowFailure
}> {
	override get message(): string {
		return `the apply lock of ${this.schema} could not be taken: ${failureText(this.failure)}`
	}
}

/**
 * The server's wal_level is not logical: the live source of `schema` reads its changes by logical decoding of the WAL,
 * which needs it, so the apply is refused before any statement runs.
 */
export class WalLevelNotLogical extends Data.TaggedError("WalLevelNotLogical")<{
	readonly schema: string
	readonly level: string
}> {
	override get message(): string {
		return `the server's wal_level is ${this.level}, and the live source of ${this.schema} decodes the WAL, which needs wal_level = logical: run ALTER SYSTEM SET wal_level = logical, restart the server, and migrate again`
	}
}

/**
 * The decoder login `role` of `schema` holds no replication right once the files committed, and the migration identity
 * can grant it neither the REPLICATION attribute, which takes a superuser or a role holding it, nor a membership in
 * Amazon RDS's rds_replication, which takes ADMIN on that role.
 */
export class DecoderUnreplicated extends Data.TaggedError("DecoderUnreplicated")<{
	readonly schema: string
	readonly role: string
}> {
	override get message(): string {
		return `the decoder login ${this.role} of ${this.schema} holds no replication right, and the migration identity can grant none: as a superuser, run ALTER ROLE "${this.role}" REPLICATION; on Amazon RDS, as a member of rds_superuser, run GRANT rds_replication TO "${this.role}" WITH INHERIT TRUE, SET FALSE; then migrate again`
	}
}

/** Another apply of `schema` holds its apply lock. */
export class ApplyBusy extends Data.TaggedError("ApplyBusy")<{ readonly schema: string }> {
	override get message(): string {
		return `another grizzle migrate of ${this.schema} is running; the apply is refused before any statement runs`
	}
}

/** The ledger statements of `schema` do not compile. */
export class LedgerUncompiled extends Data.TaggedError("LedgerUncompiled")<{
	readonly schema: string
	readonly error: CompileError
}> {
	override get message(): string {
		return `the ledger statements of ${this.schema} do not compile: ${compileReasonText(this.error.reason)}`
	}
}

/** The ledger of `schema` could not be read. */
export class LedgerUnread extends Data.TaggedError("LedgerUnread")<{
	readonly schema: string
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `the ledger of ${this.schema} could not be read: ${failureText(this.failure)}`
	}
}

/**
 * The ledger of `schema` holds rows that are damage no apply leaves behind (ledger/ledger.ts ledgerState); `error` says
 * what.
 */
export class LedgerDamaged extends Data.TaggedError("LedgerDamaged")<{
	readonly schema: string
	readonly error: CompileError
}> {
	override get message(): string {
		return `the ledger of ${this.schema} is damaged: ${compileReasonText(this.error.reason)}`
	}
}

/** Applied files of `schema` whose texts are no longer the ones their ledger rows record. */
export class AppliedEdited extends Data.TaggedError("AppliedEdited")<{
	readonly schema: string
	readonly edits: Arr.NonEmptyReadonlyArray<AppliedEdit>
}> {
	override get message(): string {
		return Arr.join(
			Arr.map(this.edits, (e) => `${e.folder}/${e.file} ${appliedEditPhrase[e.kind]}`),
			"; "
		)
	}
}

/** Why a pending folder cannot continue the ledger's chain (deploy/ledger/ledger.ts FolderRefusal). */
type FolderRefusal =
	| { readonly kind: "moved"; readonly source: string; readonly target: string }
	| { readonly kind: "resized"; readonly started: number; readonly holds: number }
	| { readonly kind: "partialFirst"; readonly partial: string }
	| { readonly kind: "sortsBefore"; readonly applied: string }
	| { readonly kind: "source"; readonly source: string; readonly latest: string }

/** `folder` of `schema` cannot continue the ledger's chain, for `refusal` (ledger/ledger.ts decideFolder). */
export class FolderRefused extends Data.TaggedError("FolderRefused")<{
	readonly schema: string
	readonly folder: string
	readonly refusal: FolderRefusal
}> {
	override get message(): string {
		const refusal = this.refusal
		switch (refusal.kind) {
			case "moved":
				return `folder ${this.folder} was recorded with source ${refusal.source} and target ${refusal.target}, not the fingerprints its meta.json names`
			case "resized":
				return `folder ${this.folder} was started with ${refusal.started} files and now holds ${refusal.holds}`
			case "partialFirst":
				return `folder ${refusal.partial} is partially applied; it resumes before ${this.folder} runs`
			case "sortsBefore":
				return `folder ${this.folder} sorts before the applied folder ${refusal.applied}; a new folder follows every applied one`
			case "source":
				return `folder ${this.folder} starts from snapshot ${refusal.source}, but the database's latest applied target is ${refusal.latest}`
		}
	}
}

/**
 * The chain does not end at snapshot `known`, the one the application knows: it ends at `reached`, the database's latest
 * applied target with no pending folder (`ledger`), or the last pending folder's target (`folders`).
 */
export class SnapshotUnreached extends Data.TaggedError("SnapshotUnreached")<{
	readonly schema: string
	readonly known: string
	readonly reached: string
	readonly by: "ledger" | "folders"
}> {
	override get message(): string {
		return this.by === "ledger"
			? `the database's latest applied target is ${this.reached}, but the application knows snapshot ${this.known}, and no pending folder leads there`
			: `the pending folders end at snapshot ${this.reached}, but the application knows snapshot ${this.known}; snapshot.json and the folders disagree`
	}
}

/** Unresolved markers in files of `schema` the apply would run. */
export class MarkersUnresolved extends Data.TaggedError("MarkersUnresolved")<{
	readonly schema: string
	readonly markers: Arr.NonEmptyReadonlyArray<UnresolvedMarker>
}> {
	override get message(): string {
		return `unresolved markers, which a reviewer resolves by supplying the value and deleting the marker line: ${Arr.join(
			Arr.map(this.markers, (m) => `${m.folder}/${m.file}:${m.line} ${m.kind}`),
			", "
		)}`
	}
}

/** Unresolved losses of stored data in folders of `schema` the apply would run. */
export class LossesUndecided extends Data.TaggedError("LossesUndecided")<{
	readonly schema: string
	readonly losses: Arr.NonEmptyReadonlyArray<UnresolvedLoss>
}> {
	override get message(): string {
		return `unresolved losses of stored data, which a reviewer decides by writing in the statement that loses it or leaving it out: ${Arr.join(
			Arr.map(this.losses, (l) => `${l.folder}/${l.file} ${l.loses}`),
			", "
		)}`
	}
}

/** How a refusal of a migration file names the law its constraint reports (`brokenLaw` in apply.ts), when it does. */
const lawText = (law: LawId | undefined): string =>
	law === undefined ? "" : `, breaking law ${law}`

/**
 * Statement `statement` (1-based) of `folder`/`file` failed: `law` the law the refused constraint reports, by the laws
 * of `folder` itself (its meta.json's FolderLaws), as a refused write names it (apply.ts brokenLaw).
 */
export class StatementFailed extends Data.TaggedError("StatementFailed")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly statement: number
	readonly failure: StatementFailure
	readonly law: LawId | undefined
}> {
	override get message(): string {
		return `${this.folder}/${this.file} statement ${this.statement} failed${lawText(this.law)}: ${failureText(this.failure)}`
	}
}

/** The transaction of `folder`/`file` failed whole: its BEGIN refused, the connection lost, or the driver. */
export class TransactionFailed extends Data.TaggedError("TransactionFailed")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly failure: FlightFailure
}> {
	override get message(): string {
		const begin = this.failure._tag === "ConnectionLost" && this.failure.operation === "begin"
		return `${begin ? "BEGIN" : `${this.folder}/${this.file}`} failed: ${failureText(this.failure)}`
	}
}

/** The lock every ledger write takes first, the ledger's ACCESS EXCLUSIVE, was refused or failed. */
export class LedgerUnlocked extends Data.TaggedError("LedgerUnlocked")<{
	readonly schema: string
	readonly at: RecordPlace
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `the ledger of ${this.schema} could not be locked: ${failureText(this.failure)}`
	}
}

/**
 * The ledger row of `at` could not be written. The server's 42P01 says the ledger does not exist: a schema's first
 * migration creates it in its first file, so a folder whose first transaction cannot find it ran before the schema was
 * created.
 */
export class RecordFailed extends Data.TaggedError("RecordFailed")<{
	readonly schema: string
	readonly at: RecordPlace
	readonly failure: StatementFailure
}> {
	override get message(): string {
		const absent =
			this.failure._tag === "ServerError" && this.failure.sqlstate === sqlstates.undefinedTable
		const creates = "a schema's first migration creates its ledger in its first file"
		if (!absent) {
			return `${recordText(this.at)} could not be recorded in the ledger: ${failureText(this.failure)}`
		}
		return this.at.kind === "folder"
			? `the ledger of ${this.schema} does not exist to record ${this.at.folder}: ${creates}`
			: `${this.at.folder}/${this.at.file} ran, but the ledger of ${this.schema} does not exist to record it: ${creates}`
	}
}

/**
 * The COMMIT of `folder`/`file` was refused, so the file rolled back with its ledger row: `law` the law a deferred
 * constraint the COMMIT checked reports, by the laws of `folder` itself (its meta.json's FolderLaws, apply.ts
 * brokenLaw).
 */
export class FileCommitRefused extends Data.TaggedError("FileCommitRefused")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly failure: ServerError
	readonly law: LawId | undefined
}> {
	override get message(): string {
		return `the COMMIT of ${this.folder}/${this.file} failed${lawText(this.law)}: ${failureText(this.failure)}`
	}
}

/** The connection was lost during the COMMIT of `at`, so whether it committed is unknown, and its ledger row tells. */
export class FileCommitLost extends Data.TaggedError("FileCommitLost")<{
	readonly schema: string
	readonly at: RecordPlace
}> {
	override get message(): string {
		return this.at.kind === "folder"
			? `the connection was lost during the COMMIT recording ${this.at.folder}; whether it committed is unknown, and its ledger row tells`
			: `the connection was lost during the COMMIT of ${this.at.folder}/${this.at.file}; whether it committed is unknown, and its ledger row tells: a rerun resumes after it exactly when it committed`
	}
}

/** After every folder applied, the catalog of `schema` differs from snapshot `snapshot` by each mismatch. */
export class Drifted extends Data.TaggedError("Drifted")<{
	readonly schema: string
	readonly snapshot: string
	readonly mismatches: Arr.NonEmptyReadonlyArray<DriftMismatch>
}> {
	override get message(): string {
		const n = this.mismatches.length
		return `the catalog of ${this.schema} differs from snapshot ${this.snapshot} by ${n} fact${n === 1 ? "" : "s"} (edits are allowed, drift is not)`
	}
}

/**
 * Statement `statement` of the `of` statements of the drift check's replay, which builds the snapshot's objects beside
 * the schema to compare them, was refused by the server: the check reached no verdict, and rolled back.
 */
export class ReplayRefused extends Data.TaggedError("ReplayRefused")<{
	readonly statement: number
	readonly of: number
	readonly failure: ServerError | LockTableExhausted
}> {
	override get message(): string {
		return `statement ${this.statement} of ${this.of} of the replay was refused: ${failureText(this.failure)}`
	}
}

/**
 * The drift check of `schema` reached no verdict: the snapshot's installation does not render (a CompileError), its
 * ledger could not be read, the replay that builds the snapshot beside it was refused, or the catalog could not be read.
 * A StatementFailure here is a read's.
 */
export class DriftUnchecked extends Data.TaggedError("DriftUnchecked")<{
	readonly schema: string
	readonly failure: CompileError | LedgerUnread | LedgerDamaged | ReplayRefused | StatementFailure
}> {
	/** What the server said, when the replay or the catalog's reads failed; nothing for a snapshot or the ledger. */
	get server(): ServerReport {
		const failure = this.failure
		switch (failure._tag) {
			case "CompileError":
			case "LedgerUnread":
			case "LedgerDamaged":
				return noServerReport
			case "ReplayRefused":
				return serverReport(failure.failure)
			case "ServerError":
			case "LockTableExhausted":
			case "ConnectionLost":
			case "CatalogRowRefused":
			case "DriverFailure":
			case "UnreadableAnswer":
			case "InputTooLarge":
				return serverReport(failure)
		}
	}

	override get message(): string {
		const failure = this.failure
		switch (failure._tag) {
			case "CompileError":
				return `the snapshot's installation of ${this.schema} could not be rendered to compare definitions: ${failure.message}`
			case "LedgerUnread":
			case "LedgerDamaged":
				return failure.message
			case "ReplayRefused":
				return `the snapshot of ${this.schema} could not be built beside it to compare (statement ${failure.statement} of ${failure.of} of the replay): ${failureText(failure.failure)}`
			case "ServerError":
			case "LockTableExhausted":
			case "ConnectionLost":
			case "CatalogRowRefused":
			case "DriverFailure":
			case "UnreadableAnswer":
			case "InputTooLarge":
				return `the catalog of ${this.schema} could not be read: ${failureText(failure)}`
		}
	}
}

/** Why `grizzle migrate` or `grizzle drift` stopped. */
export type MigrateReason =
	| ConnectRefused
	| SurveyFailed
	| StackTooShallow
	| RoleUnread
	| OwnerUnread
	| OwnedByAnother
	| InputRefused
	| LockUnread
	| ApplyBusy
	| WalLevelNotLogical
	| DecoderUnreplicated
	| LedgerUncompiled
	| LedgerUnread
	| LedgerDamaged
	| AppliedEdited
	| FolderRefused
	| SnapshotUnreached
	| MarkersUnresolved
	| LossesUndecided
	| StatementFailed
	| TransactionFailed
	| LedgerUnlocked
	| RecordFailed
	| FileCommitRefused
	| FileCommitLost
	| Drifted
	| DriftUnchecked
	| NamespaceUnread
	| UninstallRefused

/** The stage each reason stops at. */
const stageOf: { readonly [Tag in MigrateReason["_tag"]]: MigrateStage } = {
	ConnectRefused: "connect",
	SurveyFailed: "owner",
	StackTooShallow: "server",
	RoleUnread: "owner",
	OwnerUnread: "owner",
	OwnedByAnother: "owner",
	InputRefused: "input",
	LockUnread: "busy",
	ApplyBusy: "busy",
	WalLevelNotLogical: "server",
	DecoderUnreplicated: "drift",
	LedgerUncompiled: "ledger",
	LedgerUnread: "ledger",
	LedgerDamaged: "ledger",
	AppliedEdited: "edited",
	FolderRefused: "order",
	SnapshotUnreached: "order",
	MarkersUnresolved: "marker",
	LossesUndecided: "decision",
	StatementFailed: "statement",
	TransactionFailed: "statement",
	LedgerUnlocked: "record",
	RecordFailed: "record",
	FileCommitRefused: "commit",
	FileCommitLost: "commit",
	Drifted: "drift",
	DriftUnchecked: "unchecked",
	NamespaceUnread: "uninstall",
	UninstallRefused: "uninstall"
}

/**
 * `grizzle migrate` or `grizzle drift` stopped for `reason`, at the stage that reason stops at. An edit, marker or
 * decision refusal is located at its first edit, marker or loss; a failure in a file, or of the drift check, carries
 * what the server said.
 */
export class MigrateError extends Data.TaggedError("MigrateError")<{
	readonly reason: MigrateReason
}> {
	get stage(): MigrateStage {
		return stageOf[this.reason._tag]
	}

	/** The PostgreSQL schema the failure concerns: none for a connection or the session's role. */
	get schema(): string | undefined {
		const reason = this.reason
		switch (reason._tag) {
			case "ConnectRefused":
			case "SurveyFailed":
			case "StackTooShallow":
			case "RoleUnread":
			case "NamespaceUnread":
			case "UninstallRefused":
				return undefined
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelNotLogical":
			case "DecoderUnreplicated":
			case "LedgerUncompiled":
			case "LedgerUnread":
			case "LedgerDamaged":
			case "AppliedEdited":
			case "FolderRefused":
			case "SnapshotUnreached":
			case "MarkersUnresolved":
			case "LossesUndecided":
			case "StatementFailed":
			case "TransactionFailed":
			case "LedgerUnlocked":
			case "RecordFailed":
			case "FileCommitRefused":
			case "FileCommitLost":
			case "Drifted":
			case "DriftUnchecked":
				return reason.schema
		}
	}

	/** Where in the schema's migrations directory the failure is. */
	get place(): MigrationPlace {
		const reason = this.reason
		switch (reason._tag) {
			case "InputRefused": {
				const refused: InputRefused = reason
				return refused.place
			}
			case "AppliedEdited":
				return fileOf(reason.edits[0])
			case "MarkersUnresolved":
				return fileOf(reason.markers[0])
			case "LossesUndecided":
				return fileOf(reason.losses[0])
			case "FolderRefused":
				return { kind: "folder", folder: reason.folder }
			case "StatementFailed":
				return {
					kind: "statement",
					folder: reason.folder,
					file: reason.file,
					statement: reason.statement
				}
			case "TransactionFailed":
			case "FileCommitRefused":
				return fileOf(reason)
			case "LedgerUnlocked":
			case "RecordFailed":
			case "FileCommitLost":
				return reason.at
			case "ConnectRefused":
			case "SurveyFailed":
			case "StackTooShallow":
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelNotLogical":
			case "DecoderUnreplicated":
			case "LedgerUncompiled":
			case "LedgerUnread":
			case "LedgerDamaged":
			case "SnapshotUnreached":
			case "Drifted":
			case "DriftUnchecked":
			case "NamespaceUnread":
			case "UninstallRefused":
				return directory
		}
	}

	/** What the server said of a failure in a file or of the drift check's reads; nothing at any other stage. */
	get server(): ServerReport {
		const reason = this.reason
		switch (reason._tag) {
			case "StatementFailed":
			case "TransactionFailed":
			case "LedgerUnlocked":
			case "RecordFailed":
			case "FileCommitRefused":
			case "NamespaceUnread":
			case "UninstallRefused":
				return serverReport(reason.failure)
			case "DriftUnchecked": {
				const unchecked: DriftUnchecked = reason
				return unchecked.server
			}
			case "ConnectRefused":
			case "SurveyFailed":
			case "StackTooShallow":
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelNotLogical":
			case "DecoderUnreplicated":
			case "LedgerUncompiled":
			case "LedgerUnread":
			case "LedgerDamaged":
			case "AppliedEdited":
			case "FolderRefused":
			case "SnapshotUnreached":
			case "MarkersUnresolved":
			case "LossesUndecided":
			case "FileCommitLost":
			case "Drifted":
				return noServerReport
		}
	}

	override get message(): string {
		return `the migration stopped at stage ${this.stage}: ${this.reason.message}`
	}
}

/** The MigrateError of `reason`. */
export const stopped = (reason: MigrateReason): MigrateError => new MigrateError({ reason })
