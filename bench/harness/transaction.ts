import { Array as Arr, Effect, Option, Schema, type Scope } from "effect"
import { type Summary, summarize } from "#bench/cold/stats.ts"
import {
	type Explained,
	type ExplainOptions,
	explain,
	type MalformedPlan,
	type PlanSummary,
	summarizePlans
} from "#bench/harness/explain.ts"

import {
	type FailedOutcome,
	failedAt,
	failedAtStatement,
	type Outcome,
	type OutcomeKey,
	outcomeKey
} from "#bench/harness/outcome.ts"

import {
	type Observed,
	PhaseClock,
	type StandardPhase,
	standardPhases
} from "#bench/harness/phases.ts"
import type { BenchSession } from "#bench/harness/session.ts"
import { measureWal, type WalDelta } from "#bench/harness/wal.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import type { PgConnection, SqlError } from "#test/support/pg.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"

/**
 * One transaction under measurement (R12).
 *
 * EXPLAIN of a write does not run the deferred constraint triggers that wait for the end of the transaction, so COMMIT
 * is timed separately, with its checks, WAL flush and outcome; immediate trigger time and deferred commit work are
 * distinct. A transaction under measurement is BEGIN ISOLATION LEVEL SERIALIZABLE, its statements in order, each run
 * plainly or under EXPLAIN ANALYZE (which executes it, so an explained write writes once), and its end:
 * - `plain`: COMMIT, timed as commitMs: the deferred checks, the WAL flush and the outcome together, as a writer sees
 *   them;
 * - `split`: SET CONSTRAINTS ALL IMMEDIATE first, timed as deferredChecksMs, which fires every deferred constraint
 *   trigger, residual law functions and deferred foreign keys alike, at that statement; then COMMIT, timed as
 *   commitMs, whose remaining work is the commit record and its flush. Firing the deferred events at the statement is
 *   exactly what COMMIT does first, so the work is the same and only its attribution changes;
 * - `rollback`: ROLLBACK after the statements, for statements whose cost is wanted without a commit.
 *
 * The deferred-event queue is a transaction resource (R12): it lives in the backend's AfterTriggerEvents memory context
 * under TopTransactionContext, in chunks of up to 1MB, with no spill. With `deferredEvents`, the context's size is read
 * after the statements and before the end, when every deferred event is still queued. Reading
 * pg_backend_memory_contexts needs the privileges of pg_read_all_stats. On the local cluster the migration identity is
 * a member of pg_read_all_stats that does not inherit its privileges but may SET ROLE to it and grant it, so the
 * reading SETs ROLE to pg_read_all_stats for its one statement and back, inside the transaction under measurement,
 * which changes nothing the transaction queued; a login is made able to do the same by `grantMemoryReading`.
 * A role that can neither read the view nor SET ROLE to pg_read_all_stats gets an unavailable reading, with the reason,
 * rather than an aborted transaction; readability is checked before BEGIN.
 *
 * A statement that fails ends the transaction with a failed outcome at that statement, by its SQLSTATE's cause
 * (outcome.ts), and the session is rolled back, so a load loop can go on with the next operation; an error that
 * carries no SQLSTATE is a defect of the run. With `wal`, the whole transaction runs inside the per-backend WAL
 * reading of wal.ts, which needs a direct session.
 */
export interface TransactionStatement {
	readonly label: string
	readonly sql: string
	/** Text parameters, cast by the statement. */
	readonly params: ReadonlyArray<string>
	/** Run under EXPLAIN ANALYZE (with `transactionExplain`) instead of plainly. */
	readonly explain: boolean
}

/**
 * The capture an explained statement of a transaction runs under: WAL, since a transaction under measurement writes,
 * and no SERIALIZE, since a write returns at most its read-back.
 */
const transactionExplain: ExplainOptions = { wal: true, serialize: { kind: "off" } }

export type TransactionEnd = "plain" | "split" | "rollback"

export interface TransactionPlan {
	readonly readOnly: boolean
	readonly statements: ReadonlyArray<TransactionStatement>
	readonly end: TransactionEnd
	readonly deferredEvents: boolean
	/** Per-backend WAL around the transaction; the session must be direct. */
	readonly wal: boolean
}

export type DeferredEventMemory =
	| { readonly available: true; readonly totalBytes: number; readonly usedBytes: number }
	| { readonly available: false; readonly reason: string }

export interface StatementMeasure {
	readonly label: string
	readonly ms: number
	/** Rows returned, or for an explained statement its root's total output (actual rows over all loops). */
	readonly rows: number
	readonly explained: Observed<Explained>
}

export interface TransactionMeasure {
	/** beginMs, executeMs (every statement), deferredChecksMs (split only), commitMs (plain or split) or rollbackMs. */
	readonly phases: Readonly<Partial<Record<StandardPhase, number>>>
	readonly statements: ReadonlyArray<StatementMeasure>
	readonly outcome: Outcome
	readonly deferredEvents: Observed<DeferredEventMemory>
	readonly wal: Observed<WalDelta>
}

const deferredEventsUnreadable =
	"pg_backend_memory_contexts needs the privileges of pg_read_all_stats, which this session's role neither holds nor may SET ROLE to"

/** The predefined role whose privileges reading pg_backend_memory_contexts needs. */
const memoryReadingRole = "pg_read_all_stats"

/**
 * How this session may read its own memory contexts: with its own privileges, by SET ROLE pg_read_all_stats for the
 * reading, or not at all.
 */
type MemoryAccess = "direct" | "setRole" | "none"

/** The two privileges' answers, from PostgreSQL: external input, decoded. */
const AccessRows = Schema.Tuple([
	Schema.Tuple([Schema.Literals(["true", "false"]), Schema.Literals(["true", "false"])])
])

/**
 * This session's access to its memory contexts: its current role's privilege, or the SET option of its session user,
 * which SET ROLE checks, so a direct writer that took on a world's role reads as its login may. Outside a transaction
 * block, or in one that has not failed.
 */
const memoryAccess = (session: BenchSession): Effect.Effect<MemoryAccess, SqlError> =>
	Effect.flatMap(
		session.values(
			"SELECT pg_catalog.has_table_privilege('pg_catalog.pg_backend_memory_contexts'::text, 'SELECT'::text)::text, " +
				"pg_catalog.pg_has_role(session_user, $1::text, 'SET'::text)::text",
			[memoryReadingRole]
		),
		(rows) =>
			Effect.map(
				Effect.orDie(Schema.decodeUnknownEffect(AccessRows)(rows)),
				([[direct, setRole]]) =>
					direct === "true" ? "direct" : setRole === "true" ? "setRole" : "none"
			)
	)

/**
 * Lets the sessions of `role`, a login role, read their memory contexts in a transaction under measurement: membership
 * in pg_read_all_stats WITH INHERIT FALSE, SET TRUE, granted by `admin` (the migration identity, which holds that role
 * WITH ADMIN), so `role` holds none of its privileges outside the reading. The finalizer revokes it; dropping the role
 * removes it as well. A revoke that fails leaves the role able to read every backend's statistics, so it is a defect.
 */
export const grantMemoryReading = (
	admin: PgConnection,
	role: string
): Effect.Effect<void, SqlError, Scope.Scope> =>
	Effect.asVoid(
		Effect.acquireRelease(
			admin.query(
				`GRANT ${quoteIdent(memoryReadingRole)} TO ${quoteIdent(role)} WITH INHERIT FALSE, SET TRUE`,
				[]
			),
			() =>
				Effect.orDie(
					admin.query(
						`REVOKE ${quoteIdent(memoryReadingRole)} FROM ${quoteIdent(role)} CASCADE`,
						[]
					)
				)
		)
	)

const contextQuery =
	"SELECT total_bytes::text, used_bytes::text FROM pg_catalog.pg_backend_memory_contexts WHERE name = 'AfterTriggerEvents'::text"

/** The context's rows, from PostgreSQL: external input, decoded. */
const ContextRows = Schema.Array(Schema.Tuple([Schema.FiniteFromString, Schema.FiniteFromString]))

/**
 * The AfterTriggerEvents context's size now: zero when no AFTER event is queued, since the context is created with the
 * first one. With `setRole`, the reading SETs ROLE to pg_read_all_stats and back to the role it ran as, which ends the
 * reading as it began even when the session had SET ROLE before; a restore that fails would leave the session measuring
 * as pg_read_all_stats, so it is a defect.
 */
const deferredEventMemory = Effect.fn("deferredEventMemory")(function* (
	session: BenchSession,
	access: Exclude<MemoryAccess, "none">
): Effect.fn.Return<DeferredEventMemory, SqlError> {
	const read = Effect.flatMap(session.values(contextQuery, []), (rows) =>
		Effect.map(Effect.orDie(Schema.decodeUnknownEffect(ContextRows)(rows)), (sizes) => ({
			available: true as const,
			totalBytes: Arr.reduce(sizes, 0, (sum, [total]) => sum + total),
			usedBytes: Arr.reduce(sizes, 0, (sum, [, used]) => sum + used)
		}))
	)
	if (access === "direct") {
		return yield* read
	}
	const currentUserRows = yield* session.values("SELECT current_user::text", [])
	const [[current]] = yield* Effect.orDie(
		Schema.decodeUnknownEffect(CurrentUserRows)(currentUserRows)
	)
	yield* session.values(`SET ROLE ${quoteIdent(memoryReadingRole)}`, [])
	return yield* Effect.ensuring(
		read,
		Effect.orDie(session.values(`SET ROLE ${quoteIdent(current)}`, []))
	)
})

/** current_user's one row, from PostgreSQL: external input, decoded. */
const CurrentUserRows = Schema.Tuple([Schema.Tuple([Schema.String])])

const round = (x: number): number => Math.round(x * 1000) / 1000

const totalOutput = (e: Explained): number => e.plan.actualRows * e.plan.actualLoops

class Failed {
	readonly outcome: FailedOutcome
	constructor(outcome: FailedOutcome) {
		this.outcome = outcome
	}
}

/** Runs `effect`, turning a PostgreSQL error into a Failed value by `failed`; any other failure stays a failure. */
const attempt = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
	failed: (error: E) => Option.Option<FailedOutcome>
) =>
	Effect.catch(effect, (error) =>
		Option.match(failed(error), {
			onNone: () => Effect.fail(error),
			onSome: (outcome) => Effect.succeed(new Failed(outcome))
		})
	)

const unobserved = { kind: "unobserved" } as const

const run = Effect.fn("run")(function* (
	session: BenchSession,
	plan: TransactionPlan
): Effect.fn.Return<Omit<TransactionMeasure, "wal">, SqlError | MalformedPlan> {
	const clock = new PhaseClock()
	const access: MemoryAccess = plan.deferredEvents ? yield* memoryAccess(session) : "none"
	const statements: Array<StatementMeasure> = []
	let deferredEvents: Observed<DeferredEventMemory> = unobserved
	const finish = (outcome: Outcome) =>
		({ phases: clock.take(), statements, outcome, deferredEvents }) satisfies Omit<
			TransactionMeasure,
			"wal"
		>
	/** The transaction already failed; a ROLLBACK that fails too leaves the session unusable for the next sample. */
	const abandon = (failed: Failed) =>
		Effect.as(Effect.orDie(session.values("ROLLBACK", [])), finish(failed.outcome))

	const begun = yield* attempt(
		clock.time(
			"beginMs",
			session.values(`${beginSerializable}${plan.readOnly ? " READ ONLY" : ""}`, [])
		),
		(error) => failedAt(error, "begin")
	)
	if (begun instanceof Failed) {
		return yield* abandon(begun)
	}
	clock.declare("executeMs")
	for (const s of plan.statements) {
		const start = performance.now()
		const ran = yield* attempt(
			clock.time(
				"executeMs",
				s.explain
					? Effect.map(
							explain(session, s.sql, s.params, transactionExplain),
							(explained): Pick<StatementMeasure, "rows" | "explained"> => ({
								rows: totalOutput(explained),
								explained: { kind: "observed", value: explained }
							})
						)
					: Effect.map(
							session.values(s.sql, s.params),
							(rows): Pick<StatementMeasure, "rows" | "explained"> => ({
								rows: rows.length,
								explained: unobserved
							})
						)
			),
			(error) => failedAtStatement(error, s.label)
		)
		if (ran instanceof Failed) {
			return yield* abandon(ran)
		}
		statements.push({ label: s.label, ms: round(performance.now() - start), ...ran })
	}
	if (plan.deferredEvents) {
		deferredEvents = {
			kind: "observed",
			value:
				access === "none"
					? { available: false, reason: deferredEventsUnreadable }
					: yield* deferredEventMemory(session, access)
		}
	}
	switch (plan.end) {
		case "rollback":
			yield* clock.time("rollbackMs", session.values("ROLLBACK", []))
			return finish({ kind: "rolledBack" })
		case "split": {
			const checked = yield* attempt(
				clock.time("deferredChecksMs", session.values("SET CONSTRAINTS ALL IMMEDIATE", [])),
				(error) => failedAt(error, "deferredChecks")
			)
			if (checked instanceof Failed) {
				return yield* abandon(checked)
			}
			break
		}
		case "plain":
			break
	}
	/** A COMMIT that raises has already ended the transaction; the ROLLBACK after it only warns. */
	const committed = yield* attempt(clock.time("commitMs", session.values("COMMIT", [])), (error) =>
		failedAt(error, "commit")
	)
	if (committed instanceof Failed) {
		return yield* abandon(committed)
	}
	return finish({ kind: "committed" })
})

/** Measures one transaction on `session` (see the head of this file). */
export const measureTransaction = (
	session: BenchSession,
	plan: TransactionPlan
): Effect.Effect<TransactionMeasure, SqlError | MalformedPlan> =>
	plan.wal
		? Effect.map(measureWal(session, run(session, plan)), ({ value, wal }) => ({
				...value,
				wal: { kind: "observed", value: wal }
			}))
		: Effect.map(run(session, plan), (value) => ({ ...value, wal: unobserved }))

export interface StatementSeries {
	readonly rows: Summary
	readonly ms: Summary
	/** The explained plans, when the statement ran under EXPLAIN. */
	readonly plan: Observed<PlanSummary>
}

/**
 * A phase summarized over the samples that reached it: a failure before COMMIT leaves COMMIT unreached in that sample,
 * never a zero.
 */
export type ReachedSummary = Summary & { readonly reached: number }

export interface TransactionSeries {
	readonly samples: number
	readonly phases: Readonly<Partial<Record<StandardPhase, ReachedSummary>>>
	/** Final outcomes: `committed`, `rolledBack`, or a failure's cause. */
	readonly outcomes: Readonly<Partial<Record<OutcomeKey, number>>>
	readonly wal: Observed<{
		readonly backendRecords: Summary
		readonly backendFpi: Summary
		readonly backendBytes: Summary
		readonly backendFpiBytes: Summary
		readonly clusterBytes: Summary
		/**
		 * Samples whose window held a completed checkpoint (wal.ts): their full-page images are not comparable with the
		 * others'.
		 */
		readonly checkpointsCompleted: number
	}>
	readonly deferredEvents: Observed<
		| { readonly available: true; readonly totalBytes: Summary; readonly usedBytes: Summary }
		| { readonly available: false; readonly reason: string }
	>
	/** Per statement label: rows, time, and the explained plans when the statement ran under EXPLAIN. */
	readonly statements: Readonly<Record<string, StatementSeries>>
}

const observedValues = <T>(measures: ReadonlyArray<Observed<T>>): ReadonlyArray<T> =>
	Arr.flatMap(measures, (m) => (m.kind === "observed" ? [m.value] : []))

/**
 * The summary of repeated measurements of one transaction plan. Each phase is summarized over the samples that reached
 * it, with their count.
 */
export const summarizeTransactions = (
	measures: ReadonlyArray<TransactionMeasure>
): TransactionSeries => {
	if (measures.length === 0) {
		throw new Error("summarizeTransactions: no samples")
	}
	const phases: Partial<Record<StandardPhase, ReachedSummary>> = {}
	for (const name of standardPhases) {
		const reached = Arr.flatMap(measures, (m) => {
			const ms = m.phases[name]
			return ms === undefined ? [] : [ms]
		})
		if (reached.length > 0) {
			phases[name] = { ...summarize(reached), reached: reached.length }
		}
	}
	const outcomes: Partial<Record<OutcomeKey, number>> = {}
	for (const m of measures) {
		const key = outcomeKey(m.outcome)
		const seen = outcomes[key]
		outcomes[key] = seen === undefined ? 1 : seen + 1
	}
	const wals = observedValues(Arr.map(measures, (m) => m.wal))
	const events = observedValues(Arr.map(measures, (m) => m.deferredEvents))
	const readable = Arr.flatMap(events, (e) => (e.available ? [e] : []))
	const unreadable = Arr.flatMap(events, (e) => (e.available ? [] : [e]))[0]
	const labels = [...new Set(Arr.flatMap(measures, (m) => Arr.map(m.statements, (s) => s.label)))]
	const statements: Record<string, StatementSeries> = {}
	for (const label of labels) {
		const ran = Arr.flatMap(measures, (m) => Arr.filter(m.statements, (s) => s.label === label))
		const explained = observedValues(Arr.map(ran, (s) => s.explained))
		statements[label] = {
			rows: summarize(Arr.map(ran, (s) => s.rows)),
			ms: summarize(Arr.map(ran, (s) => s.ms)),
			plan:
				explained.length === 0 ? unobserved : { kind: "observed", value: summarizePlans(explained) }
		}
	}
	return {
		samples: measures.length,
		phases,
		outcomes,
		wal:
			wals.length === 0
				? unobserved
				: {
						kind: "observed",
						value: {
							backendRecords: summarize(Arr.map(wals, (w) => w.backend.records)),
							backendFpi: summarize(Arr.map(wals, (w) => w.backend.fpi)),
							backendBytes: summarize(Arr.map(wals, (w) => w.backend.bytes)),
							backendFpiBytes: summarize(Arr.map(wals, (w) => w.backend.fpiBytes)),
							clusterBytes: summarize(Arr.map(wals, (w) => w.clusterBytes)),
							checkpointsCompleted: Arr.filter(wals, (w) => w.checkpoint.completed).length
						}
					},
		deferredEvents:
			events.length === 0
				? unobserved
				: {
						kind: "observed",
						value:
							unreadable !== undefined
								? { available: false, reason: unreadable.reason }
								: {
										available: true,
										totalBytes: summarize(Arr.map(readable, (e) => e.totalBytes)),
										usedBytes: summarize(Arr.map(readable, (e) => e.usedBytes))
									}
					},
		statements
	}
}
