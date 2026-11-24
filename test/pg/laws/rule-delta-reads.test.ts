/**
 * The rule judge reads of a session's delta, at each read, the rows the reading statement's selection admits, through
 * the reader of that selection, and never the whole delta (physical/ddl/deltas.ts headed, DeltaReads): a statement's
 * conjuncts over a delta read's own columns and constants move into the read's reader, which reads them through a
 * B-tree of the delta (deltaIndexes), so the rows a COMMIT's judge reads of a delta grow with the rows each rule
 * constrains, never with the rules times the delta. edullm's giant pattern package's COMMIT read Node's delta whole for
 * each of 92 statements that kept one kind's nodes, 23.3 million rows, 23.3 s, and Attribute's for each of 134 that
 * kept one name's, 31.6 million rows (s18 at 39989d602).
 *
 * On PostgreSQL 19, over T, a document's rows each of a kind, and three rules, each a check over T's rows of one kind
 * (rule-delta-reads.fixtures.ts Selection): each case writes up to 24 rows of each of the three judged kinds and of
 * two kinds no rule reads, and maybe one breaking row, in one transaction, and runs the judge.
 *
 * Oracle: PostgreSQL's statement statistics (pg_stat_statements, track all, in the case's database alone), each
 * reader's one SELECT of the delta counted with the rows it returned, and the transaction's table statistics of the
 * delta (pg_stat_xact_all_tables), its tuples an index fetched: the readers return every judged kind's rows, each call
 * at most the rows of the judged kind written most, each through the delta's B-tree; a breaking row is refused exactly
 * where a rule reads its kind.
 *
 * Features: rows of a kind no rule reads in the delta, two judged kinds holding rows, a judged kind holding no row, a
 * breaking row of a judged kind refused and one of a kind no rule reads committed.
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
 * Each read of a delta returns the rows its statement's selection admits, through the delta's B-tree, never the whole
 * delta.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const eachReadOfADeltaReturnsTheRowsItsSelectionAdmitsThroughTheDeltasIndexNeverTheWholeDelta =
	property.explore(writesGen, {
		needs: { selection: Substrate.fresh(selectionTemplate) },
		situations: [
			"rows of a kind no rule reads in the delta",
			"two judged kinds holding rows",
			"a judged kind holding no row",
			"a breaking row of a judged kind refused",
			"a breaking row of a kind no rule reads committed"
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
			name: "the case database's statement statistics, each reader's SELECT of the delta with its calls and rows, and the transaction's tuples of the delta an index fetched: every judged kind's rows returned, at most the most-written judged kind's at each call, each through the delta's B-tree; a breaking row refused exactly where a rule reads its kind"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\t\t\t\t\tconst over = overDelta(conjunct, read.column)",
				replacement: "\t\t\t\t\tconst over = undefined",
				why: "No selection moves into a reader: every statement reads T's delta whole through its one reader and keeps its kind's rows itself, so each call returns every row the transaction wrote, the kinds no rule reads among them, as each of the giant package's 92 statements over Node did; the property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/deltas.ts",
				original: "\t\t\treturn best === undefined || (held.get(best) ?? 0) < 2 ? [] : [best]",
				replacement: "\t\t\treturn []",
				why: "No delta is stood up with a B-tree: each reader of a kind passes over every row of T's delta to find its kind's, a pass of the whole delta at each read, which the delta's index fetches no tuple of; the property fails."
			}
		]
	})
