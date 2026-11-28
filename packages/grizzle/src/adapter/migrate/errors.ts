import { isAsciiDigits } from "@bjornpagen/grizzle-text/text"
import { Array as Arr, Data, Formatter, Option, String as Str } from "effect"
import type { DriftMismatch } from "#adapter/admission/drift.ts"
import type { StoredSetting } from "#adapter/admission/roles.ts"
import type { AdviceUnloaded } from "#adapter/errors/execution.ts"
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
	type LockTableSettings,
	lockTableText,
	maxConnectionsFor,
	maxLocksPerTransactionFor,
	specialWorkerProcesses
} from "#adapter/migrate/locks.ts"
import {
	catalogDeparted,
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
 * - Before any statement of any folder ran: `connect`, `stack` (the server's max_stack_depth below the default the
 *   pattern limits were measured at), `blocks` (the server's block size other than the one grizzle's page bounds were
 *   derived from), `advice` (the session does not load pg_plan_advice, or the migration role's own
 *   session_preload_libraries leaves what the logins' sessions load unknown), `wal` (the server's wal_level minimal,
 *   which no live source decodes at),
 *   `owner`, `input`, `busy`, `ledger`, `edited`, `order`, `marker`, `decision` and `locks` (the server's lock table
 *   smaller than the apply's largest transaction as its folders state it). Nothing was written; the ledger and
 *   the catalog are as they were. `edited` is an applied
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
 * - After every folder applied: `replication`, a live source's decoder login left with no replication right, which the
 *   migration identity could not give it, before any drift check ran; `drift`, the drift check of the catalog against
 *   the target snapshot
 *   (adapter/admission/drift.ts; edits are allowed, drift is not), with every mismatch; or `unchecked`, a drift check
 *   that reached no verdict, because the snapshot did not render, the ledger or the catalog could not be read, or the
 *   replay that builds the snapshot beside the schema was refused. The check changed nothing: it rolled back.
 */
export type MigrateStage =
	| "connect"
	| "stack"
	| "blocks"
	| "advice"
	| "wal"
	| "owner"
	| "input"
	| "busy"
	| "ledger"
	| "edited"
	| "order"
	| "marker"
	| "decision"
	| "locks"
	| "statement"
	| "record"
	| "commit"
	| "replication"
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
	stack: "nothingRan",
	blocks: "nothingRan",
	advice: "nothingRan",
	wal: "nothingRan",
	owner: "nothingRan",
	input: "nothingRan",
	busy: "nothingRan",
	ledger: "nothingRan",
	edited: "nothingRan",
	order: "nothingRan",
	marker: "nothingRan",
	decision: "nothingRan",
	locks: "nothingRan",
	statement: "resumes",
	record: "resumes",
	commit: "resumes",
	replication: "noVerdict",
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
 * The server's lock table as its settings size it (adapter/migrate/locks.ts), read in the migration's session once the
 * refused transaction rolled back; or the read's own failure, when that session could not answer it.
 */
export type ServerLockTable =
	| { readonly kind: "read"; readonly settings: LockTableSettings }
	| { readonly kind: "unread"; readonly failure: ReadFailure }

/** The lock table's size, as a refusal states it. */
const serverLockTableText = (table: ServerLockTable): string => {
	switch (table.kind) {
		case "read":
			return lockTableText(table.settings)
		case "unread":
			return `max_locks_per_transaction × (max_connections + autovacuum_worker_slots + max_worker_processes + max_wal_senders + ${specialWorkerProcesses} + max_prepared_transactions) locks (its settings could not be read: ${failureText(table.failure)})`
	}
}

/**
 * A statement of a migration's transaction, a file's or the drift check's replay, the server refused for want of shared
 * memory (SQLSTATE 53200, its report kept): a transaction holds one lock per object it creates or alters until it ends,
 * and the server's lock table, `table`, is shared by every transaction at once and holds exactly what its settings size,
 * so a migration that creates more objects than it holds stops, and rolls back whole. The fix is the server's setting,
 * max_locks_per_transaction, which takes a restart; the migration's one transaction stays whole.
 */
export class LockTableExhausted extends Data.TaggedError("LockTableExhausted")<{
	readonly error: ServerError
	readonly table: ServerLockTable
}> {
	override get message(): string {
		return `the server ran out of shared memory for locks (${serverSaid(this.error)}): a migration's transaction holds one lock per object it creates or alters until it ends, and the server's lock table holds ${serverLockTableText(this.table)} for every transaction at once; raise max_locks_per_transaction (a server restart) until it holds more than the objects the migration creates, then run grizzle migrate again`
	}
}

/**
 * The transaction of an apply that holds the most locks, as its folders state them: a file's, by its folder's meta.json
 * (deploy/locks/demand.ts fileLockSets), or the drift check's replay of a schema's first migration, which replays every
 * object of its snapshot, none yet proven.
 */
export type LockedTransaction =
	| { readonly kind: "file"; readonly folder: string; readonly file: string }
	| { readonly kind: "replay" }

/**
 * The server's lock table, `table`, holds fewer objects locked at once than the apply's largest transaction, `at` of
 * `schema`, states it holds (`locks`), with the apply locks the session holds through every transaction (`held`, one
 * per schema): refused in the survey, before any statement of any folder ran, where the transaction would have run out
 * of the table and rolled back with 53200 (LockTableExhausted). The fix is the server's max_locks_per_transaction (a
 * restart), or its max_connections, each stated at the least that holds the transaction; other sessions' locks share
 * the table, and are not counted.
 */
export class LockTableShort extends Data.TaggedError("LockTableShort")<{
	readonly schema: string
	readonly at: LockedTransaction
	readonly locks: number
	readonly held: number
	readonly table: LockTableSettings
}> {
	override get message(): string {
		const total = this.locks + this.held
		const where =
			this.at.kind === "file"
				? `${this.at.folder}/${this.at.file}'s transaction holds ${this.locks} locks, as its meta.json states`
				: `the drift check of its first migration replays every object of the snapshot, ${this.locks} locks`
		return `the server's lock table holds ${lockTableText(this.table)} for every transaction at once, and in ${this.schema} ${where}, ${total} with the ${this.held} apply lock${this.held === 1 ? "" : "s"} the session holds: set max_locks_per_transaction to ${maxLocksPerTransactionFor(total, this.table)} or more (a server restart), or max_connections to ${maxConnectionsFor(total, this.table)} or more, then run grizzle migrate again; nothing ran`
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

/**
 * The server's block size, `observed` bytes as current_setting reports it, is not `required`, PostgreSQL's default,
 * which every bound grizzle holds a key, a row and an index entry to was derived from (core/page.ts blockSize), so the
 * server would refuse keys and rows grizzle admits, or admit what it refuses. A server's block size is fixed when it is
 * built.
 */
export class BlockSizeMismatched extends Data.TaggedError("BlockSizeMismatched")<{
	readonly observed: string
	readonly required: number
}> {
	override get message(): string {
		return `the server's block_size is ${this.observed} bytes, where every bound grizzle holds a key and a row to was derived from ${String(this.required)}, PostgreSQL's default`
	}
}

/**
 * The migration identity stores its own session_preload_libraries (ALTER ROLE ... SET, for every database or this one
 * alone), so the libraries its session loads say nothing of the logins' sessions, whose own settings the drift check
 * holds to the snapshot's, none of them this: grizzle cannot tell that every session it serves loads pg_plan_advice.
 * `settings` are the role's own, as pg_db_role_setting stores them.
 */
export class MigratorPreloads extends Data.TaggedError("MigratorPreloads")<{
	readonly settings: Arr.NonEmptyReadonlyArray<StoredSetting>
}> {
	override get message(): string {
		return `the migration role sets its own session_preload_libraries (${Arr.join(
			Arr.map(this.settings, (s) => `${s.scope} ${s.value}`),
			", "
		)}), so its session cannot tell whether the logins' sessions load pg_plan_advice: reset it on the role and load the library for the database or the server`
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
			return `names the variable :${quoteIdent(fault.name)}, which is neither :"DBNAME" nor a role's name: its stem <schema>__<name>, the name a rename sets it aside under, __aside_<digest>, or the installation's decoder login's, __live_<digest>, each as an earlier grizzle spelled it too, with segments before its digest; write a slice with a space after its colon`
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
 * The server's wal_level is minimal: the live source of `schema` reads its changes by logical decoding of the WAL,
 * which PostgreSQL 19 runs at replica, its default, where it turns itself on when the source's slot is made, and at
 * logical, never at minimal, so the apply is refused before any statement runs (live.ts liveSourceRefusal).
 */
export class WalLevelMinimal extends Data.TaggedError("WalLevelMinimal")<{
	readonly schema: string
}> {
	override get message(): string {
		return `the server's wal_level is minimal, and the live source of ${this.schema} decodes the WAL, which PostgreSQL 19 does at wal_level = replica, its default, turning logical decoding on by itself when the source's slot is made, and at logical, but never at minimal: set wal_level = replica and migrate again`
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

/** Why a pending folder cannot continue the ledger's chain (deploy/ledger/decide.ts FolderRefusal). */
type FolderRefusal =
	| { readonly kind: "moved"; readonly source: string; readonly target: string }
	| { readonly kind: "resized"; readonly started: number; readonly holds: number }
	| { readonly kind: "redrafted"; readonly file: string }
	| { readonly kind: "redraftUnverifiable"; readonly file: string }
	| { readonly kind: "partialFirst"; readonly partial: string }
	| { readonly kind: "sortsBefore"; readonly applied: string }
	| { readonly kind: "source"; readonly source: string; readonly latest: string }

/** `folder` of `schema` cannot continue the ledger's chain, for `refusal` (ledger/decide.ts decideFolder). */
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
			case "redraftUnverifiable":
				return `folder ${this.folder} was redrafted after it started, and it would resume at ${refusal.file}, which runs outside a transaction: the ledger cannot tell whether the draft that started the folder ran part of it, so finish the folder under that draft, or settle the catalog by hand`
			case "redrafted":
				return `folder ${this.folder} was redrafted after it started, and its meta.json does not record ${refusal.file} as it ran: a redraft resumes only when it records every completed file as that file's text holds it`
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

/** How a refusal of a migration file names every law its constraint serves (`brokenLaws` in apply.ts), when it does. */
const lawText = (laws: ReadonlyArray<LawId>): string =>
	laws.length === 0
		? ""
		: `, breaking ${laws.length === 1 ? "law" : "one of the laws"} ${Arr.join(laws, ", ")}`

/**
 * Statement `statement` (1-based) of `folder`/`file` failed: `laws` every law the refused constraint serves, by the
 * laws of `folder` itself (its meta.json's FolderLaws), as a refused write names them (apply.ts brokenLaws), none where
 * PostgreSQL named no constraint of the folder's levels.
 */
export class StatementFailed extends Data.TaggedError("StatementFailed")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly statement: number
	readonly failure: StatementFailure
	readonly laws: ReadonlyArray<LawId>
}> {
	/**
	 * Whether the statement met an object it names missing from the catalog or already in it (core/sqlstate.ts
	 * catalogDeparted), but another session's own (`sessionHeld`): the installation may have drifted from its snapshot,
	 * an object dropped or created outside any migration, which `grizzle drift` reports. The file's transaction rolled
	 * back, so nothing of it applied.
	 */
	get drifted(): boolean {
		return (
			this.failure._tag === "ServerError" &&
			catalogDeparted.has(this.failure.sqlstate) &&
			!sessionHeld(this.failure)
		)
	}

	override get message(): string {
		return `${this.folder}/${this.file} statement ${this.statement} failed${lawText(this.laws)}: ${failureText(this.failure)}${this.drifted ? driftedFix : ""}${sessionHeld(this.failure) ? sessionHeldFix : ""}${rowsFix(this.failure)}${inUseFix(this.failure)}`
	}
}

/** What a statement over an object the catalog departs in tells the operator (StatementFailed drifted). */
const driftedFix =
	"; the installation may have drifted from its snapshot, an object this statement names dropped, created or depended on outside any migration: run grizzle drift to see what changed, undo it, then run grizzle migrate again"

/** The schema a session's own temporary objects stand in, `pg_temp_<its proc number>`, as a DETAIL line names one. */
const temporarySchemaLead = " pg_temp_"

/** Whether a DETAIL line names an object in a session's temporary schema: its lead, then digits, then the dot. */
const namesTemporary = (line: string): boolean =>
	Option.match(Str.indexOf(temporarySchemaLead)(line), {
		onNone: () => false,
		onSome: (at) => {
			const rest = Str.slice(at + temporarySchemaLead.length)(line)
			return Option.match(Str.indexOf(".")(rest), {
				onNone: () => false,
				onSome: (dot) => dot > 0 && isAsciiDigits(rest, 0, dot)
			})
		}
	})

/**
 * Whether the server refused a drop (2BP01) for an object of another session's own, which its DETAIL names in that
 * session's temporary schema: a temporary table typed by what the statement drops, or a function of it, which no
 * migration made and which stands until its session ends. It is no departure of the installation: grizzle's own
 * sessions hold their values by session types (ir/physical.ts sessionTypeRef) and a role's drop ends the sessions
 * holding its objects, so the session is another client's, such as a direct SQL session's.
 */
const sessionHeld = (failure: StatementFailure): boolean =>
	failure._tag === "ServerError" &&
	failure.sqlstate === sqlstates.dependentObjectsStillExist &&
	failure.detail !== undefined &&
	Arr.some(Str.split("\n")(failure.detail), namesTemporary)

/** What a drop another session's temporary object refused tells the operator (`sessionHeld`). */
const sessionHeldFix =
	"; another session's temporary object, in the pg_temp schema the DETAIL names, depends on what this statement drops and stands until that session ends: end that session or let it end, then run grizzle migrate again"

/**
 * The fix of a drop PostgreSQL refused because what it drops is in use (55006): a replication slot a leader still
 * streams from, a live source's (physical/ddl/live.ts dropLiveSlot). grizzle ends no leader, so the operator stops it, a
 * one-time outage, and migrates again. Nothing for any other failure.
 */
const inUseFix = (failure: StatementFailure): string =>
	failure._tag === "ServerError" && failure.sqlstate === sqlstates.objectInUse
		? "; a leader still streams from a replication slot this statement drops, and grizzle ends no leader: stop the leaders of the deployment before this one (a one-time outage), then run grizzle migrate again"
		: ""

/**
 * The fix of a domain's new CHECK refused by rows a column holds, PostgreSQL's VALIDATE of it (a check_violation naming
 * the column and no constraint, typecmds.c validateDomainCheckConstraint), a removed handle's code among them: the data
 * step that changes those rows, preferably a custom migration before the one that tightens the domain, or, now that the
 * refused folder is partially applied and resumes where it stopped, a change outside any migration, an immutable
 * relation's rows deleted and inserted again, never updated, which their guard refuses. Nothing for any other failure.
 */
const rowsFix = (failure: StatementFailure): string =>
	failure._tag === "ServerError" &&
	failure.sqlstate === sqlstates.checkViolation &&
	failure.column !== undefined &&
	failure.constraint === undefined
		? "; change or delete those rows in a data step first, preferably a custom migration (grizzle generate --custom) drafted before this one, or, now that this folder resumes where it stopped, outside any migration: delete an immutable relation's rows and insert them again, never UPDATE them"
		: ""

/**
 * Statement `statement` (1-based) of a custom migration's no-transaction file `folder`/`file` wrote `table`, whose
 * immutability guard refused it: a statement run alone has no transaction for the guard to be dropped in and created
 * again before it commits, as a transactional data step's is (apply.ts guardBracket), so it must run in one.
 */
export class GuardedTableUnbracketed extends Data.TaggedError("GuardedTableUnbracketed")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly statement: number
	readonly table: string
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `${this.folder}/${this.file} statement ${this.statement} writes ${this.table}, whose immutability guard refused it: a no-transaction custom step cannot write a guarded table; use a transactional step`
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
 * The plan advice of the file at `at`, its transaction's first statement (deploy/ledger/ledger.ts LedgerStatements
 * `advise`), was refused, so the file rolled back before any statement of it ran.
 */
export class AdviceRefused extends Data.TaggedError("AdviceRefused")<{
	readonly schema: string
	readonly at: RecordPlace
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `the plan advice of ${recordText(this.at)} could not be set: ${failureText(this.failure)}`
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
 * The deferred laws of `folder`/`file` refused it, at its COMMIT or made immediate after its statements in a custom
 * migration's bracket, beside its re-checks (physical/ddl/immutable.ts dataStepBracket), so the file rolled back with
 * its ledger row: `laws` every law the deferred constraint that refused it serves, by the laws of `folder` itself (its
 * meta.json's FolderLaws, apply.ts brokenLaws).
 */
export class FileCommitRefused extends Data.TaggedError("FileCommitRefused")<{
	readonly schema: string
	readonly folder: string
	readonly file: string
	readonly failure: StatementFailure
	readonly laws: ReadonlyArray<LawId>
}> {
	override get message(): string {
		return `the deferred laws of ${this.folder}/${this.file} refused it${lawText(this.laws)}: ${failureText(this.failure)}`
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
	/** The manifest identity of the object the refused statement builds. */
	readonly object: string
	readonly failure: ServerError | LockTableExhausted
}> {
	override get message(): string {
		return `statement ${this.statement} of ${this.of} of the replay, which builds ${this.object}, was refused: ${failureText(this.failure)}`
	}
}

/**
 * The drift check of `schema` found no drift, but its proofs could not be recorded (deploy/ledger/ledger.ts
 * proofsTable): every folder applied and the catalog is the snapshot's, and a rerun checks it again, replaying what the
 * proofs it finds do not prove, and records them.
 */
export class ProofsUnrecorded extends Data.TaggedError("ProofsUnrecorded")<{
	readonly schema: string
	readonly failure: StatementFailure
}> {
	override get message(): string {
		return `the drift check of ${this.schema} found no drift, but its proofs could not be recorded: ${failureText(this.failure)}`
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
	| BlockSizeMismatched
	| AdviceUnloaded
	| MigratorPreloads
	| LockTableShort
	| RoleUnread
	| OwnerUnread
	| OwnedByAnother
	| InputRefused
	| LockUnread
	| ApplyBusy
	| WalLevelMinimal
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
	| GuardedTableUnbracketed
	| TransactionFailed
	| LedgerUnlocked
	| AdviceRefused
	| RecordFailed
	| FileCommitRefused
	| FileCommitLost
	| Drifted
	| DriftUnchecked
	| ProofsUnrecorded
	| NamespaceUnread
	| UninstallRefused

/** The stage each reason stops at. */
const stageOf: { readonly [Tag in MigrateReason["_tag"]]: MigrateStage } = {
	ConnectRefused: "connect",
	SurveyFailed: "owner",
	StackTooShallow: "stack",
	BlockSizeMismatched: "blocks",
	AdviceUnloaded: "advice",
	MigratorPreloads: "advice",
	LockTableShort: "locks",
	RoleUnread: "owner",
	OwnerUnread: "owner",
	OwnedByAnother: "owner",
	InputRefused: "input",
	LockUnread: "busy",
	ApplyBusy: "busy",
	WalLevelMinimal: "wal",
	DecoderUnreplicated: "replication",
	LedgerUncompiled: "ledger",
	LedgerUnread: "ledger",
	LedgerDamaged: "ledger",
	AppliedEdited: "edited",
	FolderRefused: "order",
	SnapshotUnreached: "order",
	MarkersUnresolved: "marker",
	LossesUndecided: "decision",
	StatementFailed: "statement",
	GuardedTableUnbracketed: "statement",
	TransactionFailed: "statement",
	LedgerUnlocked: "record",
	AdviceRefused: "record",
	RecordFailed: "record",
	FileCommitRefused: "commit",
	FileCommitLost: "commit",
	Drifted: "drift",
	DriftUnchecked: "unchecked",
	ProofsUnrecorded: "record",
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
			case "BlockSizeMismatched":
			case "AdviceUnloaded":
			case "MigratorPreloads":
			case "RoleUnread":
			case "NamespaceUnread":
			case "UninstallRefused":
				return undefined
			case "LockTableShort":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelMinimal":
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
			case "GuardedTableUnbracketed":
			case "TransactionFailed":
			case "LedgerUnlocked":
			case "AdviceRefused":
			case "RecordFailed":
			case "FileCommitRefused":
			case "FileCommitLost":
			case "Drifted":
			case "DriftUnchecked":
			case "ProofsUnrecorded":
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
			case "GuardedTableUnbracketed":
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
			case "AdviceRefused":
			case "RecordFailed":
			case "FileCommitLost":
				return reason.at
			case "LockTableShort":
				return reason.at.kind === "file"
					? { kind: "file", folder: reason.at.folder, file: reason.at.file }
					: directory
			case "ConnectRefused":
			case "SurveyFailed":
			case "StackTooShallow":
			case "BlockSizeMismatched":
			case "AdviceUnloaded":
			case "MigratorPreloads":
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelMinimal":
			case "DecoderUnreplicated":
			case "LedgerUncompiled":
			case "LedgerUnread":
			case "LedgerDamaged":
			case "SnapshotUnreached":
			case "Drifted":
			case "DriftUnchecked":
			case "ProofsUnrecorded":
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
			case "GuardedTableUnbracketed":
			case "TransactionFailed":
			case "LedgerUnlocked":
			case "AdviceRefused":
			case "RecordFailed":
			case "FileCommitRefused":
			case "ProofsUnrecorded":
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
			case "BlockSizeMismatched":
			case "AdviceUnloaded":
			case "MigratorPreloads":
			case "LockTableShort":
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
			case "WalLevelMinimal":
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
