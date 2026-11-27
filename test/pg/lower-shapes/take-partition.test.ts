/**
 * A take ranked within its partition reads its input at the partition's keys alone, and a restriction of any other
 * column stays above it (lower/shapes/take/partition.ts): an attachment's take, correlated at the parent's columns,
 * ranks each parent key's rows apart, so a restriction of those columns commutes with it, σ_{p=k}(take_P(R)) =
 * take_P(σ_{p=k}(R)) for p within its partition P, and the take is read once per parent key with its input at the key
 * (share/keys.ts restrictionWalk, cte-policy keyPrefixBound and attachmentRead `perKey`), its input's every relation
 * sought by a declared-key prefix; the key sets a reader reads a take at reach its input on the partition's columns alone
 * (share/keys.ts KeyAnalysis). Before, metis's results page read each session's latest credit as a take beside its
 * parents, ranked over the credit of every attempt of the database: 2.8 million snapshot values each probed twice,
 * minutes for one sitting.
 *
 * On PostgreSQL 19, a ledger in small (take-partition.fixtures.ts): each child's sittings of its stages, its item
 * sessions at their stages, their attempts, a snapshot score of each and an asserted score of some, a union of the scores
 * in force; a few dozen children and then a few hundred, its tables in each pg_class state (test/support/advice.ts
 * PgClassState), each read run under its carried advice, the latest read's once the plan laws hold over it.
 *
 * Oracle: a bound, the latest read's scans read at most three times the stage's stored rows however many children stand
 * beside it, in any pg_class state; and a second implementation, the leaders' read's rows those a plain SQL query over the
 * stored tables gives.
 *
 * Features: a read beside a few children and beside many; each pg_class state; a leader's total and a child no leader.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type LeaderFeature,
	partitionGen,
	partitionTemplate,
	runLatest,
	runLeaders,
	type StageFeature
} from "#test/pg/lower-shapes/take-partition.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A sitting's sessions, each with its latest attempt's score in force attached as a take of one, read through the
 * sitting, read that stage's rows alone however many children the store holds beside it, in any pg_class state: each
 * session's take reads its input, the union of the scores in force, at the session's key.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTakeRankedPerParentKeyReadsItsInputAtThatKeyAlone = property.explore(partitionGen, {
	needs: { stored: Substrate.rolledBack(partitionTemplate) },
	situations: [
		"beside a few children",
		"beside many children",
		"its tables never vacuumed",
		"its tables counted empty",
		"its tables analyzed",
		"its tables skewed",
		"its tables large"
	] satisfies ReadonlyArray<Reached<StageFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runLatest(value.installed, connection, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "bound: the latest read's scans read at most three times the stage's stored rows, stored relations' and CTE scans' with what their filters removed, beside a few dozen children and beside a few hundred, in any pg_class state"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/share/keys.ts",
			original:
				'\t\t\tcase "Take":\n\t\t\t\tdeliver(\n\t\t\t\t\tat,\n\t\t\t\t\tat.input,\n\t\t\t\t\tequalities.filter((e) => inPartition(at, e.column)),\n\t\t\t\t\ttrue\n\t\t\t\t)\n\t\t\t\treturn\n',
			replacement: '\t\t\tcase "Take":\n\t\t\t\treturn\n',
			why: "A parent key stops at the take: its input, the union of the scores in force, is read whole for every child stored and ranked inside each session's evaluation."
		},
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original:
				"\t\t\treturn keyPrefixLength(\n\t\t\t\tnode.input,\n\t\t\t\tcolumns.filter((c) => inPartition(node, c))\n\t\t\t)\n",
			replacement: "\t\t\treturn 0\n",
			why: "No take is bound by its partition: the attachment reads it beside its parents, its input derived at the sitting's keys and read beside each session, a CTE no index reads, the stage's every attempt once for each session."
		},
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: '\treturn rows.kind === "Take" && !keyed\n',
			replacement: '\treturn rows.kind === "Take"\n',
			why: "Every attachment's take is read beside its parents, as the take policy reads it: its input derived at the sitting's keys and read beside each session, a CTE no index reads, the stage's every attempt once for each session."
		}
	]
})

/**
 * A child's total among the three leaders, read at the child, is the one the leaders ranked over every child give: the
 * parameter equates a column of the take's rows outside its partition (it has none), which stays above the take.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aRestrictionOutsideATakesPartitionStaysAboveTheTake = property.explore(partitionGen, {
	needs: { stored: Substrate.rolledBack(partitionTemplate) },
	situations: ["a leader's total", "a child no leader"] satisfies ReadonlyArray<
		Reached<LeaderFeature>
	>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, value } = yield* stored
				yield* runLeaders(value.installed, connection, drawn, c)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the leaders' totals by a plain SQL query over the stored tables: each attempt's score in force, each child's total, the three greatest, the asked child's among them"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/take/partition.ts",
			original: "\ttake.correlation.some((c) => c.column === column)\n",
			replacement: "\ttrue\n",
			why: "Every column passes through a take: the child's key set reaches the leaders' input, which ranks the asked child's total alone, child 1 a leader of one."
		}
	]
})
