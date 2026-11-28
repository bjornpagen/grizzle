/**
 * A judged transaction writes no catalog row, takes no predicate lock on the judge's log and leaves no row of it past
 * its end, and the log is its owner's alone (physical/ddl/rules.ts addRules): the log is two UNLOGGED tables the
 * installation creates, its arm, one row of each open transaction's, whose INSERT arms the judge's deferred trigger and
 * which holds the tuple id of the transaction's newest delta row, and its delta log, one row of each capture's, linked to
 * the one before it; the judge claims the transaction's rows by tuple id and deletes them, and deletes the arm row. Where
 * each session stood up its deltas as temporary tables at its first write, each a pg_class, pg_type, pg_attribute and
 * pg_depend row, a database's connections churned the shared invalidation queue past its end, and every backend that
 * lagged reset its caches and planned every judge and trigger again (METIS-PERFBAR under churn: a start's reads from
 * about 2,000 pages to 12,659, an attempt's judge from 27 to 2,071).
 *
 * Over each unit shape's whole judge and its probed twin of rule-whole.fixtures.ts, a fresh session writes two
 * documents whole and drops one, one transaction each, then writes one again and rolls it back. The whole judge's drop
 * is a data step, its relations closed, whose removals its captures log, counted, and its bracket's judge nets away
 * before its re-check judges it (rule-whole.fixtures.ts bracketOf). Once the judge has run, at SET CONSTRAINTS ALL
 * IMMEDIATE, the log holds no row, the transaction holds no predicate lock on it, after its captures or its judge, and,
 * served, has written no catalog row, its session's first included; after each COMMIT and after the rollback the log
 * holds no row; before the rollback the transaction's one arm row's head reaches each delta row it logged once, by
 * tuple id; and no role but the judge's definer holds a privilege on it.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { commitsGen, runCommits } from "#test/pg/laws/rule-commit.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A judged transaction writes no catalog row, takes no predicate lock on the judge's log and leaves no row of it, and the
 * log is its owner's alone.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aJudgedTransactionWritesNoCatalogRowTakesNoPredicateLockOnTheLogAndLeavesNoRowOfIt =
	property.explore(commitsGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: [
			"a whole judge's log",
			"a probed judge's log",
			"a whole judge's data step, its removals netted away"
		],
		check: (judges, c) => (k) =>
			Effect.gen(function* () {
				const judge = yield* judges[`${k.judge} ${k.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "writer" })
				yield* runCommits(judge.value, session, k, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "the log's rows, its chain by tuple id, the transaction's predicate locks and catalog writes (pg_locks, pg_stat_xact_sys_tables) and the log's grantees: each served write's arm row reaching each of its delta rows once, the log empty after its judge, after each COMMIT and after a rollback, no predicate lock on it, no catalog row written, no grantee but its owner, the judge's definer"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '\tout.line("BEGIN")\n\tconst statements = out.nested()',
				replacement:
					'\tout.line("BEGIN CREATE TEMPORARY TABLE IF NOT EXISTS __stood (c1 pg_catalog.int4) ON COMMIT PRESERVE ROWS;")\n\tconst statements = out.nested()',
				why: "One stand-up put back: every function of the installation stands a session table up at its session's first call, as each capture stood its deltas up before, so a fresh session's first served write writes catalog rows; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\tarmDeleted(log),\n",
				replacement: "",
				why: "The judge leaves the transaction's arm row, so the log holds it after the judge and after the COMMIT, and a later statement of the transaction arms no judge; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\t\t\t\t\t\t\t\teq(col("r3", "ctid"), col("r2", "c1")),\n',
				replacement: '\t\t\t\t\t\t\t\t\t\teq(col("r3", judgeLogColumns.prev), col("r2", "c1")),\n',
				why: "The claim follows each link the wrong way, from a row to the rows that link to it, so it claims the transaction's newest delta row alone and leaves the rest in the log past its judge and its COMMIT; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.row)]] }',
				replacement:
					'source: { kind: "values", rows: [[thisTransaction, variable(captureNames.head)]] }',
				why: "A capture leaves the arm's head where it read it, so the transaction's arm reaches none of its delta rows and the claim takes none of them; the property fails."
			}
		]
	})
