/**
 * A judged COMMIT leaves the session's tables empty, each delta it wrote within one page and with its file where it was
 * within that page before, and truncates no table it did not read (physical/ddl/rules.ts addRules): a rule over a
 * query's deltas and its sentinel are ON COMMIT PRESERVE ROWS, and the judge empties each delta it reads once its part
 * has read them (`emptied`), by DELETE while the delta holds its one reused page and by TRUNCATE once it holds more
 * (sql/print.ts sessionTableEmptied), its statements reading every delta through its reader, so their plans outlive a
 * truncation. Where it deleted their rows always, every page of every run stayed in the heap, which no VACUUM of a
 * session's table records as free, so a session's deltas grew by each write (a table refilled with 100k rows a
 * transaction: 13 MB to 108 MB over 8 uses); where it truncated them always, each COMMIT gave each a new file, whose
 * invalidations every backend of the database walked every plan it holds for; where they were ON COMMIT DELETE ROWS,
 * PostgreSQL truncated every one the session held at each COMMIT of a transaction that touched a temporary relation
 * (tablecmds.c PreCommit_on_commit_actions), each an ACCESS EXCLUSIVE lock, a rebuild of each index and TOAST table and
 * invalidations every backend reads, so a learner session holding 18 deltas spent most of each COMMIT truncating them
 * (edullm GRADING-SQL D: COMMIT 79.6% of active session time, heap_truncate 54.6% of backend CPU).
 *
 * Over each unit shape's whole judge and its probed twin of rule-whole.fixtures.ts, a session writes two documents
 * whole and drops one, one transaction each, then writes one again and rolls it back: before each COMMIT the
 * transaction holds no predicate lock on the session's tables; after each COMMIT every table of the session holds no
 * row, each delta the transaction wrote keeps its file where it held its one page at most before and holds that page at
 * most, and the sentinel, whose one row the judge deletes as it starts, keeps its page; after the rollback every table
 * holds no row and keeps its file.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { commitsGen, runCommits } from "#test/pg/laws/rule-commit.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { standUpJudge } from "#test/support/judge.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A judged COMMIT leaves every session table it wrote empty, each delta of them within its page and its file, and its
 * sentinel's page.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aJudgedCommitLeavesEverySessionTableItWroteEmptyEachDeltaOfThemWithinItsPageAndItsFileAndItsSentinelsPage =
	property.explore(commitsGen, {
		needs: Substrate.oneOf(judgeTemplates, Substrate.fresh),
		situations: ["a whole judge's deltas", "a probed judge's deltas"],
		check: (judges, c) => (k) =>
			Effect.gen(function* () {
				const judge = yield* judges[`${k.judge} ${k.shape}`]
				const session = yield* judge.substrate.session({ ...ownerSession(), label: "writer" })
				yield* standUpJudge(session, judge.value.installation)
				yield* runCommits(judge.value, session, k, c)
			}).pipe(Effect.scoped),
		oracle: {
			kind: "postgresql",
			name: "each session table's rows, file and bytes on disk after each COMMIT and after a rollback, against the tables the transaction wrote a row into and their bytes before it: none holds a row, each delta it wrote within its page keeps its file and one past it has a new one, each within its page after, its sentinel keeps its page, and the transaction held no predicate lock on any of them"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: ") ON COMMIT PRESERVE ROWS`",
				replacement: ") ON COMMIT DELETE ROWS`",
				why: "The session's deltas and sentinel are ON COMMIT DELETE ROWS, as before, so every COMMIT that touched them truncates each one the session holds, the sentinel among them, which holds no page after it."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "PlStatement => sessionTableEmptied(delta.name)",
				replacement: 'PlStatement => ({ kind: "truncateSessionTable", name: delta.name })',
				why: "Each part truncates every delta it read, as it did before its emptying kept a delta's file within its page: each delta the transaction wrote has a new file after the COMMIT, and every backend of the database walks every plan it holds for the invalidations."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\t\t\t\t},\n\t\t\t\trevokeOf(named, [])\n\t\t\t]",
				replacement: "\t\t\t\t}\n\t\t\t]",
				why: "A delta's reader keeps PUBLIC's EXECUTE, PostgreSQL's default for a new function, so any role of the session may run the judge's definer's reader over the run's rows."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t})),\n\t\t\t...part.deltas.map(emptiedWhereWritten)\n",
				replacement: "\t\t\t}))\n",
				why: "No part deletes the rows it read, so a delta keeps one transaction's rows past its COMMIT, and the next transaction's judge reads them again as its own."
			}
		]
	})
