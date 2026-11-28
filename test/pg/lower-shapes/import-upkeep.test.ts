/**
 * A stored relation's upkeep reads every derivation its definition imports at the units the write wrote (lower/shapes/
 * share/keys.ts KeyAnalysis, magic sets): the closed import a rule reads beside its region is computed at the region's
 * keys, never whole; and its removal reads its stored rows at those units alone, a fenced seek of the table's unit key
 * for each unit, each stale row deleted at its tid by a DELETE of its own (physical/ddl/rules.ts upkeepBlock
 * `removal`), where a join of the units to the table by PostgreSQL's
 * estimates, each delta's reader a function it prices at a thousand rows, read the table whole at every write.
 * pantry's ForwardBranchRule's upkeep read its targets, a closed import of the nodes of one kind, by a sequential scan of
 * every package's nodes at each publish: 69 pages at 0 packages beside the published one, 399 at 20, 1,405 at 80
 * (UNITKEY's measurement on the QTI copy). The bound, from first principles: a founding write's upkeep
 * re-derives its package's rows, each rule element and the targets under it read by a seek of the package's key, O(n
 * log N) for the package's n nodes, however many packages the store holds.
 *
 * On PostgreSQL 19 (import-upkeep.fixtures.ts): a few packages or a few hundred, written and judged, the tables stood in
 * each pg_class state (test/support/advice.ts PgClassState), then one founded, and Forward's upkeep explained over its
 * deltas under the advice it carries.
 *
 * Oracle: the bound, each statement of the upkeep reads at most four times the founded package's nodes, in every
 * pg_class state, under no planner setting.
 *
 * Features: a founding beside a few packages and beside hundreds.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type ImportUpkeepFeature,
	importUpkeepGen,
	importUpkeepTemplate,
	runImportUpkeep
} from "#test/pg/lower-shapes/import-upkeep.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A founding write's upkeep of a stored relation that imports a selection of the package's nodes reads the founded
 * package's nodes alone, the import among them, however many packages stand beside it.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const anUpkeepReadsAClosedImportAtTheUnitsItsWriteWrote = property.explore(importUpkeepGen, {
	needs: { stored: Substrate.rolledBack(importUpkeepTemplate) },
	situations: ["beside a few packages", "beside hundreds of packages"] satisfies ReadonlyArray<
		Reached<ImportUpkeepFeature>
	>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, bare, value } = yield* stored
				yield* runImportUpkeep(value, connection, bare, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "the bound: each statement of the upkeep reads at most four times the founded package's nodes, beside a few packages and a few hundred, under no planner setting"
	},
	kept: [
		{
			token: ReplayToken(
				"test/pg/lower-shapes/import-upkeep.test.ts#anUpkeepReadsAClosedImportAtTheUnitsItsWriteWrote:3.0:0.0.0.0"
			),
			reason:
				"A founding write beside 1,370 packages: the upkeep's DELETE of Forward's stale rows at their tuple ids, r1.ctid = ANY (ARRAY(...)), PostgreSQL planned as a Seq Scan of Forward's table filtered by the array, whose length it guesses, all 1,370 rows read against the bound of 12 (the founded package's 3 nodes) (SEALED-P4 at c112ddb3)",
			since: "2026-11-27"
		}
	],
	kills: [
		{
			file: "packages/engine/src/physical/ddl/rules.ts",
			original:
				'\t\t\tdeclare: [{ name: staleName, type: types.tid }],\n\t\t\tbody: [\n\t\t\t\t{\n\t\t\t\t\tkind: "forQuery",\n\t\t\t\t\tvariable: staleName,\n\t\t\t\t\tquery: setQueryOf(headed(tids, reads), "the stale ids\' query headed"),\n\t\t\t\t\tbody: [\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tkind: "modify",\n\t\t\t\t\t\t\tstatement: {\n\t\t\t\t\t\t\t\tkind: "delete",\n\t\t\t\t\t\t\t\twith: undefined,\n\t\t\t\t\t\t\t\ttable,\n\t\t\t\t\t\t\t\talias: "r1",\n\t\t\t\t\t\t\t\tusing: [],\n\t\t\t\t\t\t\t\twhere: eq(col("r1", "ctid"), { kind: "plVar", name: staleName }),\n\t\t\t\t\t\t\t\treturning: []\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t}\n\t\t\t\t\t]\n\t\t\t\t}\n\t\t\t]\n',
			replacement:
				'\t\t\tdeclare: [],\n\t\t\tbody: [\n\t\t\t\t{\n\t\t\t\t\tkind: "modify",\n\t\t\t\t\tstatement: {\n\t\t\t\t\t\tkind: "delete",\n\t\t\t\t\t\twith: undefined,\n\t\t\t\t\t\ttable,\n\t\t\t\t\t\talias: "r1",\n\t\t\t\t\t\tusing: [],\n\t\t\t\t\t\twhere: {\n\t\t\t\t\t\t\tkind: "equalsAny",\n\t\t\t\t\t\t\texpr: col("r1", "ctid"),\n\t\t\t\t\t\t\tarray: { kind: "array", query: setQueryOf(headed(tids, reads), "the stale ids\' query headed") },\n\t\t\t\t\t\t\tschema: undefined\n\t\t\t\t\t\t},\n\t\t\t\t\t\treturning: []\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t]\n',
			why: "The removal as one DELETE of every stale row, r1.ctid = ANY (ARRAY(<the ids>)): PostgreSQL guesses the InitPlan array's length and plans a Seq Scan of Forward's table filtered by it, every package's row read at a founding write, past four times the founded package's nodes."
		},
		{
			file: "packages/engine/src/physical/ddl/rules.ts",
			original: "\t\t\t\tand(\n\t\t\t\t\tmapNonEmpty(u.stored.fields, (field, j) =>\n",
			replacement:
				"\t\t\t\tundefined && and(\n\t\t\t\t\tmapNonEmpty(u.stored.fields, (field, j) =>\n",
			why: "The upkeep's DELETE reads its stored rows apart from the units the write wrote: every package's rows of Forward's table read at each founding write, past four times the founded package's nodes."
		}
	]
})
