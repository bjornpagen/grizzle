import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { Array as Arr, Effect, Option, Order, Result, type Scope } from "effect"
import {
	driftCheck,
	type DriftFolder,
	driftTransaction,
	type DriftVerdict,
	heldProofs,
	ledgerMismatches,
	type ProofRow,
	proofRowsRead,
	proofsExistRead,
	proofsPresence,
	type ReplaySpan
} from "#adapter/admission/drift.ts"
import {
	stackDepthColumn,
	stackDepthRequired,
	stackTooShallow
} from "#adapter/admission/expectation.ts"
import type {
	BatchFailure,
	CatalogRowRefused,
	InputTooLarge,
	ServerError
} from "#adapter/errors/failures.ts"
import {
	ApplyBusy,
	Drifted,
	DriftUnchecked,
	FileCommitLost,
	FileCommitRefused,
	GuardedTableUnbracketed,
	InputRefused,
	LedgerUncompiled,
	LedgerUnlocked,
	LockTableExhausted,
	type LockedTransaction,
	LockTableShort,
	LockUnread,
	type MigrateError,
	MigratorPreloads,
	OwnedByAnother,
	OwnerUnread,
	ProofsUnrecorded,
	SurveyFailed,
	type RecordPlace,
	RecordFailed,
	ReplayRefused,
	RoleUnread,
	StackTooShallow,
	StatementFailed,
	type StatementFailure,
	LedgerUnread,
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

import { ownSettingsQuery, textArray } from "#adapter/admission/roles.ts"
import { toResult } from "#adapter/engine.ts"
import { AdviceUnloaded } from "#adapter/errors/execution.ts"
import {
	fileParams,
	folderParams,
	headParams,
	installedLedger,
	type LedgerRead,
	ledgerExistsRead,
	ledgerPresence,
	ledgerRowsRead,
	ledgerStateOf,
	redraftParams,
	statementsFor
} from "#adapter/migrate/ledger.ts"
import {
	attributeGrantColumn,
	decoderRole,
	grantReplicationRight,
	liveSourceRefusal,
	membershipGrantColumn,
	type ReplicationGrants,
	replicationHeldQuery,
	type SurveyedDecoder,
	type WalLevel,
	walLevelColumn,
	walLevelOf
} from "#adapter/migrate/live.ts"
import {
	lockTableCapacity,
	lockTableColumns,
	lockTableOf,
	type LockTableSettings
} from "#adapter/migrate/locks.ts"
import { type ApplyPlan, planApply, runFiles } from "#adapter/migrate/plan.ts"
import {
	apartRow,
	apartRows,
	decidingFailure,
	connectionInstallation,
	type MigrationConnection,
	type MigrationSession,
	openMigrationSession
} from "#adapter/migrate/session.ts"
import {
	type ApartAnswer,
	type BatchStatement,
	oneShotStatement,
	sentAnswer
} from "#adapter/wire/batch.ts"
import type { CatalogQuery } from "#adapter/wire/statement.ts"
import { reportedOwner } from "#adapter/witness/keylaw.ts"
import { C } from "#compiler/plan/catalog.ts"
import {
	lawsOfConstraint,
	emitCatalog,
	type EmittedText,
	type LawId,
	type ObjectName,
	type SchemaFingerprint,
	sqlstateClass,
	sqlstates
} from "#compiler/plan/common.ts"
import {
	dataStepBracket,
	dataStepRecheckName,
	type FolderLaws,
	folderOrdinal,
	immutableTriggerName,
	immutableTruncateTriggerName,
	type InstallationNames,
	loadedModuleColumns,
	planAdviceModule,
	type ProofStatements,
	proofStatements,
	proofsIdent,
	replayLocks,
	standUpCalls,
	standUpDisplayLead,
	statedLocks
} from "#compiler/plan/migration.ts"
import { textParam } from "#compiler/plan/read.ts"
import type { DeploySnapshot, LedgerState, LedgerStatements } from "#compiler/plan/serve.ts"

/**
 * `grizzle migrate`: the apply runner.
 *
 * The command line reads each declared schema's snapshot.json and migration folders and calls applyMigrations with
 * the migration identity's connection: the CLI does the filesystem work, then calls adapter/migrate. Every step sends
 * its statements together, in one flight (session.ts). Before any statement of any folder runs:
 *
 * 1. Input (input.ts), for every schema, before anything is read: each folder's name, meta.json and files read as
 *    drafted; no file controls the transaction itself.
 * 2. The survey step, one flight for every schema: the session's role, the server's settings and whether its backend
 *    loaded pg_plan_advice, its role's own stored settings, then for each schema its owner, its apply lock and its
 *    ledger, each statement apart. The session must have loaded the library, by the modules its backend loaded, and its
 *    role must store no session_preload_libraries of its own, so that every login's session, which takes the
 *    database's and the server's, loads it too (AdviceUnloaded, MigratorPreloads): a statement the server plans without
 *    it ignores the advice grizzle carries, and a function's advice is parsed as its CREATE FUNCTION runs only where the
 *    library is loaded. Its answers are judged for each schema in the order given:
 *    - Identity. Migrations run as the migration identity, which owns the schema: the role that connects, whatever its
 *      name, for neither the snapshot nor the drafted SQL names it. A schema that exists must be the session role's;
 *      one that does not yet is created by the first migration, and so the role's. Anything else is refused.
 *    - The apply lock. A session-level advisory lock keyed by the schema, its key derived on the host from the
 *      schema's name (sql/catalog.ts AdvisoryLock), taken with pg_try_advisory_lock, so two applies of one schema
 *      never interleave their files; a second apply is refused rather than waiting, because a waiting statement's
 *      snapshot would hold up the first one's CREATE INDEX CONCURRENTLY (its wait for older snapshots) while the first
 *      holds the lock the second waits on. The ledger is read after the lock in the same flight, so under it when it
 *      is taken; a refused apply's read is discarded. Every lock taken is released when the apply ends, in one step,
 *      and with the session in any case.
 *    - The ledger (ledger.ts), its absence read as the schema's empty snapshot, and the plan (plan.ts): which folders
 *      are applied, which resumes, which run; an out-of-order folder, a source that is not the latest target, a chain
 *      that does not end at the known snapshot, or an unresolved marker refuses the apply.
 *
 * Then every planned file runs, folder by folder:
 *
 * - a transactional file: one flight, BEGIN ISOLATION LEVEL SERIALIZABLE, the ledger's ACCESS EXCLUSIVE lock, each
 *   statement in order, then the folder's row if absent and the file's row, then COMMIT; any failure rolls the whole
 *   file back, its row with it. The first file a resume under a redraft runs re-records its folder first among its
 *   rows (ledger/ledger.ts redraftFolder), so the ledger takes the redraft exactly when that file commits;
 * - a no-transaction file (`-- grizzle: no-transaction` first): its folder's row if absent, under the ledger's lock, in
 *   a transaction of its own; then each statement alone, in autocommit, in a step of its own; then the rows, a
 *   redraft's re-record among them, under the lock, in a transaction of their own. Each statement is a step because
 *   whether it runs depends on the answer of the one before it: a failure stops at the failing statement, so a failed
 *   CREATE INDEX CONCURRENTLY never lets a later statement run, and a rerun runs the file again from its first
 *   statement, which its drafted statements make safe;
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

/**
 * The key of `schema`'s apply lock (sql/catalog.ts AdvisoryLock), as every statement that takes or releases it prints
 * it.
 */
export const applyLockKey = (schema: string): C.CatalogExpr =>
	C.literal(C.advisoryKey({ kind: "apply", schema }), "bigint")

/**
 * A schema's apply lock: the statement that tries to take it, answering whether it did, and the statement that releases
 * it, each with the lock's key as a literal (applyLockKey), so neither takes a parameter.
 */
interface ApplyLock {
	readonly take: CatalogQuery<boolean>
	readonly release: EmittedText
}

/** The apply lock of `schema`. */
const applyLock = (schema: string): ApplyLock => {
	const key = applyLockKey(schema)
	return {
		take: {
			sql: emitCatalog(
				C.query([C.asText(C.catalogCall("pg_try_advisory_lock", [key]))], [], undefined)
			),
			what: "a Boolean",
			row: ([taken]) => (taken === "true" ? true : taken === "false" ? false : undefined)
		},
		release: emitCatalog(
			C.query([C.asText(C.catalogCall("pg_advisory_unlock", [key]))], [], undefined)
		)
	}
}
const roleName = ([name]: ReadonlyArray<string>): string | undefined => name

/**
 * The session's role, the server's max_stack_depth in kilobytes (admission/expectation.ts stackDepthColumn) and its
 * wal_level (live.ts walLevelOf), whether its backend loaded pg_plan_advice (adviceLoadedColumn), and what the session's
 * role may give a decoder login (live.ts ReplicationGrants).
 */
interface SessionRow {
	readonly user: string
	readonly stackDepth: string
	readonly adviceLoaded: boolean
	readonly walLevel: WalLevel
	readonly grants: ReplicationGrants
	/** The six settings that size the server's lock table (locks.ts), which the apply's largest transaction must fit. */
	readonly lockTable: LockTableSettings
}

const loadedModules = C.fromFunction(
	C.catalogCall("pg_get_loaded_modules", []),
	"m",
	loadedModuleColumns,
	false
)

/**
 * Whether the session's backend loaded pg_plan_advice, by the modules it loaded, as the snapshot guard's first refusal
 * reads them (engine physical/ddl/ledger.ts adviceLoaded), never by a setting, which a placeholder answers whatever the
 * session loaded.
 */
const adviceLoadedColumn: C.CatalogExpr = C.asText(
	C.exists(
		C.query(
			[C.bool(true)],
			[loadedModules.item],
			C.eq(loadedModules.col(loadedModuleColumns[0]), C.text(planAdviceModule))
		)
	)
)

const sessionRead: CatalogQuery<SessionRow> = {
	sql: emitCatalog(
		C.query(
			[
				C.asText(C.currentUser),
				stackDepthColumn,
				adviceLoadedColumn,
				walLevelColumn,
				attributeGrantColumn,
				membershipGrantColumn,
				...lockTableColumns
			],
			[],
			undefined
		)
	),
	what: "a role name, eight settings, a loaded library and two privileges",
	row: ([user, stackDepth, loaded, walLevelText, attribute, membership, ...table]) => {
		const walLevel = Option.getOrUndefined(
			Option.flatMap(Option.fromNullishOr(walLevelText), walLevelOf)
		)
		const lockTable = Option.getOrUndefined(lockTableOf(table))
		return user === undefined ||
			stackDepth === undefined ||
			walLevel === undefined ||
			lockTable === undefined ||
			(loaded !== "true" && loaded !== "false") ||
			(attribute !== "true" && attribute !== "false") ||
			(membership !== "true" && membership !== "false")
			? undefined
			: {
					user,
					stackDepth,
					adviceLoaded: loaded === "true",
					walLevel,
					grants: { attribute: attribute === "true", membership: membership === "true" },
					lockTable
				}
	}
}

/** The settings that size the server's lock table (locks.ts), read after a refusal. */
const lockTableRead: CatalogQuery<LockTableSettings> = {
	sql: emitCatalog(C.query(lockTableColumns, [], undefined)),
	what: "six settings",
	row: (cells) => Option.getOrUndefined(lockTableOf(cells))
}

/**
 * A server's refusal of a statement of a migration's transaction, a file's or the drift check's replay, as the migration
 * states it: a 53200, which a transaction that creates more objects than the server's lock table holds meets, is the
 * table exhausted (LockTableExhausted), its settings read in the same session once the transaction rolled back, one
 * statement apart on the failure path alone; any other refusal is itself.
 */
const refusalOf = (
	session: MigrationSession,
	error: ServerError
): Effect.Effect<ServerError | LockTableExhausted> =>
	error.sqlstate !== sqlstates.outOfMemory
		? Effect.succeed(error)
		: Effect.map(
				Effect.result(
					Effect.flatMap(session.apart([oneShotStatement(lockTableRead.sql, [])]), (answers) =>
						Effect.fromResult(apartRow(lockTableRead, sentAnswer(answers, 0)))
					)
				),
				(read) =>
					new LockTableExhausted({
						error,
						table: Result.isSuccess(read)
							? { kind: "read", settings: read.success }
							: { kind: "unread", failure: read.failure }
					})
			)

const namespace = C.from("pg_namespace", "n")

/** The owner of the schema $1: one row, or none before its first migration. */
const schemaOwner: CatalogQuery<string> = {
	sql: emitCatalog(
		C.query(
			[C.asText(C.catalogCall("pg_get_userbyid", [namespace.col("nspowner")]))],
			[namespace.item],
			C.eq(namespace.col("nspname"), C.param(1, "text"))
		)
	),
	what: "a role name",
	row: roleName
}

/**
 * The tables of the schemas $2 that carry an immutability guard of $1 (physical/ddl/immutable.ts
 * immutableTriggerName, immutableTruncateTriggerName), each as `<schema>.<table>`: the tables a no-transaction custom
 * file's statement may not write, read where the file runs, under the apply lock, so a folder applied before it in the
 * same apply, which adds or drops a guard, is read as it left them.
 */
const guardedTables: CatalogQuery<string> = (() => {
	const g = C.from("pg_trigger", "g")
	const c = C.from("pg_class", "c")
	const n = C.from("pg_namespace", "n")
	return {
		sql: emitCatalog(
			C.query(
				[C.asText(n.col("nspname")), C.asText(c.col("relname"))],
				[g.item, c.item, n.item],
				C.and([
					C.eq(g.col("tgrelid"), c.col("oid")),
					C.eq(c.col("relnamespace"), n.col("oid")),
					C.any(g.col("tgname"), C.arrayParam(1, "text")),
					C.any(n.col("nspname"), C.arrayParam(2, "text"))
				])
			)
		),
		what: "a guarded table",
		row: ([schema, name]) =>
			schema === undefined || name === undefined ? undefined : `${schema}.${name}`
	}
})()

/**
 * The stand-ups of the schemas $1, by schema and name: each function whose COMMENT, its identity spelled out, is a
 * judged table's stand-up's ($2, core/identity.ts standUpDisplayLead; physical/ddl/rules.ts addStandUps). What a custom
 * migration's data step calls before its statements, read where the step runs, under the apply lock, as its guards
 * are, so a folder applied before it in the same apply, which adds or drops a rule, is read as it left them.
 */
const installedStandUps: CatalogQuery<ObjectName> = (() => {
	const f = C.from("pg_proc", "f")
	const n = C.from("pg_namespace", "n")
	const d = C.from("pg_description", "d")
	return {
		sql: emitCatalog(
			C.query(
				[C.asText(n.col("nspname")), C.asText(f.col("proname"))],
				[f.item, n.item, d.item],
				C.and([
					C.eq(f.col("pronamespace"), n.col("oid")),
					C.eq(d.col("objoid"), f.col("oid")),
					C.eq(d.col("classoid"), C.catalogRegclass("pg_proc")),
					C.eq(
						C.catalogCall("left", [
							d.col("description"),
							C.catalogCall("length", [C.param(2, "text")])
						]),
						C.param(2, "text")
					),
					C.any(n.col("nspname"), C.arrayParam(1, "text"))
				])
			)
		),
		what: "a stand-up",
		row: ([schema, name]) =>
			schema === undefined || name === undefined ? undefined : { schema, name }
	}
})()

/**
 * The re-checks of a data step in the schemas $1, by schema and name: each function named $2 (core/identity.ts
 * dataStepRecheckName; physical/ddl/recheck.ts), one a level at most. What a custom migration's data step calls after
 * its statements, read where the step runs, under the apply lock, as its stand-ups are.
 */
const installedRechecks: CatalogQuery<ObjectName> = (() => {
	const f = C.from("pg_proc", "f")
	const n = C.from("pg_namespace", "n")
	return {
		sql: emitCatalog(
			C.query(
				[C.asText(n.col("nspname")), C.asText(f.col("proname"))],
				[f.item, n.item],
				C.and([
					C.eq(f.col("pronamespace"), n.col("oid")),
					C.eq(C.asText(f.col("proname")), C.param(2, "text")),
					C.any(n.col("nspname"), C.arrayParam(1, "text"))
				])
			)
		),
		what: "a data step's re-check",
		row: ([schema, name]) =>
			schema === undefined || name === undefined ? undefined : { schema, name }
	}
})()

interface Planned {
	readonly snapshot: DeploySnapshot
	/** The schema's committed folders as parsed, which the drift check names a function's defining statement from. */
	readonly folders: ReadonlyArray<ParsedFolder>
	readonly statements: LedgerStatements
	readonly proofs: ProofStatements
	readonly plan: ApplyPlan
	/** Whether the ledger existed when the apply read it, under its apply lock. */
	readonly ledger: LedgerTable
	/** The decoder login of the schema's live source, as the survey read it. */
	readonly decoder: SurveyedDecoder
}

/**
 * A schema's input, checked before anything is read: its parsed target, its ledger's and its proofs' statements, its
 * apply lock, and its live source's decoder login under the installation's role space, by the name its snapshot gives
 * it (live.ts decoderRole), none where it installs none.
 */
interface Checked {
	readonly parsed: ParsedTarget
	readonly statements: LedgerStatements
	readonly proofs: ProofStatements
	readonly lock: ApplyLock
	readonly decoder: string | undefined
}

const checkTarget = (
	target: MigrationTarget,
	installation: InstallationNames
): Result.Result<Checked, MigrateError> =>
	Result.flatMap(parseTarget(target, installation), (parsed) =>
		Result.flatMap(statementsFor(parsed.schema), (statements) =>
			Result.map(
				Result.mapError(toResult(proofStatements(parsed.schema)), (error) =>
					stopped(new LedgerUncompiled({ schema: parsed.schema, error }))
				),
				(proofs) => ({
					parsed,
					statements,
					proofs,
					lock: applyLock(parsed.schema),
					decoder: decoderRole(parsed.snapshot, installation.roles)
				})
			)
		)
	)

/**
 * Every target's input checked (checkTarget), in order, each parsed once: what migrate checks before it connects and
 * applies, and drift checks and judges by. A schema named twice is refused.
 */
const checkTargets = (
	targets: ReadonlyArray<MigrationTarget>,
	installation: InstallationNames
): Result.Result<ReadonlyArray<Checked>, MigrateError> =>
	Result.gen(function* () {
		const schemas = Arr.map(targets, (t) => t.snapshot.schema)
		const repeated = Arr.findFirst(schemas, (s, i) => schemas.indexOf(s) !== i)
		if (Option.isSome(repeated)) {
			return yield* Result.fail(
				stopped(new InputRefused({ schema: repeated.value, fault: { kind: "repeatedSchema" } }))
			)
		}
		const checked: Array<Checked> = []
		for (const t of targets) {
			checked.push(yield* checkTarget(t, installation))
		}
		return checked
	})

/**
 * The survey step's reads of one schema, apart and in the order it sends them (see the header): its owner, its apply
 * lock, whether its ledger exists (ledger.ts ledgerExistsRead), and, last and only where its snapshot installs a live
 * source, whether its decoder login holds the replication right. Each read's answer is at its position in this list,
 * counted from the schema's first answer. A ledger's rows are read in the step after, where it exists (surveyAll).
 */
const schemaReadOrder = ["owner", "lock", "ledger", "decoder"] as const
type SchemaRead = (typeof schemaReadOrder)[number]

/** The statements of a schema's survey reads, in schemaReadOrder, its decoder login's where it has one. */
const schemaReads = (checked: Checked): ReadonlyArray<BatchStatement> => {
	const schema = checked.parsed.schema
	const decoder = checked.decoder
	return [
		oneShotStatement(schemaOwner.sql, [textParam(schema)]),
		oneShotStatement(checked.lock.take.sql, []),
		ledgerExistsRead(schema),
		...(decoder === undefined
			? []
			: [oneShotStatement(replicationHeldQuery.sql, [textParam(decoder)])])
	]
}

/**
 * The survey step's reads of the session, apart, before every schema's: its role, the server's settings and its loaded
 * libraries (sessionRead), then its role's own stored settings (admission/roles.ts ownSettingsQuery).
 */
const sessionReads: Arr.NonEmptyReadonlyArray<BatchStatement> = [
	oneShotStatement(sessionRead.sql, []),
	oneShotStatement(ownSettingsQuery.sql, [])
]

/**
 * The parameter whose stored setting on the migration role decides which libraries its session loads apart from every
 * login's (MigratorPreloads).
 *
 * @formatConstant PostgreSQL's setting of the libraries a backend loads as it starts
 *   (https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2704)
 */
const sessionPreloads = "session_preload_libraries"

/**
 * Each schema with where its answers start in the survey step: behind the session's reads, then the reads of the
 * schemas before it.
 */
const placed = (checked: ReadonlyArray<Checked>): ReadonlyArray<readonly [Checked, number]> =>
	Arr.zip(
		checked,
		Arr.scan(checked, sessionReads.length, (at, c) => at + schemaReads(c).length)
	)

/** The answer of a schema's read `read`, its answers starting at `at`. */
const readAnswer = (
	answers: ReadonlyArray<ApartAnswer>,
	at: number,
	read: SchemaRead
): ApartAnswer => sentAnswer(answers, at + schemaReadOrder.indexOf(read))

/** Whether the survey step took a schema's apply lock `lock`: exactly when its statement answered true. */
const lockTaken = (lock: ApplyLock, answer: ApartAnswer): boolean => {
	const taken = apartRow(lock.take, answer)
	return Result.isSuccess(taken) && taken.success
}

/**
 * The step that releases the apply locks the survey step took, `answers`, of the schemas `schemas`, each placed where
 * its answers start (placed); none when it took none.
 */
const releaseOf = (
	schemas: ReadonlyArray<readonly [Checked, number]>,
	answers: ReadonlyArray<ApartAnswer>
) =>
	Arr.flatMap(schemas, ([c, at]) =>
		lockTaken(c.lock, readAnswer(answers, at, "lock")) ? [oneShotStatement(c.lock.release, [])] : []
	)

/**
 * One schema's checks from its answers in the survey step, from `at` on: its owner, its apply lock, and whether its
 * ledger exists.
 */
const surveySchema = (
	checked: Checked,
	answers: ReadonlyArray<ApartAnswer>,
	at: number,
	user: string
): Result.Result<LedgerRead["kind"], MigrateError> =>
	Result.gen(function* () {
		const { parsed, lock } = checked
		const schema = parsed.schema
		const [owner] = yield* Result.mapError(
			apartRows(schemaOwner, readAnswer(answers, at, "owner")),
			(failure) => stopped(new OwnerUnread({ schema, failure }))
		)
		if (owner !== undefined && owner !== user) {
			return yield* Result.fail(stopped(new OwnedByAnother({ schema, owner, user })))
		}
		const taken = yield* Result.mapError(
			apartRow(lock.take, readAnswer(answers, at, "lock")),
			(failure) => stopped(new LockUnread({ schema, failure }))
		)
		if (!taken) {
			return yield* Result.fail(stopped(new ApplyBusy({ schema })))
		}
		return yield* Result.mapError(
			ledgerPresence(schema, readAnswer(answers, at, "ledger")),
			stopped
		)
	})

/** One schema's plan from its ledger as the survey read it, and its decoder login from its answers, from `at` on. */
const planSchema = (
	checked: Checked,
	answers: ReadonlyArray<ApartAnswer>,
	at: number,
	read: LedgerRead
): Result.Result<Planned, MigrateError> =>
	Result.gen(function* () {
		const { parsed, statements, proofs } = checked
		const plan = yield* planApply(parsed, ledgerStateOf(parsed.schema, read))
		const role = checked.decoder
		const decoder: SurveyedDecoder =
			role === undefined
				? { kind: "none" }
				: {
						kind: "login",
						role,
						held: yield* Result.mapError(
							apartRow(replicationHeldQuery, readAnswer(answers, at, "decoder")),
							(failure) => stopped(new RoleUnread({ failure }))
						)
					}
		return {
			snapshot: parsed.snapshot,
			folders: parsed.folders,
			statements,
			proofs,
			plan,
			ledger: read.kind,
			decoder
		}
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
): Effect.fn.Return<
	{
		readonly planned: ReadonlyArray<Planned>
		readonly grants: ReplicationGrants
		readonly lockTable: LockTableSettings
	},
	MigrateError,
	Scope.Scope
> {
	const schemas = placed(checked)
	const answers = yield* Effect.mapError(
		Effect.uninterruptibleMask((restore) =>
			Effect.tap(
				restore(session.apart([...sessionReads, ...Arr.flatMap(checked, schemaReads)])),
				(read) => {
					const release = releaseOf(schemas, read)
					return Arr.isReadonlyArrayNonEmpty(release)
						? Effect.addFinalizer(() => Effect.ignore(session.apart(release)))
						: Effect.void
				}
			)
		),
		(failure) => stopped(new SurveyFailed({ failure }))
	)
	/** The session's role and the server's setting concern no schema. */
	const { user, stackDepth, adviceLoaded, walLevel, grants, lockTable } = yield* Effect.fromResult(
		Result.mapError(apartRow(sessionRead, sentAnswer(answers, 0)), (failure) =>
			stopped(new RoleUnread({ failure }))
		)
	)
	const own = yield* Effect.fromResult(
		Result.mapError(apartRows(ownSettingsQuery, sentAnswer(answers, 1)), (failure) =>
			stopped(new RoleUnread({ failure }))
		)
	)
	if (stackTooShallow(stackDepth)) {
		return yield* stopped(
			new StackTooShallow({ observed: stackDepth, required: stackDepthRequired })
		)
	}
	if (!adviceLoaded) {
		return yield* stopped(new AdviceUnloaded())
	}
	/**
	 * The migration role's own session_preload_libraries, none where the session speaks for every login's: a login's
	 * own settings are the snapshot's (admission/roles.ts), none of them this, so its sessions load what the database's
	 * setting and the server's load, as this one does where its role stores none.
	 */
	const preloads = Arr.filter(own, (setting) => setting.parameter === sessionPreloads)
	if (Arr.isReadonlyArrayNonEmpty(preloads)) {
		return yield* stopped(new MigratorPreloads({ settings: preloads }))
	}
	const [sourced] = Arr.filter(checked, (c) => c.decoder !== undefined)
	const refused =
		sourced === undefined ? Option.none() : liveSourceRefusal(walLevel, sourced.parsed.schema)
	if (Option.isSome(refused)) {
		return yield* stopped(refused.value)
	}
	const surveyed: Array<readonly [Checked, number, LedgerRead["kind"]]> = []
	for (const [c, at] of schemas) {
		const ledger = yield* Effect.fromResult(surveySchema(c, answers, at, user))
		surveyed.push([c, at, ledger])
	}
	/** The rows of every ledger the catalog holds, in survey order, read in a step of their own under the apply locks. */
	const installed = Arr.filter(surveyed, ([, , ledger]) => ledger === "installed")
	const rows = Arr.isReadonlyArrayNonEmpty(installed)
		? yield* Effect.mapError(
				session.apart(Arr.map(installed, ([c]) => ledgerRowsRead(c.statements))),
				(failure) => stopped(new SurveyFailed({ failure }))
			)
		: []
	const planned: Array<Planned> = []
	/** The position of the next installed ledger's rows among the rows step's answers. */
	let next = 0
	for (const [c, at, ledger] of surveyed) {
		const read: LedgerRead =
			ledger === "absent"
				? { kind: "absent" }
				: yield* Effect.fromResult(
						Result.mapError(installedLedger(c.parsed.schema, sentAnswer(rows, next++)), stopped)
					)
		const schemaPlan = yield* Effect.fromResult(planSchema(c, answers, at, read))
		planned.push(schemaPlan)
	}
	return { planned, grants, lockTable }
})

/** An apply's transaction by the locks it holds, as its folders state them (LockedTransaction). */
interface Locked {
	readonly schema: string
	readonly at: LockedTransaction
	readonly locks: number
}

/**
 * Each transaction of a schema's plan whose locks its folders state, as deploy/locks/demand.ts counts them: each
 * planned file's, where its folder's meta.json records the file as written (statedLocks), and the drift check's replay
 * of a schema's first migration, which replays every object of its snapshot with no proof to spare one.
 */
const lockedTransactions = (p: Planned): ReadonlyArray<Locked> => [
	...Arr.flatMap(p.plan.runs, (r) =>
		Arr.flatMap(runFiles(r), (f): ReadonlyArray<Locked> => {
			const locks = statedLocks(r.folder.meta, f)
			return locks === undefined
				? []
				: [
						{
							schema: p.plan.schema,
							at: { kind: "file", folder: r.folder.name, file: f.name },
							locks
						}
					]
		})
	),
	...(p.ledger === "absent"
		? [{ schema: p.plan.schema, at: { kind: "replay" } as const, locks: replayLocks(p.snapshot) }]
		: [])
]

/**
 * The apply's largest transaction refused where the server's lock table cannot hold it with the session's apply locks,
 * one per schema, which it holds through every transaction (LockTableShort): before any statement of any folder runs.
 */
const lockTableHolds = (
	planned: ReadonlyArray<Planned>,
	lockTable: LockTableSettings
): Effect.Effect<void, MigrateError> => {
	const largest = Arr.reduce(
		Arr.flatMap(planned, lockedTransactions),
		undefined,
		(most: Locked | undefined, t: Locked) => (most === undefined || t.locks > most.locks ? t : most)
	)
	const held = planned.length
	return largest === undefined || largest.locks + held <= lockTableCapacity(lockTable)
		? Effect.void
		: stopped(new LockTableShort({ ...largest, held, table: lockTable }))
}

/**
 * The laws a refusal of a file of a folder can break, every law the refused constraint serves, by that folder's own laws (`laws`, its meta.json's FolderLaws), which
 * generate recorded from the snapshot the folder installs, as a refused write's law is read from the installation's
 * map (witness/keylaw.ts): an integrity violation PostgreSQL reports on a constraint of a table or domain of one of the
 * levels the folder installs (reportedOwner), such as a VALIDATE CONSTRAINT of a foreign key over stored rows, or a
 * deferred one at COMMIT; none for any other failure, and none for a violation check, which raises under the law's
 * identity itself.
 */
const brokenLaws = (laws: FolderLaws): ((failure: StatementFailure) => ReadonlyArray<LawId>) => {
	const schemas = new Set(laws.schemas)
	return (failure) => {
		if (
			failure._tag !== "ServerError" ||
			failure.constraint === undefined ||
			sqlstateClass(failure.sqlstate) !== sqlstateClass(sqlstates.integrityConstraintViolation)
		) {
			return []
		}
		const owner = reportedOwner(failure, schemas)
		return owner === undefined
			? []
			: (lawsOfConstraint(laws.constraintToLaw, owner, failure.constraint) ?? [])
	}
}

/**
 * Where a statement of a file's transaction stands (apply.ts runFile), which says what its refusal is: `lock`, the
 * ledger's lock and a guard's dropping before the file's statements, a refusal the ledger left unlocked; `statement`,
 * the file's statement at `index`, which its laws can break; `laws`, the bracket's statements after them, the deferred
 * laws made immediate and the re-checks (physical/ddl/immutable.ts dataStepBracket), a refusal the file's laws' as its
 * COMMIT's is; `record`, the ledger's rows.
 */
type FileStage =
	| { readonly kind: "lock" | "laws" | "record" }
	| { readonly kind: "statement"; readonly index: number }

const lockStage: FileStage = { kind: "lock" }

/** The stage of the bracket's statements after the file's (FileStage `laws`). */
const lawsChecked: FileStage = { kind: "laws" }

const recordStage: FileStage = { kind: "record" }

/** A statement of a file's transaction at its stage (FileStage). */
interface StagedStatement {
	readonly stage: FileStage
	readonly statement: BatchStatement
}

/**
 * Runs one file and records it, a refusal naming the laws it can break (`broken`, brokenLaws), its rows after the ledger
 * statements `redraft` its transaction runs first among them: a redraft's re-record of its folder, or none.
 *
 * Each statement alone, in a step of its own: whether it runs depends on the one before it (see the header).
 */
const runFile = (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements,
	folder: ParsedFolder,
	file: ParsedFile,
	ledger: LedgerTable,
	broken: (failure: StatementFailure) => ReadonlyArray<LawId>,
	redraft: ReadonlyArray<BatchStatement>,
	levels: ReadonlyArray<string>
): Effect.Effect<void, MigrateError> => {
	const at: RecordPlace = { kind: "file", folder: folder.name, file: file.name }
	const fence = fenceOf(statements, ledger)
	const statementFailed = (index: number) => (failure: StatementFailure) =>
		stopped(
			new StatementFailed({
				schema,
				folder: folder.name,
				file: file.name,
				statement: index + 1,
				failure,
				laws: broken(failure)
			})
		)
	const recordFailed = (failure: StatementFailure) =>
		stopped(new RecordFailed({ schema, at, failure }))
	/** The file's deferred laws' refusal of it, at its COMMIT or made immediate in its bracket (`lawsChecked`). */
	const lawsFailed = (failure: StatementFailure) =>
		stopped(
			new FileCommitRefused({
				schema,
				folder: folder.name,
				file: file.name,
				failure,
				laws: broken(failure)
			})
		)
	/** A COMMIT the server refused, or one the connection was lost during, which may have committed. */
	const commitFailed = (
		failure: Extract<BatchFailure, { readonly _tag: "CommitRefused" | "CommitLost" }>
	) =>
		failure._tag === "CommitRefused"
			? lawsFailed(failure.failure)
			: stopped(new FileCommitLost({ schema, at }))
	const record = [
		...redraft,
		oneShotStatement(statements.recordFolder.text, folderParams(folder)),
		oneShotStatement(statements.recordFile.text, fileParams(folder, file)),
		oneShotStatement(statements.recordHead.text, headParams(folder, file.ordinal))
	]
	/** What a refusal of a statement of the file's transaction at `stage` is (FileStage). */
	const refusedAt = (stage: FileStage, refusal: StatementFailure): MigrateError => {
		switch (stage.kind) {
			case "lock":
				return lockFailed(schema, at, refusal)
			case "statement":
				return statementFailed(stage.index)(refusal)
			case "laws":
				return lawsFailed(refusal)
			case "record":
				return recordFailed(refusal)
		}
	}
	/**
	 * The file's transaction, each statement at its stage (FileStage): the ledger's lock, then, bracketing its statements
	 * if it runs them inside it, each guard `bracket` drops (a custom migration's data step's, guardBracket), the
	 * statements, its deferred laws made immediate and its re-checks with each guard created again (`lawsChecked`), then
	 * its rows. A refusal is read off the stage of the statement that refused it (`refusedAt`), as the migration states
	 * the server's refusal (refusalOf).
	 */
	const transaction = (count: number, bracket: ReturnType<typeof dataStepBracket>) => {
		const staged: ReadonlyArray<StagedStatement> = [
			...Arr.map(fence, (statement) => ({ stage: lockStage, statement })),
			...Arr.map(bracket.before, (sql) => ({
				stage: lockStage,
				statement: oneShotStatement(sql, [])
			})),
			...Arr.map(file.statements.slice(0, count), (sql, index) => ({
				stage: { kind: "statement" as const, index },
				statement: oneShotStatement(sql, [])
			})),
			...Arr.map(bracket.after, (sql) => ({
				stage: lawsChecked,
				statement: oneShotStatement(sql, [])
			})),
			...Arr.map(record, (statement) => ({ stage: recordStage, statement }))
		]
		return Effect.catch(
			session.transaction(Arr.map(staged, (s) => s.statement)),
			(failure: BatchFailure | InputTooLarge) => {
				switch (failure._tag) {
					case "BatchRefused": {
						const { stage } = defined(staged[failure.index], "the statement the server refused")
						return Effect.flatMap(refusalOf(session, failure.failure), (refusal) =>
							Effect.fail(refusedAt(stage, refusal))
						)
					}
					case "CommitRefused":
					case "CommitLost":
						return Effect.fail(commitFailed(failure))
					case "ConnectionLost":
					case "DriverFailure":
					case "UnreadableAnswer":
					case "InputTooLarge":
						return Effect.fail(
							stopped(
								new TransactionFailed({ schema, folder: folder.name, file: file.name, failure })
							)
						)
				}
			}
		)
	}
	if (!file.noTransaction) {
		return Effect.flatMap(
			folder.meta.kind === "custom"
				? guardBracket(session, levels, at, schema)
				: Effect.succeed(unbracketed),
			(bracket) => transaction(file.statements.length, bracket)
		)
	}
	return Effect.flatMap(
		folder.meta.kind === "custom"
			? Effect.all([
					guardedOf(session, levels, at, schema),
					standUpsRead(session, levels, at, schema)
				])
			: Effect.succeed([noGuards, noStandUps] as const),
		([guarded, standUps]) => {
			/** A statement's failure, or, where the guard of a table `guarded` holds refused it, why it may not run alone. */
			const aloneFailed = (index: number) => (failure: StatementFailure) => {
				const table =
					failure._tag === "ServerError" &&
					failure.sqlstate === sqlstates.insufficientPrivilege &&
					failure.schema !== undefined &&
					failure.table !== undefined
						? `${failure.schema}.${failure.table}`
						: undefined
				return table !== undefined && guarded.has(table)
					? stopped(
							new GuardedTableUnbracketed({
								schema,
								folder: folder.name,
								file: file.name,
								statement: index + 1,
								table,
								failure
							})
						)
					: statementFailed(index)(failure)
			}
			/** Each stand-up's call alone, before the file's statements, a failure stopping it as the file's lock would. */
			const stoodUp = Effect.forEach(
				standUpCalls(standUps),
				(sql) =>
					Effect.mapError(
						Effect.flatMap(session.apart([oneShotStatement(sql, [])]), (answers) =>
							Effect.fromResult(sentAnswer(answers, 0))
						),
						(failure) => lockFailed(schema, at, failure)
					),
				{ discard: true }
			)
			return Effect.andThen(
				recordFolderRow(session, schema, statements, folder, ledger),
				Effect.andThen(
					stoodUp,
					Effect.andThen(
						Effect.forEach(
							file.statements,
							(sql, index) =>
								Effect.flatMap(
									Effect.mapError(
										session.apart([oneShotStatement(sql, [])]),
										statementFailed(index)
									),
									(answers) =>
										Effect.mapError(Effect.fromResult(sentAnswer(answers, 0)), aloneFailed(index))
								),
							{ discard: true }
						),
						transaction(0, unbracketed)
					)
				)
			)
		}
	)
}

/** A transaction no guard brackets: a drafted folder's, whose data steps the draft brackets itself (deploy/diff/diff.ts
 * unguard), and a no-transaction file's rows. */
const unbracketed: ReturnType<typeof dataStepBracket> = dataStepBracket([], [], [])

/** No guard: a drafted folder's no-transaction file, whose statements the draft wrote. */
const noGuards: ReadonlySet<string> = new Set()

/** No stand-up: a drafted folder's no-transaction file, whose statements the draft wrote and write no table the rule judge holds. */
const noStandUps: ReadonlyArray<ObjectName> = []

/**
 * The tables of the installation's levels `levels` the catalog holds a guard on where a no-transaction custom file
 * runs (guardedTables), each as `<schema>.<table>`. A failed read stops the migration as the file's lock would.
 */
const guardedOf = (
	session: MigrationSession,
	levels: ReadonlyArray<string>,
	at: RecordPlace,
	schema: string
): Effect.Effect<ReadonlySet<string>, MigrateError> =>
	Effect.mapError(
		Effect.flatMap(
			session.apart([
				oneShotStatement(guardedTables.sql, [
					textArray([immutableTriggerName, immutableTruncateTriggerName]),
					textArray(levels)
				])
			]),
			(answers) =>
				Effect.map(
					Effect.fromResult(apartRows(guardedTables, sentAnswer(answers, 0))),
					(tables) => new Set(tables)
				)
		),
		(failure) => lockFailed(schema, at, failure)
	)

/**
 * The stand-ups the catalog holds in the installation's levels `levels` where a custom migration's file runs
 * (installedStandUps). A failed read stops the migration as the file's lock would.
 */
const standUpsRead = (
	session: MigrationSession,
	levels: ReadonlyArray<string>,
	at: RecordPlace,
	schema: string
): Effect.Effect<ReadonlyArray<ObjectName>, MigrateError> =>
	Effect.mapError(
		Effect.flatMap(
			session.apart([
				oneShotStatement(installedStandUps.sql, [textArray(levels), textParam(standUpDisplayLead)])
			]),
			(answers) => Effect.fromResult(apartRows(installedStandUps, sentAnswer(answers, 0)))
		),
		(failure) => lockFailed(schema, at, failure)
	)

/**
 * The re-checks the catalog holds in the installation's levels `levels` where a custom migration's file runs
 * (installedRechecks), in the levels' order, so a level's stored tables are made again before a level above reads them.
 * A failed read stops the migration as the file's lock would.
 */
const rechecksRead = (
	session: MigrationSession,
	levels: ReadonlyArray<string>,
	at: RecordPlace,
	schema: string
): Effect.Effect<ReadonlyArray<ObjectName>, MigrateError> =>
	Effect.mapError(
		Effect.flatMap(
			session.apart([
				oneShotStatement(installedRechecks.sql, [textArray(levels), textParam(dataStepRecheckName)])
			]),
			(answers) =>
				Effect.map(
					Effect.fromResult(apartRows(installedRechecks, sentAnswer(answers, 0))),
					(rechecks) =>
						Arr.sort(
							rechecks,
							Order.mapInput(Order.Number, (r: ObjectName) => levels.indexOf(r.schema))
						)
				)
		),
		(failure) => lockFailed(schema, at, failure)
	)

/**
 * The bracket of a custom migration's transactional file, a data step written by hand, in its one transaction
 * (physical/ddl/immutable.ts dataStepBracket): before its statements, the call of every stand-up the catalog holds in
 * the installation's levels (standUpsRead), so a statement that writes a table the rule judge holds is judged at the
 * COMMIT as a served write is, and every guard of a table of the levels lifted; after them, every re-check of a data
 * step the levels hold (rechecksRead), which refuses the step where it breaks a rule over a closed relation the judge
 * reads as no served write does, then each guard created again. Every stand-up, re-check and guard, never those of the
 * tables a file's statements write, which no reading of hand-written SQL decides.
 */
const guardBracket = (
	session: MigrationSession,
	levels: ReadonlyArray<string>,
	at: RecordPlace,
	schema: string
): Effect.Effect<ReturnType<typeof dataStepBracket>, MigrateError> =>
	Effect.map(
		Effect.all([
			standUpsRead(session, levels, at, schema),
			rechecksRead(session, levels, at, schema)
		]),
		([standUps, rechecks]) => dataStepBracket(levels, standUps, rechecks)
	)

/** Whether the schema's ledger exists before a transaction of the apply: absent only before its first file committed. */
type LedgerTable = LedgerRead["kind"]

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
		case "installed":
			return [oneShotStatement(statements.exclusive.text, [])]
	}
}

/** The ledger's lock refused or failed. */
const lockFailed = (schema: string, at: RecordPlace, failure: StatementFailure): MigrateError =>
	stopped(new LedgerUnlocked({ schema, at, failure }))

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
	const failed = (failure: StatementFailure) => stopped(new RecordFailed({ schema, at, failure }))
	return Effect.mapError(
		session.transaction([
			...fence,
			oneShotStatement(statements.recordFolder.text, folderParams(folder)),
			oneShotStatement(statements.recordHead.text, headParams(folder, folderOrdinal))
		]),
		(failure: BatchFailure | InputTooLarge) => {
			switch (failure._tag) {
				case "BatchRefused":
					return failure.index < fence.length
						? lockFailed(schema, at, failure.failure)
						: failed(failure.failure)
				case "CommitRefused":
					return failed(failure.failure)
				case "CommitLost":
					return stopped(new FileCommitLost({ schema, at }))
				case "ConnectionLost":
				case "DriverFailure":
				case "UnreadableAnswer":
				case "InputTooLarge":
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
			ledger = "installed"
		}
		const broken = brokenLaws(r.folder.meta.laws)
		/** A redraft's re-record, which the transaction of the first file it runs carries, and no other. */
		let redraft: ReadonlyArray<BatchStatement> =
			r.kind === "redraft"
				? [oneShotStatement(statements.redraftFolder.text, redraftParams(r.folder, r.record))]
				: []
		for (const f of runFiles(r)) {
			yield* runFile(
				session,
				plan.schema,
				statements,
				r.folder,
				f,
				ledger,
				broken,
				redraft,
				Arr.map(planned.snapshot.levels, (l) => l.schema)
			)
			ledger = "installed"
			redraft = []
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
			resumed: r.kind !== "start"
		}))
	}
})

/**
 * What stopped the drift check's second flight: a refusal of a statement of the replay is the replay's (ReplayRefused,
 * numbered within the replay, with the object it builds), as the migration states the server's refusal (refusalOf), and
 * every other failure is the reads' (decidingFailure).
 */
const driftFailure = (
	session: MigrationSession,
	replay: ReplaySpan,
	failure: BatchFailure
): Effect.Effect<ReplayRefused | StatementFailure> => {
	switch (failure._tag) {
		case "BatchRefused": {
			const at = failure.index - replay.from
			const object = at >= 0 ? replay.objects[at] : undefined
			return object === undefined
				? Effect.succeed(failure.failure)
				: Effect.map(
						refusalOf(session, failure.failure),
						(refusal) =>
							new ReplayRefused({
								statement: at + 1,
								of: replay.objects.length,
								object,
								failure: refusal
							})
					)
		}
		case "CommitRefused":
		case "CommitLost":
		case "ConnectionLost":
		case "DriverFailure":
		case "UnreadableAnswer":
			return Effect.succeed(decidingFailure(failure))
	}
}

/**
 * The drift check of one schema (adapter/admission/drift.ts), one transaction over two flights (see the header): the
 * ledger's and the proofs' two reads each apart in front of it, then the check's reads of the installed catalog; then,
 * made of their answers, the replay of what no proof proves and its scratch descriptions, and the transaction's
 * ROLLBACK. migrate runs it after every apply; `grizzle drift` runs it alone. A folder not yet applied is the ledger's
 * mismatch: the latest complete folder's target is not the snapshot. The migration identity owns the schema and every
 * object in it. Its verdict says what a migrate records of the proofs (recordProofs).
 */
export const checkDrift = Effect.fn("checkDrift")(function* (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	statements: LedgerStatements,
	proofs: ProofStatements,
	folders: ReadonlyArray<DriftFolder>
): Effect.fn.Return<DriftVerdict, MigrateError> {
	const schema = snapshot.schema
	const { verdict, ledger } = yield* readDrift(session, snapshot, statements, proofs, folders)
	/** Each mismatch is a fact of its own, which the report lists one per line. */
	const mismatches = [...ledgerMismatches(snapshot, ledger), ...verdict.mismatches]
	if (Arr.isReadonlyArrayNonEmpty(mismatches)) {
		return yield* stopped(new Drifted({ schema, snapshot: snapshot.fingerprint, mismatches }))
	}
	return verdict
})

/**
 * The drift check of one schema's catalog against `snapshot` as checkDrift runs it, its verdict and the ledger it read
 * beside it, judged by neither: what checkDrift refuses drift by.
 */
const readDrift = Effect.fn("readDrift")(function* (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	statements: LedgerStatements,
	proofs: ProofStatements,
	folders: ReadonlyArray<DriftFolder>
): Effect.fn.Return<
	{ readonly verdict: DriftVerdict; readonly ledger: LedgerState },
	MigrateError
> {
	const schema = snapshot.schema
	const unchecked = uncheckedOf(schema)
	/** Whether the ledger and the proofs exist, so the reads after name only tables the catalog holds. */
	const present = yield* Effect.mapError(
		session.apart([ledgerExistsRead(schema), proofsExistRead(schema)]),
		unchecked
	)
	const ledger = yield* Effect.mapError(
		Effect.fromResult(ledgerPresence(schema, sentAnswer(present, 0))),
		unchecked
	)
	const proven = yield* Effect.mapError(
		Effect.fromResult(proofsPresence(sentAnswer(present, 1))),
		unchecked
	)
	/** The rows of each that exists, apart in front of the check's transaction: the ledger's, then the proofs'. */
	const ledgerRows = ledger === "installed" ? [ledgerRowsRead(statements)] : []
	const proofRows = proven === "present" ? [proofRowsRead(proofs)] : []
	/** The proofs the rows read apart hold; no proofs' table holds no proof: everything is unproven, and the replay whole. */
	const held = (
		answers: ReadonlyArray<ApartAnswer>
	): Result.Result<ReadonlyMap<string, ProofRow>, ServerError | CatalogRowRefused> =>
		proven === "present"
			? heldProofs(proofs, sentAnswer(answers, ledgerRows.length))
			: Result.succeed(new Map())
	const { verdict, alone } = yield* driftAlongside(
		session,
		snapshot,
		folders,
		[...ledgerRows, ...proofRows],
		held
	)
	const read: LedgerRead =
		ledger === "absent"
			? { kind: "absent" }
			: yield* Effect.mapError(
					Effect.fromResult(installedLedger(schema, sentAnswer(alone, 0))),
					unchecked
				)
	return { verdict, ledger: ledgerStateOf(schema, read) }
})

/** A drift check's failure to reach a verdict on `schema`'s catalog. */
const uncheckedOf =
	(schema: string) =>
	(failure: DriftUnchecked["failure"]): MigrateError =>
		stopped(new DriftUnchecked({ schema, failure }))

/**
 * The drift check of `snapshot` as one transaction over two flights (checkDrift's header), the statements `apart` sent
 * apart in front of it, their answers read into the proofs that hold (`held`): its verdict, and the answers apart.
 */
const driftAlongside = Effect.fn("driftAlongside")(function* (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	folders: ReadonlyArray<DriftFolder>,
	apart: ReadonlyArray<BatchStatement>,
	held: (
		answers: ReadonlyArray<ApartAnswer>
	) => Result.Result<ReadonlyMap<string, ProofRow>, ServerError | CatalogRowRefused>
): Effect.fn.Return<
	{ readonly verdict: DriftVerdict; readonly alone: ReadonlyArray<ApartAnswer> },
	MigrateError
> {
	const unchecked = uncheckedOf(snapshot.schema)
	const drift = yield* Effect.mapError(
		Effect.fromResult(driftCheck(snapshot, session.installation, folders)),
		unchecked
	)
	const answered = yield* Effect.mapError(
		session.alongside(
			apart,
			drift.first,
			(alone, first) => Result.flatMap(held(alone), (rows) => drift.after(rows, first)),
			driftTransaction
		),
		unchecked
	)
	const opened = yield* Effect.mapError(Effect.fromResult(answered.framed), (failure) =>
		failure.pipe(decidingFailure, unchecked)
	)
	const made = yield* Effect.mapError(Effect.fromResult(opened.made), unchecked)
	const second = yield* Effect.catch(Effect.fromResult(made.second), (failure) =>
		Effect.flatMap(driftFailure(session, made.value.replay, failure), (refused) =>
			Effect.fail(unchecked(refused))
		)
	)
	const verdict = yield* Effect.mapError(Effect.fromResult(made.value.read(second)), unchecked)
	return { verdict, alone: answered.alone }
})

/**
 * `schema`'s ledger as an apply reads it (ledger.ts ledgerStateOf), in steps of statements apart: whether the ledger
 * exists, then, only where it does, its rows. A step the server does not answer is LedgerUnread.
 */
export const readLedger = Effect.fn("readLedger")(function* (
	session: MigrationSession,
	schema: string,
	statements: LedgerStatements
): Effect.fn.Return<LedgerState, MigrateError> {
	const apart = (read: readonly [BatchStatement, ...Array<BatchStatement>]) =>
		Effect.mapError(session.apart(read), (failure) =>
			stopped(new LedgerUnread({ schema, failure }))
		)
	const present = yield* apart([ledgerExistsRead(schema)])
	const ledger = yield* Effect.mapError(
		Effect.fromResult(ledgerPresence(schema, sentAnswer(present, 0))),
		stopped
	)
	if (ledger === "absent") {
		return ledgerStateOf(schema, { kind: "absent" })
	}
	const rows = yield* apart([ledgerRowsRead(statements)])
	const read = yield* Effect.mapError(
		Effect.fromResult(installedLedger(schema, sentAnswer(rows, 0))),
		stopped
	)
	return ledgerStateOf(schema, read)
})

/**
 * The proofs a drift check that found no drift found (DriftVerdict proofs), recorded under the apply lock in a
 * transaction of their own: every row deleted and the check's rows written, where the check's rows are not the ones it
 * read; nothing where they are, or where the snapshot holds no proofs table, as the empty snapshot of a schema with no
 * committed migration does not.
 */
const recordProofs = (
	session: MigrationSession,
	snapshot: DeploySnapshot,
	proofs: ProofStatements,
	verdict: DriftVerdict
): Effect.Effect<void, MigrateError> => {
	const held = verdict.proofs
	const schema = snapshot.schema
	if (
		held.kind === "held" ||
		!Arr.some(snapshot.manifest.objects, (o) => o.ident === proofsIdent(schema))
	) {
		return Effect.void
	}
	return Effect.mapError(
		session.transaction([
			oneShotStatement(proofs.clear.text, []),
			oneShotStatement(proofs.record.text, [
				textArray(Arr.map(held.rows, (r) => r.object)),
				textArray(Arr.map(held.rows, (r) => r.ddl)),
				textArray(Arr.map(held.rows, (r) => r.description))
			])
		]),
		(failure: BatchFailure | InputTooLarge) =>
			stopped(
				new ProofsUnrecorded({
					schema,
					failure: failure._tag === "InputTooLarge" ? failure : decidingFailure(failure)
				})
			)
	)
}

/**
 * Applies every target on a session: checks and plans every schema first, then runs the plans in order, then admits
 * every schema. A refusal of any schema's checks runs no statement of any folder.
 */
export const applyOnSession = Effect.fn("applyOnSession")(function* (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Effect.fn.Return<ReadonlyArray<SchemaApplyReport>, MigrateError, Scope.Scope> {
	const checked = yield* Effect.fromResult(checkTargets(targets, session.installation))
	return yield* applyChecked(session, checked)
}, Effect.scoped)

/**
 * Applies every checked target on a session (applyOnSession): plans every schema, then runs the plans in order, then
 * checks every schema's drift, recording each one's proofs once its check found no drift, under its apply lock.
 */
const applyChecked = Effect.fn("applyChecked")(function* (
	session: MigrationSession,
	checked: ReadonlyArray<Checked>
): Effect.fn.Return<ReadonlyArray<SchemaApplyReport>, MigrateError, Scope.Scope> {
	const { planned, grants, lockTable } = yield* surveyAll(session, checked)
	yield* lockTableHolds(planned, lockTable)
	const reports: Array<SchemaApplyReport> = []
	for (const p of planned) {
		const report = yield* runPlan(session, p)
		reports.push(report)
	}
	for (const p of planned) {
		yield* grantReplicationRight(session, p.snapshot.schema, p.decoder, grants)
	}
	for (const p of planned) {
		const verdict = yield* checkDrift(session, p.snapshot, p.statements, p.proofs, p.folders)
		yield* recordProofs(session, p.snapshot, p.proofs, verdict)
	}
	return reports
})

/**
 * Checks every target's catalog against its snapshot without applying anything: the drift check of each schema, in
 * order, with no apply lock taken and no file run. The first schema that drifts refuses, as migrate's drift stage does.
 */
const driftOnSession = Effect.fn("driftOnSession")(function* (
	session: MigrationSession,
	targets: ReadonlyArray<MigrationTarget>
): Effect.fn.Return<void, MigrateError> {
	for (const checked of yield* Effect.fromResult(checkTargets(targets, session.installation))) {
		yield* checkDrift(
			session,
			checked.parsed.snapshot,
			checked.statements,
			checked.proofs,
			checked.parsed.folders
		)
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
	const checked = yield* Effect.fromResult(
		checkTargets(input.targets, connectionInstallation(input.connection))
	)
	const session = yield* openMigrationSession(input.connection)
	return yield* applyChecked(session, checked)
}, Effect.scoped)
