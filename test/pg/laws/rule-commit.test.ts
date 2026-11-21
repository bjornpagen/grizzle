/**
 * A judged COMMIT leaves the session's tables empty, the deltas it wrote holding no page, and truncates no table it did
 * not read (physical/ddl/rules.ts addRules): a rule over a query's deltas and its sentinel are ON COMMIT PRESERVE ROWS,
 * and the judge truncates each delta it reads once its part has read them (`emptied`), its statements reading every
 * delta through its reader, so their plans outlive the truncation. Where it deleted their rows, every page of every run
 * stayed in the heap, which no VACUUM of a session's table records as free, so a session's deltas grew by each write
 * (a table refilled with 100k rows a transaction: 13 MB to 108 MB over 8 uses); where they were ON COMMIT DELETE ROWS,
 * PostgreSQL truncated every one the session held at each COMMIT of a transaction that touched a temporary relation
 * (tablecmds.c PreCommit_on_commit_actions), each an ACCESS EXCLUSIVE lock, a rebuild of each index and TOAST table and
 * invalidations every backend reads, so a learner session holding 18 deltas spent most of each COMMIT truncating them
 * (edullm GRADING-SQL D: COMMIT 79.6% of active session time, heap_truncate 54.6% of backend CPU).
 *
 * Over each unit shape's whole judge and its probed twin of rule-whole.fixtures.ts, a session writes two documents
 * whole and drops one, one transaction each: after each COMMIT every table of the session holds no row, each delta the
 * transaction wrote holds no page, and the sentinel, whose one row the judge deletes as it starts, keeps its page.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { commitsGen, runCommits } from "#test/pg/laws/rule-commit.fixtures.ts"
import { judgeTemplates } from "#test/pg/laws/rule-whole.fixtures.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A judged COMMIT leaves every session table it wrote empty, each delta of them holding no page, and its sentinel's page.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aJudgedCommitLeavesTheSessionsTablesEmptyItsDeltasPagelessAndItsSentinelUntruncated =
	property.explore(commitsGen, {
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
			name: "each session table's rows and bytes on disk after each COMMIT, against the tables the transaction wrote a row into before it: none holds a row, each delta it wrote holds no page, and its sentinel keeps its page"
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
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: '\t\t\tbody: [{ kind: "truncateSessionTable", name: delta.name }]',
				replacement:
					'\t\t\tbody: [{ kind: "modify", statement: { kind: "delete", with: undefined, table: sessionTable(delta.name), alias: "r1", using: [], where: undefined, returning: [] } }]',
				why: "Each part empties its deltas by DELETE, as e8de84026 did, which keeps every page of the run, so a delta the transaction wrote holds its pages after the COMMIT, and a session's deltas grow by each write."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t\t\t},\n\t\t\t\t\trevokeOf(named, [])\n\t\t\t\t]",
				replacement: "\t\t\t\t\t}\n\t\t\t\t]",
				why: "A delta's reader keeps PUBLIC's EXECUTE, PostgreSQL's default for a new function, so any role of the session may run the judge's definer's reader over the run's rows."
			},
			{
				file: "packages/engine/src/physical/ddl/rules.ts",
				original: "\t\t\t})),\n\t\t\t...part.deltas.map(emptied)\n",
				replacement: "\t\t\t}))\n",
				why: "No part deletes the rows it read, so a delta keeps one transaction's rows past its COMMIT, and the next transaction's judge reads them again as its own."
			}
		]
	})
