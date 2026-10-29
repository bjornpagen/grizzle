import { Array as Arr, Effect, Option, Result, type Scope } from "effect"
import { driftFlight, driftTransaction, ledgerMismatches } from "#adapter/admission/drift.ts"
import type { BatchFailure } from "#adapter/errors/failures.ts"
import {
	ApplyBusy,
	Drifted,
	DriftUnchecked,
	FileCommitLost,
	FileCommitRefused,
	InputRefused,
	LedgerUnlocked,
	LockUnread,
	type MigrateError,
	OwnedByAnother,
	OwnerUnread,
	SurveyFailed,
	type RecordPlace,
	RecordFailed,
	RoleUnread,
	StatementFailed,
	type StatementFailure,
	stopped,
	TransactionFailed
} from "#adapter/migrate/errors.ts"

import {
	type MigrationTarget,
	type ParsedFile,
	type ParsedFolder,
	type ParsedTarget,
	parseTarget
} from "#adapter/migrate/input.ts"

import {
	fileParams,
	folderParams,
	type LedgerRead,
	ledgerOfAnswers,
	ledgerReads,
	statementsFor
} from "#adapter/migrate/ledger.ts"
import { type ApplyPlan, planApply, runFiles } from "#adapter/migrate/plan.ts"
import {
	apartRow,
	apartRows,
	decidingFailure,
	type MigrationConnection,
	type MigrationSession,
	openMigrationSession
} from "#adapter/migrate/session.ts"
import { type ApartAnswer, sentAnswer, type BatchStatement } from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import type { SchemaFingerprint } from "#compiler/core/ids.ts"
import type { LedgerStatements } from "#compiler/deploy/ledger/ledger.ts"
import type { DeploySnapshot } from "#compiler/deploy/snapshot/types.ts"

/**
 * `grizzle migrate`: the apply runner.
 *
 * The command line reads each declared schema's snapshot.json and migration folders and calls applyMigrations with
 * the migration identity's connection: the CLI does the filesystem work, then calls adapter/migrate. Every step sends
 * its statements together, in one flight (session.ts). Before any statement of any folder runs:
 *
 * 1. Input (input.ts), for every schema, before anything is read: each folder's name, meta.json and files read as
 *    drafted; no file controls the transaction itself.
 * 2. The survey step, one flight for every schema: the session's role, then for each schema its owner, its apply lock
 *    and its ledger, each statement apart. Its answers are judged for each schema in the order given:
 *    - Identity. Migrations run as the migration identity, which owns the schema: the role that connects, whatever its
 *      name, for neither the snapshot nor the drafted SQL names it. A schema that exists must be the session role's;
 *      one that does not yet is created by the first migration, and so the role's. Anything else is refused.
 *    - The apply lock. A session-level advisory lock keyed by the schema, taken with pg_try_advisory_lock, so two
 *      applies of one schema never interleave their files; a second apply is refused rather than waiting, because a
 *      waiting statement's snapshot would hold up the first one's CREATE INDEX CONCURRENTLY (its wait for older
 *      snapshots) while the first holds the lock the second waits on. The ledger is read after the lock in the same
 *      flight, so under it when it is taken; a refused apply's read is discarded. Every lock taken is released when the
 *      apply ends, in one step, and with the session in any case.
 *    - The ledger (ledger.ts), its absence read as the schema's empty snapshot, and the plan (plan.ts): which folders
 *      are applied, which resumes, which run; an out-of-order folder, a source that is not the latest target, a chain
 *      that does not end at the known snapshot, or an unresolved marker refuses the apply.
 *
 * Then every planned file runs, folder by folder:
 *
 * - a transactional file: one flight, BEGIN ISOLATION LEVEL SERIALIZABLE, the ledger's ACCESS EXCLUSIVE lock, each
 *   statement in order, then the folder's row if absent and the file's row, then COMMIT; any failure rolls the whole
 *   file back, its row with it;
 * - a no-transaction file (`-- grizzle: no-transaction` first): its folder's row if absent, under the ledger's lock, in
 *   a transaction of its own; then each statement alone, in autocommit, in a step of its own; then the rows, under the
 *   lock, in a transaction of their own. Each statement is a step because whether it runs depends on the answer of the
 *   one before it: a failure stops at the failing statement, so a failed CREATE INDEX CONCURRENTLY never lets a later
 *   statement run, and a rerun runs the file again from its first statement, which its drafted statements make safe;
 * - a folder with no file (an untouched custom migration) records its folder row alone, under the lock.
 *
 * The fence (physical/ddl/ledger.ts snapshotGuardDdl). Every transaction that writes the ledger takes its ACCESS
 * EXCLUSIVE lock first, before any statement of its file, except before the ledger exists, which the schema's first
 * file creates: the lock waits for the Db transactions holding the ledger's ACCESS SHARE lock, and refuses every new one
 * at once, and a folder whose row the ledger holds unfinished refuses them between files. So from the first transaction
 * of a folder until its last commits, no Db call runs and no Db opens: the operator's command waits, never the
 * application.
 *
 * A file's row is written after its statements and inside its transaction, so the ledger says exactly which files
 * committed, and a rerun after any failure, a lost COMMIT acknowledgement included, resumes at the first file without
 * a row. Statements are the file's own, split by the drafted files' splitter, sent as unnamed statements; the runner
 * adds nothing to them, and sets no statement_timeout or lock_timeout.
 *
 * Finally, the drift check (adapter/admission/drift.ts), for every schema and also when nothing was pending, one
 * flight each: the ledger's two reads apart, then the check's transaction, which replays the snapshot's objects into a
 * scratch schema, reads both through PostgreSQL's own deparse in one snapshot, and rolls back. The ledger's latest
 * complete target is the known snapshot with no partial folder, the schema's objects are described exactly as the
 * replayed ones (a constraint not validated and an index not valid included), the role schemas' views alike, and every
 * login's and role's login, settings, privileges, memberships and policies and the database's defaults are the
 * snapshot's. Drift is refused with every mismatch (edits
 * are allowed, drift is not).
 *
 * What an apply did to one schema.
 */
export interface SchemaApplyReport {
	/** The declared schema's name and its PostgreSQL schema. */
	readonly schemaName: string
	readonly schema: string
	/** The latest applied target before and after. */
	readonly before: SchemaFingerprint
	readonly after: SchemaFingerprint
	readonly applied: ReadonlyArray<{
		readonly folder: string
		readonly files: ReadonlyArray<string>
		readonly resumed: boolean
	}>
}

/** The key of a schema's apply lock. */
export const applyLockKey = (schema: string): string => `grizzle migrate ${schema}`
/** The advisory lock id of the key $1, as every apply lock statement computes it. */
export const applyLockKeySql = "pg_catalog.hashtextextended($1::text, 0::bigint)"
/** Whether the lock keyed by $1 was taken. */
const tryLock: CatalogQuery<boolean> = {
	sql: `SELECT pg_catalog.pg_try_advisory_lock(${applyLockKeySql})::text`,
	what: "a Boolean",
	row: ([taken]) => (taken === "true" ? true : taken === "false" ? false : undefined)
}
const unlockSql = `SELECT pg_catalog.pg_advisory_unlock(${applyLockKeySql})::text`
const roleName = ([name]: ReadonlyArray<string>): string | undefined => name
const currentUser: CatalogQuery<string> = {
	sql: "SELECT CURRENT_USER::text",
	what: "a role name",
	row: roleName
}

/** The owner of the schema $1: one row, or none before its first migration. */
const schemaOwner: CatalogQuery<string> = {
	sql: "SELECT pg_catalog.pg_get_userbyid(n.nspowner)::text FROM pg_catalog.pg_namespace AS n WHERE n.nspname = $1::text",
	what: "a role name",
	row: roleName
}

interface Planned {
	readonly snapshot: DeploySnapshot
	readonly statements: LedgerStatements
	readonly plan: ApplyPlan
	/** Whether the ledger existed when the apply read it, under its apply lock. */
	readonly ledger: LedgerTable
}

/** A schema's input, checked before anything is read: its parsed target and its ledger statements. */
interface Checked {
	readonly parsed: ParsedTarget
	readonly statements: LedgerStatements
}

const checkTarget = (target: MigrationTarget): Result.Result<Checked, MigrateError> =>
	Result.flatMap(parseTarget(target), (parsed) =>
		Result.map(statementsFor(parsed.schema), (statements) => ({ parsed, statements }))
	)

/**
 * The survey step's reads of one schema, apart and in this order (see the header): its owner, its apply lock, and
 * its ledger's two reads (ledger.ts ledgerReads).
 */
const schemaReads = (
	schema: string,
	statements: LedgerStatements
): ReadonlyArray<BatchStatement> => [
	{ sql: schemaOwner.sql, params: [schema] },
	{ sql: tryLock.sql, params: [applyLockKey(schema)] },
	...ledgerReads(schema, statements)
]

/**
 * How many statements schemaReads sends, and where a schema's answers start in the survey step: behind the session's
 * role, then the schemas before it.
 */
const readsPerSchema = 4
const answersFrom = (index: number): number => 1 + index * readsPerSchema

/** Whether the survey step took a schema's apply lock: exactly when its statement answered true. */
const lockTaken = (answer: ApartAnswer): boolean => {
	const taken = apartRow(tryLock, answer)
	return Result.isSuccess(taken) && taken.success
}

/**
 * The step that releases the apply locks the survey step took, `answers`, of the schemas `checked`; none when it took
 * none.
 */
const releaseOf = (checked: ReadonlyArray<Checked>, answers: ReadonlyArray<ApartAnswer>) =>
	Arr.flatMap(checked, (c, i) =>
		lockTaken(sentAnswer(answers, answersFrom(i) + 1))
			? [{ sql: unlockSql, params: [applyLockKey(c.parsed.schema)] }]
			: []
	)

/** One schema's checks from its answers in the survey step, from `at` on: owner, lock, ledger and plan. */
const planSchema = (
	checked: Checked,
	answers: ReadonlyArray<ApartAnswer>,
	at: number,
	user: string
): Result.Result<Planned, MigrateError> =>
	Result.gen(function* () {
		const { parsed, statements } = checked
		const schema = parsed.schema
		const [owner] = yield* Result.mapError(
			apartRows(schemaOwner, sentAnswer(answers, at)),
			(failure) => stopped(OwnerUnread.make({ schema, failure }))
		)
		if (owner !== undefined && owner !== user) {
			return yield* Result.fail(stopped(OwnedByAnother.make({ schema, owner, user })))
		}
		const taken = yield* Result.mapError(
			apartRow(tryLock, sentAnswer(answers, at + 1)),
			(failure) => stopped(LockUnread.make({ schema, failure }))
		)
		if (!taken) {
			return yield* Result.fail(stopped(ApplyBusy.make({ schema })))
		}
		const read = yield* Result.mapError(
			ledgerOfAnswers(schema, sentAnswer(answers, at + 2), sentAnswer(answers, at + 3)),
			stopped
		)
		const plan = yield* planApply(parsed, read.state)
		return { snapshot: parsed.snapshot, statements, plan, ledger: read.table }
	})

/**
 * The survey step (see the header): every schema's reads in one flight, every apply lock it took released when the
 * scope ends, in one step, and each schema planned from its answers in the order given. The release is registered as
 * soon as the flight has answered, without a moment for an interruption between; an interruption of the flight itself
 * cancels it, and its session, retired, releases whatever it holds when it closes.
 */
const surveyAll = Effect.fn("surveyAll")(function* (
	session: MigrationSession,
	checked: ReadonlyArray<Checked>
): Effect.fn.Return<ReadonlyArray<Planned>, MigrateError, Scope.Scope> {
	const answers = yield* Effect.mapError(
		Effect.uninterruptibleMask((restore) =>
			Effect.tap(
				restore(
					session.apart([
						{ sql: currentUser.sql, params: [] },
						...Arr.flatMap(checked, (c) => schemaReads(c.parsed.schema, c.statements))
					])
				),
				(read) => {
					const release = releaseOf(checked, read)
					return Arr.isReadonlyArrayNonEmpty(release)
						? Effect.addFinalizer(() => Effect.ignore(session.apart(release)))
						: Effect.void
				}
			)
		),
		(failure) => stopped(SurveyFailed.make({ failure }))
	)
	/** The session's role concerns no schema. */
	const user = yield* Effect.fromResult(
		Result.mapError(apartRow(currentUser, sentAnswer(answers, 0)), (failure) =>
			stopped(RoleUnread.make({ failure }))
		)
	)
	const planned: Array<Planned> = []
	for (const [i, c] of checked.entries()) {
		planned.push(yield* Effect.fromResult(planSchema(c, answers, answersFrom(i), user)))
	}
	return planned
})

/**
 * Runs one file and records it.
 *
 * Each statement alone, in a step of its own: whether it runs depends on the one before it (see the header).
 */
const runFile = (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements,
	folder: ParsedFolder,
	file: ParsedFile,
	ledger: LedgerTable
): Effect.Effect<void, MigrateError> => {
	const at: RecordPlace = { kind: "file", folder: folder.name, file: file.name }
	const fence = fenceOf(statements, ledger)
	const statementFailed = (index: number) => (failure: StatementFailure) =>
		stopped(
			StatementFailed.make({
				schema,
				folder: folder.name,
				file: file.name,
				statement: index + 1,
				failure
			})
		)
	const recordFailed = (failure: StatementFailure) =>
		stopped(RecordFailed.make({ schema, at, failure }))
	/** A COMMIT the server refused, or one the connection was lost during, which may have committed. */
	const commitFailed = (
		failure: Extract<BatchFailure, { readonly _tag: "CommitRefused" | "CommitLost" }>
	) =>
		stopped(
			failure._tag === "CommitRefused"
				? FileCommitRefused.make({
						schema,
						folder: folder.name,
						file: file.name,
						failure: failure.failure
					})
				: FileCommitLost.make({ schema, at })
		)
	const record = [
		{ sql: statements.recordFolder.text, params: folderParams(folder) },
		{ sql: statements.recordFile.text, params: fileParams(folder, file) }
	]
	/**
	 * The file's transaction: the ledger's lock, its statements, if it runs them inside it, then its rows. A refusal
	 * names the lock, the statement or the row that refused it.
	 */
	const transaction = (count: number) =>
		Effect.mapError(
			session.transaction([
				...fence,
				...Arr.map(file.statements.slice(0, count), (sql) => ({ sql, params: [] })),
				...record
			]),
			(failure: BatchFailure) => {
				switch (failure._tag) {
					case "BatchRefused":
					case "StaleName": {
						const index = failure.index - fence.length
						return index < 0
							? lockFailed(schema, at, failure.failure)
							: index < count
								? statementFailed(index)(failure.failure)
								: recordFailed(failure.failure)
					}
					case "CommitRefused":
					case "CommitLost":
						return commitFailed(failure)
					case "ConnectionLost":
					case "DriverFailure":
					case "UnreadableAnswer":
						return stopped(
							TransactionFailed.make({ schema, folder: folder.name, file: file.name, failure })
						)
				}
			}
		)
	if (!file.noTransaction) {
		return transaction(file.statements.length)
	}
	return Effect.andThen(
		recordFolderRow(session, schema, statements, folder, ledger),
		Effect.andThen(
			Effect.forEach(
				file.statements,
				(sql, index) =>
					Effect.flatMap(
						Effect.mapError(session.apart([{ sql, params: [] }]), statementFailed(index)),
						(answers) =>
							Effect.mapError(Effect.fromResult(sentAnswer(answers, 0)), statementFailed(index))
					),
				{ discard: true }
			),
			transaction(0)
		)
	)
}

/** Whether the schema's ledger exists before a transaction of the apply: absent only before its first file committed. */
type LedgerTable = LedgerRead["table"]

/**
 * The lock every transaction of the apply that writes the ledger takes first, before any statement of its file: the
 * ledger's ACCESS EXCLUSIVE, which waits for the Db transactions holding its fence and refuses every new one at once
 * (physical/ddl/ledger.ts snapshotGuardDdl). None before the ledger exists: the schema's first file creates it, and no
 * Db opens before the ledger records a folder.
 */
const fenceOf = (
	statements: LedgerStatements,
	ledger: LedgerTable
): ReadonlyArray<BatchStatement> => {
	switch (ledger) {
		case "absent":
			return []
		case "present":
			return [{ sql: statements.exclusive.text, params: [] }]
	}
}

/** The ledger's lock refused or failed. */
const lockFailed = (schema: string, at: RecordPlace, failure: StatementFailure): MigrateError =>
	stopped(LedgerUnlocked.make({ schema, at, failure }))

/**
 * The folder row alone, under the ledger's lock: a folder without files, and a no-transaction file's folder before its
 * first statement runs, so the ledger holds the folder unfinished while its statements run alone and no Db runs then.
 */
const recordFolderRow = (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements,
	folder: ParsedFolder,
	ledger: LedgerTable
): Effect.Effect<void, MigrateError> => {
	const at: RecordPlace = { kind: "folder", folder: folder.name }
	const fence = fenceOf(statements, ledger)
	const failed = (failure: StatementFailure) => stopped(RecordFailed.make({ schema, at, failure }))
	return Effect.mapError(
		session.transaction([
			...fence,
			{ sql: statements.recordFolder.text, params: folderParams(folder) }
		]),
		(failure: BatchFailure) => {
			switch (failure._tag) {
				case "BatchRefused":
				case "StaleName":
					return failure.index < fence.length
						? lockFailed(schema, at, failure.failure)
						: failed(failure.failure)
				case "CommitRefused":
					return failed(failure.failure)
				case "CommitLost":
					return stopped(FileCommitLost.make({ schema, at }))
				case "ConnectionLost":
				case "DriverFailure":
				case "UnreadableAnswer":
					return failed(failure)
			}
		}
	)
}

/** Runs a schema's plan. */
const runPlan = Effect.fn("runPlan")(function* (
	session: MigrationSession,
	planned: Planned
): Effect.fn.Return<SchemaApplyReport, MigrateError> {
	const { plan, statements } = planned
	/** The ledger exists once any transaction of the apply committed: the schema's first file creates it. */
	let ledger = planned.ledger
	for (const r of plan.runs) {
		if (r.folder.files.length === 0) {
			yield* recordFolderRow(session, plan.schema, statements, r.folder, ledger)
			ledger = "present"
		}
		for (const f of runFiles(r)) {
			yield* runFile(session, plan.schema, statements, r.folder, f, ledger)
			ledger = "present"
		}
	}
	return {
		schemaName: planned.snapshot.schemaName,
		schema: plan.schema,
		before: plan.before.latest,
		after: plan.after,
		applied: Arr.map(plan.runs, (r) => ({
			folder: r.folder.name,
			files: Arr.map(runFiles(r), (f) => f.name),
			resumed: r.kind === "resume"
		}))
	}
})

/**
 * The drift check of one schema (adapter/admission/drift.ts), in one flight (see the header): the ledger's two reads
 * apart, then the drift check's transaction, which it rolls back. migrate runs it after every apply; `grizzle drift` runs
 * it alone. A folder not yet applied is the ledger's mismatch: the latest complete folder's target is not the snapshot.
 * The migration identity owns the schema and every object in it.
 */
export const checkDrift = Effect.fn("checkDrift")(function* (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	statements: LedgerStatements
): Effect.fn.Return<void, MigrateError> {
	const schema = snapshot.schema
	const unchecked = (failure: DriftUnchecked["failure"]) =>
		stopped(DriftUnchecked.make({ schema, failure }))
	const flight = yield* Effect.mapError(Effect.fromResult(driftFlight(snapshot)), unchecked)
	const answered = yield* Effect.mapError(
		session.alongside(ledgerReads(schema, statements), flight.statements, driftTransaction),
		unchecked
	)
	const read = yield* Effect.mapError(
		Effect.fromResult(
			ledgerOfAnswers(schema, sentAnswer(answered.alone, 0), sentAnswer(answered.alone, 1))
		),
		unchecked
	)
	const outcomes = yield* Effect.mapError(Effect.fromResult(answered.framed), (failure) =>
		failure.pipe(decidingFailure, unchecked)
	)
	const drift = yield* Effect.mapError(flight.read(outcomes), unchecked)
	/** Each mismatch is a fact of its own, which the report lists one per line. */
	const mismatches = [...ledgerMismatches(snapshot, read.state), ...drift]
	if (Arr.isReadonlyArrayNonEmpty(mismatches)) {
		return yield* stopped(Drifted.make({ schema, snapshot: snapshot.fingerprint, mismatches }))
	}
})

/**
 * Applies every target on a session: checks and plans every schema first, then runs the plans in order, then admits
 * every schema. A refusal of any schema's checks runs no statement of any folder.
 */
export const applyOnSession = Effect.fn("applyOnSession")(function* (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Effect.fn.Return<ReadonlyArray<SchemaApplyReport>, MigrateError, Scope.Scope> {
	const schemas = Arr.map(targets, (t) => t.snapshot.schema)
	const repeated = Arr.findFirst(schemas, (s, i) => schemas.indexOf(s) !== i)
	if (Option.isSome(repeated)) {
		return yield* stopped(
			InputRefused.make({ schema: repeated.value, fault: { kind: "repeatedSchema" } })
		)
	}
	const checked: Array<Checked> = []
	for (const t of targets) {
		checked.push(yield* Effect.fromResult(checkTarget(t)))
	}
	const planned = yield* surveyAll(session, checked)
	const reports: Array<SchemaApplyReport> = []
	for (const p of planned) {
		reports.push(yield* runPlan(session, p))
	}
	for (const p of planned) {
		yield* checkDrift(session, p.snapshot, p.statements)
	}
	return reports
}, Effect.scoped)

/**
 * Checks every target's catalog against its snapshot without applying anything: the drift check of each schema, in
 * order, with no apply lock taken and no file run. The first schema that drifts refuses, as migrate's drift stage does.
 */
const driftOnSession = Effect.fn("driftOnSession")(function* (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Effect.fn.Return<void, MigrateError> {
	for (const t of targets) {
		const checked = yield* Effect.fromResult(checkTarget(t))
		yield* checkDrift(session, checked.parsed.snapshot, checked.statements)
	}
})

/** `grizzle drift`: connects as the migration identity and checks every target's catalog, applying nothing. */
export const checkDriftOf = Effect.fn("checkDriftOf")(function* (input: {
	readonly connection: MigrationConnection
	readonly targets: ReadonlyArray<MigrationTarget>
}): Effect.fn.Return<void, MigrateError, Scope.Scope> {
	const session = yield* openMigrationSession(input.connection)
	return yield* driftOnSession(session, input.targets)
}, Effect.scoped)

/**
 * `grizzle migrate`: connects as the migration identity and applies every target.
 *
 * Every target's input is checked before connecting.
 */
export const applyMigrations = Effect.fn("applyMigrations")(function* (input: {
	readonly connection: MigrationConnection
	readonly targets: ReadonlyArray<MigrationTarget>
}): Effect.fn.Return<ReadonlyArray<SchemaApplyReport>, MigrateError, Scope.Scope> {
	for (const t of input.targets) {
		yield* Effect.asVoid(Effect.fromResult(parseTarget(t)))
	}
	const session = yield* openMigrationSession(input.connection)
	return yield* applyOnSession(session, input.targets)
}, Effect.scoped)
