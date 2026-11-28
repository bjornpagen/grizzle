/**
 * A COMMIT's judge makes the selections a delta's reads take in one pass over the delta's rows for each column they fix,
 * however many rules select its rows, and each read reads the rows its selection admits, never the whole delta
 * (physical/ddl/deltas.ts selectionsMade, headed): a statement's conjuncts over a delta read's own columns and constants
 * move into the read's selection, an array its part makes once for every statement that reads it, the selections that
 * fix one column to two values or more made by one pass grouped by that column. So the rows a COMMIT's judge reads of a
 * delta grow with the rows each rule constrains and with the columns the rules fix, never with the rules times the
 * delta. edullm's giant pattern package's COMMIT read Node's delta whole for each of 92 statements that kept one kind's
 * nodes, 23.3 million rows, 23.3 s, and Attribute's for each of 134 that kept one name's, 31.6 million rows (s18 at
 * 39989d602). A stored relation's upkeep reads its deltas so too: each statement of it reads, of each delta, the rows its
 * conditions select, where edullm's upkeeps read Node's news whole, 7.1 s of their own time at a COMMIT (STORED-CONTENT,
 * g9mb).
 *
 * On PostgreSQL 19, over T, a document's rows each of a kind, three stored relations each of T's rows of one kind with a
 * check over it, and Kept, U's rows of one kind, stored at the document's unit (rule-delta-reads.fixtures.ts Selection):
 * each case writes up to 24 rows of each of the three judged kinds and of two kinds no rule reads, the same lawful rows
 * into U, and maybe one breaking row, in one transaction, and runs the judge.
 *
 * Oracle: PostgreSQL's statement statistics (pg_stat_statements, track all, in the case's database alone), each
 * statement that reads T's delta's own variable counted with its calls: three passes over it at most, the judge's
 * netting, its borrow of the units the write wrote and its part's one pass grouped by kind; and each stored relation's
 * rows: Kind1, Kind2 and Kind3 each a row of each of T's rows of its
 * kind, Kept one of each of U's rows of the kept kind; a breaking row is refused exactly where a rule reads its kind.
 *
 * Features: rows of a kind no rule reads in the delta, two judged kinds holding rows, a judged kind holding no row, a
 * breaking row of a judged kind refused and one of a kind no rule reads committed; an upkeep whose selection holds rows
 * beside rows it does not select, and one whose selection holds no written row.
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type DeltaReadsFeature,
	runWrites,
	selectionTemplate,
	writesGen
} from "#test/pg/laws/rule-delta-reads.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A COMMIT's judge passes over a delta once for the column its selections fix, and each selection holds the rows it
 * admits, never the whole delta.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aCommitsJudgePassesOverADeltaOnceForTheColumnItsSelectionsFixAndEachSelectionHoldsTheRowsItAdmits =
	property.explore(writesGen, {
		needs: { selection: Substrate.fresh(selectionTemplate) },
		situations: [
			"rows of a kind no rule reads in the delta",
			"two judged kinds holding rows",
			"a judged kind holding no row",
			"a breaking row of a judged kind refused",
			"a breaking row of a kind no rule reads committed",
			"an upkeep whose selection holds rows beside rows it does not select",
			"an upkeep whose selection holds no written row"
		] satisfies ReadonlyArray<DeltaReadsFeature>,
		check:
			({ selection }, c) =>
			(drawn) =>
				Effect.gen(function* () {
					const installed = yield* selection
					yield* runWrites(installed, drawn, c)
				}),
		oracle: {
			kind: "postgresql",
			name: "the case database's statement statistics, each statement reading T's delta's own variable with its calls and rows: three passes at most, the netting, the borrow and one grouped by kind; and each stored relation's rows, Kind1 to Kind3 each T's rows of its kind, Kept U's rows of the kept kind; a breaking row refused exactly where a rule reads its kind"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original:
					"\tconst grouped = [...families.values()].filter((members) => valuesOf(members).size >= 2)",
				replacement:
					"\tconst grouped = [...families.values()].filter((members) => valuesOf(members).size >= 99)",
				why: "Each selection is a pass of its own over T's delta, each of the three rules' reading every row the write put, as each of the giant package's 92 statements over Node did: five passes over the delta; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\t\t\tif (into.size === 0) {\n\t\t\t\treturn core\n\t\t\t}\n",
				replacement: "",
				why: "A pass-through projection over a delta is read from the whole delta's array before the core over it, which holds the selection's conjunct, meets it, so no conjunct moves into a selection: each of the three upkeeps reads every row of T's delta and keeps its kind's itself; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original:
					'\t\t\t\t\t\tisIn(col("r1", column), [first0.values[0], ...ws.map((w) => w.values[0])])\n',
				replacement: "\t\t\t\t\t\tundefined\n",
				why: "The grouped pass groups every row, so a row of a kind no rule reads makes a group no WHEN of the CASE lists, and its CASE_NOT_FOUND refuses a lawful write; the property fails."
			}
		]
	})
