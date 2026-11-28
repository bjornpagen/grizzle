/** What rule-commit.test.ts reads: its space over rule-whole.fixtures.ts's judges, and each case's run. */

import { element, type Gen } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import { quoteString } from "#compiler/core/text.ts"
import { type CreateJudgeLog, judgeLogColumns } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	bracketOf,
	type Judge,
	type ShapeKey,
	shapeKeys,
	statementsOf,
	tablesOf
} from "#test/pg/laws/rule-whole.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

const judges = ["whole", "probed"] as const satisfies ReadonlyArray<Judge>
const docs = [1, 2] as const

/**
 * A case: the judge and the unit shape it runs on, and its session's transactions, each a write of one document: both
 * documents written whole and lawful (rule-whole.fixtures.ts statementsOf `unit` at type 1, which keeps every rule; at
 * type 0 One type refuses it), the first the session's first transaction, then one of them dropped: on the probed judge
 * a served write; on the whole judge a data step, its relations closed (rule-whole.fixtures.ts bracketOf), whose
 * removals each capture logs on its side of news, each counted, which the judge its bracket runs nets away.
 */
export interface Commits {
	readonly judge: Judge
	readonly shape: ShapeKey
	readonly dropped: (typeof docs)[number]
}

export const commitsGen: Gen<Commits> = (s) => ({
	judge: s.draw(element(judges)),
	shape: s.draw(element(shapeKeys)),
	dropped: s.draw(element(docs))
})

export type CommitFeature =
	| "a whole judge's log"
	| "a probed judge's log"
	| "a whole judge's data step, its removals netted away"

class Logged extends Data.TaggedError("Logged")<{ readonly message: string }> {}

/** The installation's log of the rule judge (sql/ast.ts CreateJudgeLog): its arm and its delta log, each printed. */
interface JudgeLog {
	readonly arm: string
	readonly deltas: string
}

/** The judge's log `installed` creates, by its two CREATE UNLOGGED TABLEs (physical/ddl/rules.ts addRules). */
const logOf = (installed: Installed) =>
	Effect.gen(function* () {
		const created = Arr.flatMap(
			installed.installation.statements,
			(st): ReadonlyArray<CreateJudgeLog> => (st.kind === "createJudgeLog" ? [st] : [])
		)
		const [arm, ...arms] = Arr.filter(created, (st) => st.log.kind === "arm")
		const [deltas, ...logs] = Arr.filter(created, (st) => st.log.kind === "deltas")
		if (arm === undefined || deltas === undefined || arms.length + logs.length > 0) {
			return yield* new Logged({
				message: `the installation creates ${created.length} judge logs, not one arm and one delta log`
			})
		}
		return {
			arm: printObjectName(arm.table),
			deltas: printObjectName(deltas.table)
		} satisfies JudgeLog
	})

/** One count `sql` reads. */
const counted = (session: RawSession, sql: string) =>
	Effect.map(session.values(sql, []), (rows) => Number(rows[0]?.[0]))

/** The rows the transaction sees in the log's arm and in its delta log. */
const logRows = (session: RawSession, log: JudgeLog) =>
	Effect.all({
		arm: counted(session, `SELECT count(*) FROM ${log.arm}`),
		deltas: counted(session, `SELECT count(*) FROM ${log.deltas}`)
	})

/**
 * The transaction's chain through the delta log: its arm row's count, and the delta rows its head reaches, each read from
 * the one after it by its link, by tuple id, as the judge's claim reads them (physical/ddl/rules.ts claimed), counted
 * with the distinct tuple ids among them. A delta row is insert-only until the judge claims it, so its tuple id stands
 * for it and the chain reaches each of the transaction's rows once; a row rewritten would stand at another tuple id,
 * and the link to it would reach none.
 */
const chainOf = (session: RawSession, log: JudgeLog) =>
	Effect.map(
		session.values(
			`WITH RECURSIVE chain (t, prev) AS (SELECT d.ctid, d.${judgeLogColumns.prev} FROM ${log.arm} AS a JOIN ${log.deltas} AS d ON d.ctid = a.${judgeLogColumns.last} WHERE a.${judgeLogColumns.xact} = pg_catalog.pg_current_xact_id() UNION SELECT d.ctid, d.${judgeLogColumns.prev} FROM chain AS c JOIN ${log.deltas} AS d ON d.ctid = c.prev) SELECT (SELECT count(*) FROM ${log.arm} AS a WHERE a.${judgeLogColumns.xact} = pg_catalog.pg_current_xact_id()), count(*), count(DISTINCT t) FROM chain`,
			[]
		),
		(rows) => ({
			arms: Number(rows[0]?.[0]),
			reached: Number(rows[0]?.[1]),
			distinct: Number(rows[0]?.[2])
		})
	)

/**
 * The predicate locks the session's transaction holds on the log: none, since every read of it is by tuple id of the
 * transaction's own rows (REL_19_0 src/backend/storage/lmgr/predicate.c PredicateLockTID, which returns before it locks
 * a tuple its own transaction wrote) or an arbiter's check of a conflict, under a dirty snapshot, which takes none
 * (SerializationNeededForRead, an MVCC snapshot's alone), so no SERIALIZABLE transaction of another session conflicts
 * with a capture or a claim of this one's.
 */
const predicateLocks = (session: RawSession, log: JudgeLog) =>
	counted(
		session,
		`SELECT count(*) FROM pg_catalog.pg_locks AS l WHERE l.mode = 'SIReadLock' AND l.pid = pg_catalog.pg_backend_pid() AND l.relation IN (pg_catalog.to_regclass(${quoteString(log.arm)}), pg_catalog.to_regclass(${quoteString(log.deltas)}))`
	)

/**
 * The rows of the system catalogs the transaction inserted, updated or deleted so far (pg_stat_xact_sys_tables, its
 * counts not yet flushed): none, since a served transaction writes no catalog, the judge's log standing since its
 * install, where a session's first write stood up its temporary deltas, each a pg_class, pg_type, pg_attribute and
 * pg_depend row, whose invalidations every backend of the database reads.
 */
const catalogWrites = (session: RawSession) =>
	counted(
		session,
		"SELECT COALESCE(sum(s.n_tup_ins + s.n_tup_upd + s.n_tup_del), 0)::int8 FROM pg_catalog.pg_stat_xact_sys_tables AS s"
	)

/**
 * The grantees of the log's tables other than their owner, and whether that owner is the judge's definer, the owner of
 * the arm's trigger's function: none, so no role but the judge's definer reads or writes the log (pg_class relacl, or
 * its default where none is set, acldefault, which grants a table's owner alone).
 */
const closed = (session: RawSession, log: JudgeLog) =>
	Effect.map(
		session.values(
			`SELECT (SELECT count(*) FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) AS g WHERE c.oid IN (pg_catalog.to_regclass(${quoteString(log.arm)}), pg_catalog.to_regclass(${quoteString(log.deltas)})) AND g.grantee <> c.relowner), (SELECT pg_catalog.bool_and(c.relowner = p.proowner) FROM pg_catalog.pg_class AS c, pg_catalog.pg_trigger AS t JOIN pg_catalog.pg_proc AS p ON p.oid = t.tgfoid WHERE t.tgrelid = pg_catalog.to_regclass(${quoteString(log.arm)}) AND c.oid IN (pg_catalog.to_regclass(${quoteString(log.arm)}), pg_catalog.to_regclass(${quoteString(log.deltas)})))`,
			[]
		),
		(rows) => ({ grantees: Number(rows[0]?.[0]), definers: rows[0]?.[1] === true })
	)

/**
 * Writes the case's documents whole, one transaction each, in one fresh session, then drops one, then writes one again
 * in a transaction it rolls back, and reads what each leaves of the judge's log. The log is its owner's alone, the
 * judge's definer's. A served write's captures log its rows: its transaction's one arm row, whose head reaches each of
 * its delta rows once, by tuple id, each at the tuple id it was inserted at. The whole judge's drop is a data step,
 * inside its bracket, whose captures log each removed row on its side of news, counted, and whose bracket's SET
 * CONSTRAINTS ALL IMMEDIATE runs the judge, which nets them away, before its re-check judges the step whole. Once the
 * judge has run, at SET CONSTRAINTS ALL IMMEDIATE, the log holds no row the transaction sees, its claims having deleted
 * each delta row and the arm row; the transaction holds no predicate lock on the log after its captures or after its
 * judge, and a served one has written no catalog row, its first included, where a session's first write stood up its
 * deltas as temporary tables. After each COMMIT, and after the rollback, the log holds no row.
 */
export const runCommits = (
	installed: Installed,
	session: RawSession,
	k: Commits,
	c: Case<CommitFeature>
) =>
	Effect.gen(function* () {
		const tables = tablesOf(installed, k.shape)
		const log = yield* logOf(installed)
		c.note(k.judge === "whole" ? "a whole judge's log" : "a probed judge's log")
		const owned = yield* closed(session, log)
		if (owned.grantees > 0 || !owned.definers) {
			return yield* new Logged({
				message: `the log is readable beyond the judge's definer (${owned.grantees} other grantees, the definer's: ${String(owned.definers)}) in ${Formatter.format(k)}`
			})
		}
		const ops = [
			...Arr.map(docs, (doc) => ({ kind: "unit", doc, type: 1 }) as const),
			{ kind: "drop", doc: k.dropped } as const
		]
		for (const op of ops) {
			const where = `${op.kind} of document ${op.doc} in ${Formatter.format(k)}`
			const bracket = bracketOf(k.judge, installed, [op])
			yield* session.begin
			for (const sql of [
				...Option.match(bracket, { onNone: () => [], onSome: (b) => b.before }),
				...statementsOf(tables, op)
			]) {
				yield* session.query(sql, [])
			}
			const captured = yield* predicateLocks(session, log)
			if (captured > 0) {
				return yield* new Logged({
					message: `the transaction holds ${captured} predicate locks on the log after its captures, ${where}`
				})
			}
			if (Option.isSome(bracket)) {
				for (const sql of bracket.value.after) {
					yield* session.query(sql, [])
				}
				c.note("a whole judge's data step, its removals netted away")
			} else {
				yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
				const judged = yield* predicateLocks(session, log)
				if (judged > 0) {
					return yield* new Logged({
						message: `the transaction holds ${judged} predicate locks on the log after its judge, ${where}`
					})
				}
				const written = yield* catalogWrites(session)
				if (written > 0) {
					return yield* new Logged({
						message: `the served transaction wrote ${written} catalog rows, ${where}`
					})
				}
			}
			const left = yield* logRows(session, log)
			if (left.arm + left.deltas > 0) {
				return yield* new Logged({
					message: `the judge left ${Formatter.format(left)} rows in the log, ${where}`
				})
			}
			yield* session.commit
			const after = yield* logRows(session, log)
			if (after.arm + after.deltas > 0) {
				return yield* new Logged({
					message: `the log holds ${Formatter.format(after)} rows after the COMMIT, ${where}`
				})
			}
		}
		yield* session.begin
		for (const sql of statementsOf(tables, { kind: "unit", doc: k.dropped, type: 1 })) {
			yield* session.query(sql, [])
		}
		const chain = yield* chainOf(session, log)
		const logged = yield* logRows(session, log)
		if (
			chain.arms !== 1 ||
			logged.deltas === 0 ||
			chain.reached !== logged.deltas ||
			chain.distinct !== logged.deltas
		) {
			return yield* new Logged({
				message: `the transaction's ${chain.arms} arm rows reach ${chain.reached} delta rows, ${chain.distinct} distinct, of the ${logged.deltas} it logged, a unit of document ${k.dropped} in ${Formatter.format(k)}`
			})
		}
		yield* session.rollback
		const aborted = yield* logRows(session, log)
		if (aborted.arm + aborted.deltas > 0) {
			return yield* new Logged({
				message: `the log holds ${Formatter.format(aborted)} rows after a rolled-back unit of document ${k.dropped} in ${Formatter.format(k)}`
			})
		}
	})
