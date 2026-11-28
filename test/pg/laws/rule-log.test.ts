/**
 * A rule capture costs its own rows, and the judge's log is insert-only until the judge claims it (physical/ddl/rules.ts
 * logged, claimed): each capture inserts one row of the delta log, its statement's rows of each side it logs, linked to
 * the transaction's newest, and moves the transaction's arm row to it; no statement rewrites a delta row, so each stands
 * at the tuple id it was inserted at, which the arm and the row after it link, until the judge's claim, the one
 * statement that deletes it, deletes it. So a transaction of s statements of n rows each costs the log s rows and s times
 * n elements, where an append of each capture's rows to one row of the transaction's rewrote that row at each: s times s
 * times n elements, edullm's publish of thousands of statements quadratic in its log.
 *
 * On PostgreSQL 19, over rule-delta-reads.fixtures.ts's installation: each case's transaction runs one, eight or 64
 * INSERTs of T, each of 1 to 16 rows of the judged kinds, then the judge, by SET CONSTRAINTS ALL IMMEDIATE.
 *
 * Oracle: the transaction's table statistics of the log (pg_stat_xact_user_tables) and the delta log's elements: before
 * the judge, one delta row inserted per statement and none updated or deleted, each row the statements wrote once among
 * their elements, the arm row inserted once and moved once per statement; after it, each delta row deleted once and the
 * arm row deleted.
 *
 * And two SERIALIZABLE writers of documents of their own, interleaved, both commit, in either order: no read of the log
 * takes a predicate lock (rule-log.fixtures.ts runTwoWriters), where a claim by an index range of the transaction's id
 * failed one of two such writers 40001 at each of 30 interleavings.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { selectionTemplate } from "#test/pg/laws/rule-delta-reads.fixtures.ts"
import {
	type LoggingFeature,
	loggingGen,
	runLogging,
	runTwoWriters,
	type TwoWritersFeature,
	twoWritersGen
} from "#test/pg/laws/rule-log.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A transaction's captures cost the log one row per statement and each row written once, none rewritten, and the judge's
 * claim deletes each once.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCaptureCostsTheLogItsOwnRowsAndTheLogIsInsertOnlyUntilTheJudgeClaimsIt =
	property.explore(loggingGen, {
		needs: { selection: Substrate.fresh(selectionTemplate) },
		situations: [
			"one statement",
			"a few statements",
			"many statements"
		] satisfies ReadonlyArray<LoggingFeature>,
		check:
			({ selection }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* selection
					const session = yield* substrate.session({ ...ownerSession(), label: "logging" })
					yield* runLogging(value, session, drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "the transaction's table statistics of the judge's log and the delta log's elements: one delta row per statement, none updated, each written row once, the arm row inserted once and moved per statement; after the judge, each delta row and the arm row deleted once"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					"[variable(captureNames.head), ...logging.map((side) => variable(side.delta.name))]",
				replacement:
					'[variable(captureNames.head), ...logging.map((side) => ({ kind: "binary" as const, op: "||" as const, left: variable(side.delta.name), right: variable(side.delta.name), schema: undefined }))]',
				why: "Each capture appends its rows to themselves before it logs them, an append's rewrite of rows already held: the log holds each written row twice; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.row)]] }',
				replacement:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.head)]] }',
				why: "A capture leaves the arm's head where it read it, so the judge's claim reaches none of the transaction's delta rows and deletes none; the property fails."
			}
		]
	})

/**
 * Two SERIALIZABLE writers of documents of their own commit both, whichever commits first: no read of the judge's log
 * takes a predicate lock.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const twoSerializableWritersOfDocumentsOfTheirOwnBothCommitTheirJudgesReadingTheLogUnderNoPredicateLock =
	property.explore(twoWritersGen, {
		needs: { selection: Substrate.fresh(selectionTemplate) },
		situations: [
			"the first writer commits first",
			"the second writer commits first"
		] satisfies ReadonlyArray<TwoWritersFeature>,
		check:
			({ selection }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const { substrate, value } = yield* selection
					const first = yield* substrate.session({ ...ownerSession(), label: "first writer" })
					const second = yield* substrate.session({ ...ownerSession(), label: "second writer" })
					yield* runTwoWriters(value, [first, second], drawn, c)
				}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "both writers' COMMITs at SERIALIZABLE, interleaved: each commits, no 40001"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\t\t\t\t\t\t\t\teq(col("r3", "ctid"), col("r2", "c1")),\n',
				replacement: '\t\t\t\t\t\t\t\t\t\teq(col("r3", judgeLogColumns.prev), col("r2", "c1")),\n',
				why: "The claim reads the log by each row's link column, which no index holds, so PostgreSQL scans the delta log under a predicate lock on the whole relation, which the other writer's capture writes into: one of the two fails 40001; the property fails."
			}
		]
	})
