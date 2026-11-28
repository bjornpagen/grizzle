/** What rule-log.test.ts reads: its space, over rule-delta-reads.fixtures.ts's installation, and each case's run. */

import { assert } from "@bjornpagen/testing/assert"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import type { Case } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { quoteString } from "#compiler/core/text.ts"
import type { CreateJudgeLog } from "#compiler/sql/ast.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import { selectionRelations } from "#test/pg/laws/rule-delta-reads.fixtures.ts"
import type { Installed } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import type { RawSession } from "#test/support/substrate/session.ts"

/** The statements a case's transaction writes through: one, a few, and many, each a capture's one call. */
const statementCounts = [1, 8, 64] as const

/** A case: the statements its one transaction runs, each writing `rows` rows of T of the judged kinds. */
export interface Logging {
	readonly statements: (typeof statementCounts)[number]
	readonly rows: number
}

export const loggingGen: Gen<Logging> = (s) => ({
	statements: s.draw(element(statementCounts)),
	rows: s.draw(int(1, 16))
})

export type LoggingFeature = "one statement" | "a few statements" | "many statements"

/** The installation's log of the rule judge, its arm and its delta log, each printed (sql/ast.ts CreateJudgeLog). */
const logOf = (
	installed: Installed
): { readonly arm: string; readonly deltas: string; readonly sides: ReadonlyArray<string> } => {
	const created = Arr.flatMap(
		installed.installation.statements,
		(st): ReadonlyArray<CreateJudgeLog> => (st.kind === "createJudgeLog" ? [st] : [])
	)
	const arm = Arr.findFirst(created, (st) => st.log.kind === "arm").pipe(Option.getOrUndefined)
	const deltas = Arr.findFirst(created, (st) => st.log.kind === "deltas").pipe(
		Option.getOrUndefined
	)
	assert.ok(
		arm !== undefined && deltas !== undefined,
		"the installation creates the judge's arm and its delta log"
	)
	return {
		arm: printObjectName(arm.table),
		deltas: printObjectName(deltas.table),
		sides: deltas.log.kind === "deltas" ? Arr.map(deltas.log.sides, (side) => side.column) : []
	}
}

/** The rows the transaction inserted, updated and deleted of `table` so far (pg_stat_xact_user_tables). */
const touched = (session: RawSession, table: string) =>
	Effect.map(
		session.values(
			`SELECT n_tup_ins::int8, n_tup_upd::int8, n_tup_del::int8 FROM pg_catalog.pg_stat_xact_user_tables WHERE relid = pg_catalog.to_regclass(${quoteString(table)})`,
			[]
		),
		(rows) => ({
			inserted: Number(rows[0]?.[0] ?? 0),
			updated: Number(rows[0]?.[1] ?? 0),
			deleted: Number(rows[0]?.[2] ?? 0)
		})
	)

/**
 * One case on a fresh clone, in one session: its transaction's statements, each an INSERT of `rows` rows of T, each of
 * a judged kind, so T's capture logs each statement's rows on T's side of news (physical/ddl/rules.ts logged). Before
 * the judge runs, the delta log holds one row for each statement and, across them, each row the statements wrote once,
 * and the transaction has updated and deleted none of them, each inserted where it stands until the judge claims it;
 * its arm holds one row, inserted by the first capture and moved to the newest delta row by each. Once the judge has
 * run, at SET CONSTRAINTS ALL IMMEDIATE, the transaction has deleted each delta row once, and the arm row, and updated
 * no delta row: a capture costs its own rows, never a rewrite of a row another wrote, so the log's work over s
 * statements of n rows is s rows and s times n elements, where an append of each capture's rows to one row of the
 * transaction's rewrote that row at each, s times s times n elements over the transaction.
 */
export const runLogging = (
	installed: Installed,
	session: RawSession,
	k: Logging,
	c: Case<LoggingFeature>
) =>
	Effect.gen(function* () {
		const log = logOf(installed)
		const [T] = selectionRelations
		const table = namesOf(installed).table(T)
		c.note(
			k.statements === 1
				? "one statement"
				: k.statements === 8
					? "a few statements"
					: "many statements"
		)
		const where = Formatter.format(k)
		yield* session.begin
		for (const at of Array.from({ length: k.statements }, (_, i) => i)) {
			const values = Array.from(
				{ length: k.rows },
				(_, i) => `(1, ${at * 1000 + i}, ${(i % 3) + 1}, ${i})`
			)
			yield* session.query(
				`INSERT INTO ${table} (doc, at, kind, b) VALUES ${Arr.join(values, ", ")}`,
				[]
			)
		}
		const deltas = yield* touched(session, log.deltas)
		const arm = yield* touched(session, log.arm)
		assert.deepEqual(
			deltas,
			{ inserted: k.statements, updated: 0, deleted: 0 },
			`${where}: each capture inserts one delta row and rewrites none`
		)
		assert.deepEqual(
			arm,
			{ inserted: 1, updated: k.statements, deleted: 0 },
			`${where}: the first capture inserts the transaction's arm row, and each moves it to its delta row`
		)
		const [[elements] = []] = yield* session.values(
			`SELECT COALESCE(sum(${Arr.join(
				Arr.map(log.sides, (side) => `COALESCE(pg_catalog.cardinality(d.${side}), 0)`),
				" + "
			)}), 0)::int8 FROM ${log.deltas} AS d`,
			[]
		)
		assert.equal(
			Number(elements),
			k.statements * k.rows,
			`${where}: the log holds each row the statements wrote once`
		)
		yield* session.query("SET CONSTRAINTS ALL IMMEDIATE", [])
		const claimed = yield* touched(session, log.deltas)
		const disarmed = yield* touched(session, log.arm)
		assert.deepEqual(
			claimed,
			{ inserted: k.statements, updated: 0, deleted: k.statements },
			`${where}: the judge's claim deletes each delta row once, and nothing rewrites one`
		)
		assert.equal(disarmed.deleted, 1, `${where}: the judge deletes the transaction's arm row`)
		yield* session.commit
	}).pipe(Effect.scoped)

/** A case of two writers: the rows each writes of its own document, and which commits first. */
export interface TwoWriters {
	readonly rows: readonly [number, number]
	readonly firstCommits: 0 | 1
}

export const twoWritersGen: Gen<TwoWriters> = (s) => ({
	rows: [s.draw(int(1, 16)), s.draw(int(1, 16))],
	firstCommits: s.draw(element([0, 1] as const))
})

export type TwoWritersFeature = "the first writer commits first" | "the second writer commits first"

/**
 * Two SERIALIZABLE writers of documents of their own, each in a session of its own, interleaved: each opens its
 * transaction and writes its rows of T, then each commits, in the drawn order, its judge claiming its own log rows at
 * its COMMIT. Both commit: no read of the log takes a predicate lock, every read of it by tuple id of the transaction's
 * own rows (predicate.c PredicateLockTID) or an arbiter's check under a dirty snapshot, so neither's capture or claim
 * conflicts with the other's, where a claim that read the log by an index range of its transaction's id took a
 * predicate lock on the index's page both transactions' rows share, and failed one of them 40001 at every
 * interleaving.
 */
export const runTwoWriters = (
	installed: Installed,
	sessions: readonly [RawSession, RawSession],
	k: TwoWriters,
	c: Case<TwoWritersFeature>
) =>
	Effect.gen(function* () {
		const [T] = selectionRelations
		const table = namesOf(installed).table(T)
		c.note(
			k.firstCommits === 0 ? "the first writer commits first" : "the second writer commits first"
		)
		for (const [at, session] of sessions.entries()) {
			yield* session.begin
			const values = Array.from(
				{ length: k.rows[at] ?? 1 },
				(_, i) => `(${at + 1}, ${i}, ${(i % 3) + 1}, ${i})`
			)
			yield* session.query(
				`INSERT INTO ${table} (doc, at, kind, b) VALUES ${Arr.join(values, ", ")}`,
				[]
			)
		}
		const order = k.firstCommits === 0 ? sessions : ([sessions[1], sessions[0]] as const)
		for (const [at, session] of order.entries()) {
			const committed = yield* Effect.result(session.commit)
			assert.ok(
				Result.isSuccess(committed),
				`${Formatter.format(k)}: the writer committing ${at === 0 ? "first" : "second"} commits, its judge conflicting with no other's`
			)
		}
	})
