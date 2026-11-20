/**
 * A judged COMMIT truncates none of the session's tables (physical/ddl/rules.ts addRules): a rule over a query's deltas
 * and its sentinel are ON COMMIT PRESERVE ROWS, and the judge deletes every row of each delta it reads once its part has
 * read them, where they were ON COMMIT DELETE ROWS, which PostgreSQL truncates, every one the session holds, at each
 * COMMIT of a transaction that touched a temporary relation (tablecmds.c PreCommit_on_commit_actions): an ACCESS
 * EXCLUSIVE lock, a rebuild of each index and TOAST table and invalidations every backend reads, per table, so a learner
 * session holding 18 deltas spent most of each COMMIT truncating them (edullm GRADING-SQL D: COMMIT 79.6% of active
 * session time, heap_truncate 54.6% of backend CPU).
 *
 * Over each unit shape's whole judge and its probed twin of rule-whole.fixtures.ts, a session writes two documents
 * whole and drops one, one transaction each: after each COMMIT every table of the session holds no row, and each table
 * the transaction wrote a row into keeps the pages it was written into, which a truncation gives back.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { commitsGen, runCommits } from "#test/pg/laws/rule-commit.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A judged COMMIT leaves every session table it wrote empty and truncates none of them, however many the session holds.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aJudgedCommitLeavesTheSessionsTablesEmptyAndTruncatesNoneOfThem = property.explore(
	commitsGen,
	{
		needs: Substrate.oneOf(judgeTemplates, Substrate.freshOf),
		situations: ["a whole judge's deltas", "a probed judge's deltas"],
		check: (judges, c) => (k) =>
			Effect.gen(function* () {
				const judge = yield* judges[`${k.judge} ${k.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "writer" })
				yield* runCommits(judge.value, session, k, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each session table's rows and bytes on disk after each COMMIT, against the tables the transaction wrote a row into before it: none holds a row, and none it wrote holds no page"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: ") ON COMMIT PRESERVE ROWS`",
				replacement: ") ON COMMIT DELETE ROWS`",
				why: "The session's deltas and sentinel are ON COMMIT DELETE ROWS, as before, so every COMMIT that touched them truncates each one the session holds, the ones it wrote among them, and they hold no page after it."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t})),\n\t\t\t...part.deltas.map(emptied)\n",
				replacement: "\t\t\t}))\n",
				why: "No part deletes the rows it read, so a delta keeps one transaction's rows past its COMMIT, and the next transaction's judge reads them again as its own."
			}
		]
	}
)
