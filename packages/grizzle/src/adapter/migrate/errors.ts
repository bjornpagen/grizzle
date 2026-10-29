import { Array as Arr, Schema } from "effect"
import { DriftMismatch } from "#adapter/admission/drift.ts"
import {
	CatalogRowRefused,
	CompileErrorSchema,
	ConnectionLost,
	ConnectRefusalSchema,
	DriverFailure,
	ServerError,
	UnreadableAnswer
} from "#adapter/errors/failures.ts"
import { compileReasonText } from "#compiler/core/errors.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"

/**
 * The failure of `grizzle migrate` and `grizzle drift`.
 *
 * The apply runner is not part of the library's public API: the command line drives it, so its failure is one internal
 * MigrateError the CLI reports, whose classified case is its `reason`: one of the classes here, each a
 * Schema.TaggedError carrying exactly what happened and rendering its own `message`. What follows from a reason is a
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
 * - After every folder applied: `drift`, the drift check of the catalog against the target snapshot
 *   (adapter/admission/drift.ts; edits are allowed, drift is not), with every mismatch.
 */
export type MigrateStage =
	| "connect"
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

/** The stages at which no statement of any folder has run. */
export const refusalStages: ReadonlySet<MigrateStage> = new Set([
	"connect",
	"owner",
	"input",
	"busy",
	"ledger",
	"edited",
	"order",
	"marker",
	"decision"
])

/** A statement apart's answer that is no row its query reads: the server's refusal, or a row the catalog cannot give. */
const RowFailureSchema = Schema.Union([ServerError, CatalogRowRefused])
type RowFailure = typeof RowFailureSchema.Type

/** A step that failed as a whole: the connection lost, the driver, or an answer grizzle cannot read. */
const FlightFailureSchema = Schema.Union([ConnectionLost, DriverFailure, UnreadableAnswer])
type FlightFailure = typeof FlightFailureSchema.Type

/**
 * How one statement fails: the server refused it, the session failed, it answered rows grizzle's SQL cannot deliver,
 * or the catalog answered what the statement cannot.
 */
const StatementFailureSchema = Schema.Union([RowFailureSchema, FlightFailureSchema])
export type StatementFailure = RowFailure | FlightFailure

const serverSaid = (e: ServerError): string =>
	`SQLSTATE ${e.sqlstate}${e.constraint === undefined ? "" : ` (constraint ${e.constraint})`}: ${e.message}`

/** A statement's failure, as a refusal's message states it after a colon. */
const failureText = (failure: StatementFailure): string => {
	switch (failure._tag) {
		case "ServerError":
			return serverSaid(failure)
		case "ConnectionLost":
			return `the connection was lost${failure.ended.by === "server" ? `: ${serverSaid(failure.ended.error)}` : ""}`
		case "CatalogRowRefused":
			return `the catalog's answer is not ${failure.what}`
		case "DriverFailure":
			return "the driver refused it"
		case "UnreadableAnswer":
			return "it answered rows grizzle cannot read"
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
		case "ConnectionLost":
			return failure.ended.by === "server" ? failure.ended : noServerReport
		case "CatalogRowRefused":
		case "DriverFailure":
		case "UnreadableAnswer":
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
const RecordPlaceSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("folder"), folder: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("file"), folder: Schema.String, file: Schema.String })
])
export type RecordPlace = typeof RecordPlaceSchema.Type

const recordText = (at: RecordPlace): string =>
	at.kind === "folder" ? at.folder : `${at.folder}/${at.file}`

/** An unresolved placeholder or candidate-rename marker in a file the apply would run; its line is 1-based. */
const UnresolvedMarker = Schema.Struct({
	folder: Schema.String,
	file: Schema.String,
	kind: Schema.Literals(["placeholder", "rename"]),
	line: Schema.Int
})
export type UnresolvedMarker = typeof UnresolvedMarker.Type

/**
 * A loss of stored data in a folder the apply would run that the reviewer has not decided: its statement still
 * commented, and no candidate rename that carries the data chosen (render/chosen.ts lossDecisions).
 */
const UnresolvedLoss = Schema.Struct({
	folder: Schema.String,
	file: Schema.String,
	/** What it loses (chosen.ts lossText). */
	loses: Schema.String
})
export type UnresolvedLoss = typeof UnresolvedLoss.Type

/**
 * An applied folder's file that no longer matches its ledger row: its text was edited after it ran, it was deleted,
 * or it was added to a folder every file of which had already run.
 */
const AppliedEdit = Schema.Struct({
	folder: Schema.String,
	file: Schema.String,
	kind: Schema.Literals(["edited", "missing", "added"])
})
export type AppliedEdit = typeof AppliedEdit.Type

/** What each applied edit says after its file's path, with its fix. */
export const appliedEditPhrase: Readonly<Record<AppliedEdit["kind"], string>> = {
	edited: "was edited after it was applied; restore it from git",
	missing: "was applied but is missing; restore it from git",
	added:
		"was added after its folder was applied; move it into a new migration (grizzle generate --custom)"
}

const fileOf = (first: { readonly folder: string; readonly file: string }): MigrationPlace => ({
	kind: "file",
	folder: first.folder,
	file: first.file
})

/** The migration identity could not connect to `host`:`port` as `role`, for `refusal`; no schema is concerned yet. */
export class ConnectRefused extends Schema.TaggedError<
	ConnectRefused,
	{ readonly brand: unique symbol }
>()("ConnectRefused", {
	role: Schema.String,
	host: Schema.String,
	port: Schema.Int,
	refusal: ConnectRefusalSchema
}) {
	override get message(): string {
		return `the migration identity ${this.role} could not connect to ${this.host}:${this.port}: ${this.refusal.message}`
	}
}

/** The survey step, which reads the session's role and each schema's owner, apply lock and ledger, failed whole. */
export class SurveyFailed extends Schema.TaggedError<
	SurveyFailed,
	{ readonly brand: unique symbol }
>()("SurveyFailed", { failure: FlightFailureSchema }) {
	override get message(): string {
		return `the session's role and its schemas' owners, apply locks and ledgers could not be read: ${failureText(this.failure)}`
	}
}

/** The session's role could not be read, which concerns no schema. */
export class RoleUnread extends Schema.TaggedError<RoleUnread, { readonly brand: unique symbol }>()(
	"RoleUnread",
	{
		failure: RowFailureSchema
	}
) {
	override get message(): string {
		return `the session's role could not be read: ${failureText(this.failure)}`
	}
}

/** The owner of `schema` could not be read. */
export class OwnerUnread extends Schema.TaggedError<
	OwnerUnread,
	{ readonly brand: unique symbol }
>()("OwnerUnread", {
	schema: Schema.String,
	failure: RowFailureSchema
}) {
	override get message(): string {
		return `the owner of ${this.schema} could not be read: ${failureText(this.failure)}`
	}
}

/** `schema` is owned by `owner`, another role than `user`, the connecting one. */
export class OwnedByAnother extends Schema.TaggedError<
	OwnedByAnother,
	{ readonly brand: unique symbol }
>()("OwnedByAnother", { schema: Schema.String, owner: Schema.String, user: Schema.String }) {
	override get message(): string {
		return `schema ${this.schema} is owned by ${this.owner}, not by the connecting role ${this.user}; migrations run as the schema's owner`
	}
}

/**
 * What a schema's input refuses, before anything is read (input.ts): its schema given twice, a folder's name, a folder
 * given twice, its meta.json malformed or another schema's, a file named twice or meta.json among its SQL files, its
 * files' names (`error`, render/folder.ts orderFolderFiles), or a statement that controls the transaction itself.
 */
const InputFaultSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("repeatedSchema") }),
	Schema.Struct({ kind: Schema.Literal("folderName"), folder: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("repeatedFolder"), folder: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("malformedMeta"),
		folder: Schema.String,
		error: CompileErrorSchema
	}),
	Schema.Struct({
		kind: Schema.Literal("foreignMeta"),
		folder: Schema.String,
		belongs: Schema.Struct({ schemaName: Schema.String, schema: Schema.String }),
		schemaName: Schema.String
	}),
	Schema.Struct({ kind: Schema.Literal("repeatedFile"), folder: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("metaAmongFiles"), folder: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("fileNames"),
		folder: Schema.String,
		error: CompileErrorSchema
	}),
	Schema.Struct({
		kind: Schema.Literal("transactionControl"),
		folder: Schema.String,
		file: Schema.String,
		statement: Schema.Int,
		control: Schema.String
	})
])
export type InputFault = typeof InputFaultSchema.Type

/** `schema`'s snapshot and folders, as the command line read them, are refused for `fault`. */
export class InputRefused extends Schema.TaggedError<
	InputRefused,
	{ readonly brand: unique symbol }
>()("InputRefused", { schema: Schema.String, fault: InputFaultSchema }) {
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
				return `migration folder ${JSON.stringify(fault.folder)} is not named <YYYYMMDDHHMMSS>_<name>`
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
		}
	}
}

/** The apply lock of `schema` could not be taken: its statement did not answer whether it was. */
export class LockUnread extends Schema.TaggedError<LockUnread, { readonly brand: unique symbol }>()(
	"LockUnread",
	{
		schema: Schema.String,
		failure: RowFailureSchema
	}
) {
	override get message(): string {
		return `the apply lock of ${this.schema} could not be taken: ${failureText(this.failure)}`
	}
}

/** Another apply of `schema` holds its apply lock. */
export class ApplyBusy extends Schema.TaggedError<ApplyBusy, { readonly brand: unique symbol }>()(
	"ApplyBusy",
	{
		schema: Schema.String
	}
) {
	override get message(): string {
		return `another grizzle migrate of ${this.schema} is running; the apply is refused before any statement runs`
	}
}

/** The ledger statements of `schema` do not compile. */
export class LedgerUncompiled extends Schema.TaggedError<
	LedgerUncompiled,
	{ readonly brand: unique symbol }
>()("LedgerUncompiled", { schema: Schema.String, error: CompileErrorSchema }) {
	override get message(): string {
		return `the ledger statements of ${this.schema} do not compile: ${compileReasonText(this.error.reason)}`
	}
}

/** The ledger of `schema` could not be read. */
export class LedgerUnread extends Schema.TaggedError<
	LedgerUnread,
	{ readonly brand: unique symbol }
>()("LedgerUnread", { schema: Schema.String, failure: StatementFailureSchema }) {
	override get message(): string {
		return `the ledger of ${this.schema} could not be read: ${failureText(this.failure)}`
	}
}

/**
 * The ledger of `schema` holds rows that are damage no apply leaves behind (ledger/ledger.ts ledgerState); `error` says
 * what.
 */
export class LedgerDamaged extends Schema.TaggedError<
	LedgerDamaged,
	{ readonly brand: unique symbol }
>()("LedgerDamaged", {
	schema: Schema.String,
	error: CompileErrorSchema
}) {
	override get message(): string {
		return `the ledger of ${this.schema} is damaged: ${compileReasonText(this.error.reason)}`
	}
}

/** Applied files of `schema` whose texts are no longer the ones their ledger rows record. */
export class AppliedEdited extends Schema.TaggedError<
	AppliedEdited,
	{ readonly brand: unique symbol }
>()("AppliedEdited", { schema: Schema.String, edits: Schema.NonEmptyArray(AppliedEdit) }) {
	override get message(): string {
		return Arr.join(
			Arr.map(this.edits, (e) => `${e.folder}/${e.file} ${appliedEditPhrase[e.kind]}`),
			"; "
		)
	}
}

/** Why a pending folder cannot continue the ledger's chain (deploy/ledger/ledger.ts FolderRefusal). */
const FolderRefusalSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("moved"), source: Schema.String, target: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("resized"), started: Schema.Int, holds: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("partialFirst"), partial: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("sortsBefore"), applied: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("source"), source: Schema.String, latest: Schema.String })
])

/** `folder` of `schema` cannot continue the ledger's chain, for `refusal` (ledger/ledger.ts decideFolder). */
export class FolderRefused extends Schema.TaggedError<
	FolderRefused,
	{ readonly brand: unique symbol }
>()("FolderRefused", {
	schema: Schema.String,
	folder: Schema.String,
	refusal: FolderRefusalSchema
}) {
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
export class SnapshotUnreached extends Schema.TaggedError<
	SnapshotUnreached,
	{ readonly brand: unique symbol }
>()("SnapshotUnreached", {
	schema: Schema.String,
	known: Schema.String,
	reached: Schema.String,
	by: Schema.Literals(["ledger", "folders"])
}) {
	override get message(): string {
		return this.by === "ledger"
			? `the database's latest applied target is ${this.reached}, but the application knows snapshot ${this.known}, and no pending folder leads there`
			: `the pending folders end at snapshot ${this.reached}, but the application knows snapshot ${this.known}; snapshot.json and the folders disagree`
	}
}

/** Unresolved markers in files of `schema` the apply would run. */
export class MarkersUnresolved extends Schema.TaggedError<
	MarkersUnresolved,
	{ readonly brand: unique symbol }
>()("MarkersUnresolved", {
	schema: Schema.String,
	markers: Schema.NonEmptyArray(UnresolvedMarker)
}) {
	override get message(): string {
		return `unresolved markers, which a reviewer resolves by supplying the value or choosing the rename and deleting the marker line: ${Arr.join(
			Arr.map(this.markers, (m) => `${m.folder}/${m.file}:${m.line} ${m.kind}`),
			", "
		)}`
	}
}

/** Unresolved losses of stored data in folders of `schema` the apply would run. */
export class LossesUndecided extends Schema.TaggedError<
	LossesUndecided,
	{ readonly brand: unique symbol }
>()("LossesUndecided", { schema: Schema.String, losses: Schema.NonEmptyArray(UnresolvedLoss) }) {
	override get message(): string {
		return `unresolved losses of stored data, which a reviewer decides by writing in the statement that loses it or choosing a candidate rename that carries it: ${Arr.join(
			Arr.map(this.losses, (l) => `${l.folder}/${l.file} ${l.loses}`),
			", "
		)}`
	}
}

/** Statement `statement` (1-based) of `folder`/`file` failed. */
export class StatementFailed extends Schema.TaggedError<
	StatementFailed,
	{ readonly brand: unique symbol }
>()("StatementFailed", {
	schema: Schema.String,
	folder: Schema.String,
	file: Schema.String,
	statement: Schema.Int,
	failure: StatementFailureSchema
}) {
	override get message(): string {
		return `${this.folder}/${this.file} statement ${this.statement} failed: ${failureText(this.failure)}`
	}
}

/** The transaction of `folder`/`file` failed whole: its BEGIN refused, the connection lost, or the driver. */
export class TransactionFailed extends Schema.TaggedError<
	TransactionFailed,
	{ readonly brand: unique symbol }
>()("TransactionFailed", {
	schema: Schema.String,
	folder: Schema.String,
	file: Schema.String,
	failure: FlightFailureSchema
}) {
	override get message(): string {
		const begin = this.failure._tag === "ConnectionLost" && this.failure.operation === "begin"
		return `${begin ? "BEGIN" : `${this.folder}/${this.file}`} failed: ${failureText(this.failure)}`
	}
}

/** The lock every ledger write takes first, the ledger's ACCESS EXCLUSIVE, was refused or failed. */
export class LedgerUnlocked extends Schema.TaggedError<
	LedgerUnlocked,
	{ readonly brand: unique symbol }
>()("LedgerUnlocked", {
	schema: Schema.String,
	at: RecordPlaceSchema,
	failure: StatementFailureSchema
}) {
	override get message(): string {
		return `the ledger of ${this.schema} could not be locked: ${failureText(this.failure)}`
	}
}

/**
 * The ledger row of `at` could not be written. The server's 42P01 says the ledger does not exist: a schema's first
 * migration creates it in its first file, so a folder whose first transaction cannot find it ran before the schema was
 * created.
 */
export class RecordFailed extends Schema.TaggedError<
	RecordFailed,
	{ readonly brand: unique symbol }
>()("RecordFailed", {
	schema: Schema.String,
	at: RecordPlaceSchema,
	failure: StatementFailureSchema
}) {
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

/** The COMMIT of `folder`/`file` was refused, so the file rolled back with its ledger row. */
export class FileCommitRefused extends Schema.TaggedError<
	FileCommitRefused,
	{ readonly brand: unique symbol }
>()("FileCommitRefused", {
	schema: Schema.String,
	folder: Schema.String,
	file: Schema.String,
	failure: ServerError
}) {
	override get message(): string {
		return `the COMMIT of ${this.folder}/${this.file} failed: ${failureText(this.failure)}`
	}
}

/** The connection was lost during the COMMIT of `at`, so whether it committed is unknown, and its ledger row tells. */
export class FileCommitLost extends Schema.TaggedError<
	FileCommitLost,
	{ readonly brand: unique symbol }
>()("FileCommitLost", { schema: Schema.String, at: RecordPlaceSchema }) {
	override get message(): string {
		return this.at.kind === "folder"
			? `the connection was lost during the COMMIT recording ${this.at.folder}; whether it committed is unknown, and its ledger row tells`
			: `the connection was lost during the COMMIT of ${this.at.folder}/${this.at.file}; whether it committed is unknown, and its ledger row tells: a rerun resumes after it exactly when it committed`
	}
}

/** After every folder applied, the catalog of `schema` differs from snapshot `snapshot` by each mismatch. */
export class Drifted extends Schema.TaggedError<Drifted, { readonly brand: unique symbol }>()(
	"Drifted",
	{
		schema: Schema.String,
		snapshot: Schema.String,
		mismatches: Schema.NonEmptyArray(DriftMismatch)
	}
) {
	override get message(): string {
		const n = this.mismatches.length
		return `the catalog of ${this.schema} differs from snapshot ${this.snapshot} by ${n} fact${n === 1 ? "" : "s"} (edits are allowed, drift is not)`
	}
}

/**
 * The drift check of `schema` could not compare: the snapshot's installation does not render (a CompileError), its
 * ledger could not be read, or the catalog could not be read.
 */
export class DriftUnchecked extends Schema.TaggedError<
	DriftUnchecked,
	{ readonly brand: unique symbol }
>()("DriftUnchecked", {
	schema: Schema.String,
	failure: Schema.Union([CompileErrorSchema, LedgerUnread, LedgerDamaged, StatementFailureSchema])
}) {
	/** What the server said, when the catalog's reads failed; nothing for a snapshot that does not render or the ledger. */
	get server(): ServerReport {
		const failure = this.failure
		switch (failure._tag) {
			case "CompileError":
			case "LedgerUnread":
			case "LedgerDamaged":
				return noServerReport
			case "ServerError":
			case "ConnectionLost":
			case "CatalogRowRefused":
			case "DriverFailure":
			case "UnreadableAnswer":
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
			case "ServerError":
			case "ConnectionLost":
			case "CatalogRowRefused":
			case "DriverFailure":
			case "UnreadableAnswer":
				return `the catalog of ${this.schema} could not be read: ${failureText(failure)}`
		}
	}
}

/** Why `grizzle migrate` or `grizzle drift` stopped. */
const MigrateReasonSchema = Schema.Union([
	ConnectRefused,
	SurveyFailed,
	RoleUnread,
	OwnerUnread,
	OwnedByAnother,
	InputRefused,
	LockUnread,
	ApplyBusy,
	LedgerUncompiled,
	LedgerUnread,
	LedgerDamaged,
	AppliedEdited,
	FolderRefused,
	SnapshotUnreached,
	MarkersUnresolved,
	LossesUndecided,
	StatementFailed,
	TransactionFailed,
	LedgerUnlocked,
	RecordFailed,
	FileCommitRefused,
	FileCommitLost,
	Drifted,
	DriftUnchecked
])
export type MigrateReason = typeof MigrateReasonSchema.Type

/** The stage each reason stops at. */
const stageOf: { readonly [Tag in MigrateReason["_tag"]]: MigrateStage } = {
	ConnectRefused: "connect",
	SurveyFailed: "owner",
	RoleUnread: "owner",
	OwnerUnread: "owner",
	OwnedByAnother: "owner",
	InputRefused: "input",
	LockUnread: "busy",
	ApplyBusy: "busy",
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
	DriftUnchecked: "drift"
}

/**
 * `grizzle migrate` or `grizzle drift` stopped for `reason`, at the stage that reason stops at. An edit, marker or
 * decision refusal is located at its first edit, marker or loss; a failure in a file, or of the drift check, carries
 * what the server said.
 */
export class MigrateError extends Schema.TaggedError<
	MigrateError,
	{ readonly brand: unique symbol }
>()("MigrateError", { reason: MigrateReasonSchema }) {
	get stage(): MigrateStage {
		return stageOf[this.reason._tag]
	}

	/** The PostgreSQL schema the failure concerns: none for a connection or the session's role. */
	get schema(): string | undefined {
		const reason = this.reason
		switch (reason._tag) {
			case "ConnectRefused":
			case "SurveyFailed":
			case "RoleUnread":
				return undefined
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
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
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "LockUnread":
			case "ApplyBusy":
			case "LedgerUncompiled":
			case "LedgerUnread":
			case "LedgerDamaged":
			case "SnapshotUnreached":
			case "Drifted":
			case "DriftUnchecked":
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
				return serverReport(reason.failure)
			case "DriftUnchecked": {
				const unchecked: DriftUnchecked = reason
				return unchecked.server
			}
			case "ConnectRefused":
			case "SurveyFailed":
			case "RoleUnread":
			case "OwnerUnread":
			case "OwnedByAnother":
			case "InputRefused":
			case "LockUnread":
			case "ApplyBusy":
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
export const stopped = (reason: MigrateReason): MigrateError => MigrateError.make({ reason })
