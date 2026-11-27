/**
 * A set the statement holds drives its region's chain (lower/shapes/region heldChain): a region that reads the call's
 * own rows, a relation input, a share its statement holds or a set the statement's values restrict (cte-policy heldSet,
 * restrictedByValues), reads each stored relation those rows bind on a declared-key prefix per row of them, a fenced
 * LATERAL seek at their values, never joined to them by PostgreSQL's estimates, which may hash the relation whole beside
 * a set no index reads; a source computed apart (a fold) is read at its key set, each key once, free beside them. Before,
 * such a region was one
 * flat FROM list whenever no value fixed where it is evaluated bound it: edullm's car carried 2,972 such joined scans,
 * metis's 5,124, qti-pie's ledger 1,536 (lane UNITKEY's census, reason joined), 65% to 80% a stored relation beside the
 * call's carried rows, the rest beside a statement CTE.
 *
 * On PostgreSQL 19, a ledger's learner rows under the learner's unit (held-drives.fixtures.ts): sessions, attempts,
 * snapshots, feedback. Each write reads learner 1's two stages from its relation input: the snapshots of their attempts
 * in one rule, or two inserts reading one share of the attempts, one beside the snapshots, the other beside the
 * feedback; or the call's seats, two at each stage, beside a
 * region of each session's count of its item's attempts read at the stages they name; or a call's array of two items
 * beside learner 1's sessions of a stage at its parameters; or the call's sittings beside a definition of each session
 * with both of its attempts' variables, one join read twice, navigated from the sittings' columns (navigate.ts
 * navigatedRule `inputs`); and in the array form learner 1's history
 * growing with the store (edullm's answerTestItem `next` rules), the array leading by its rank (cte-policy Rank `held`,
 * the call's own rows above a unit's). Four learners, then two thousand, are stored, under counted statistics, statistics stating each value its
 * own or every row one value (pg_restore_attribute_stats), or the sessions and attempts the call's rows read stated a
 * million rows a page (pg_restore_relation_stats; the planner scales a stated density by the pages a table holds), the
 * adversary under which a flat join hashes the snapshots whole beside
 * the call's attempts and a fenced step still seeks them per attempt. No planner setting is changed. Each case installs
 * the schema twice, once a scale.
 *
 * Oracle: store invariance, the rows the write reads of each learner relation (each its sequential scans' rows and its
 * indexes' entries returned, pg_stat_get_xact_tuples_returned, so an index-only read counts as a read) beside two thousand
 * learners are at most those beside four, under any statistics; and a region holding a fold is evaluated once at each
 * stage the call's seats name, at its key set, its attempts read once a stage. Specification: the write commits and its target holds learner 1's rows.
 *
 * Features: each form of the call's rows; each statistics.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { type HeldFeature, heldGen, runHeld } from "#test/pg/lower-shapes/held-drives.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * A write reading the call's rows reads the same rows of every learner relation however many learners stand beside
 * them, under any statistics: each relation the rows bind on a key is read per row at their values.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aHeldSetsRowsDriveEveryStoredReadTheyBindOnAKey = property.explore(heldGen, {
	needs: { substrate: Substrate.fresh(baseSubstrate) },
	situations: [
		"the relation input",
		"a share two inserts read",
		"a fold's region read at the call's keys",
		"the call's array beside a unit's rows",
		"a definition the call's rows bind",
		"under counted statistics",
		"under statistics stating each value its own",
		"under statistics stating every row one value",
		"under statistics stating the call's rows large"
	] satisfies ReadonlyArray<Reached<HeldFeature>>,
	check:
		({ substrate }, k) =>
		(drawn) =>
			Effect.provideServiceEffect(
				runHeld(drawn, k),
				Substrate,
				Effect.map(substrate, (taken) => taken.substrate)
			),
	oracle: {
		kind: "universal",
		name: "store invariance: the rows a write reads of each learner relation beside two thousand learners are at most those beside four, under any statistics; a fold's region evaluated once a key"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original:
				'export const heldSet = (node: RelNode): boolean =>\n\tnode.kind === "Closed" || node.kind === "SelfRef" || restrictedByValues(node)\n',
			replacement:
				'export const heldSet = (node: RelNode): boolean =>\n\tnode.kind === "Closed" || node.kind === "SelfRef" || node.kind === "InputSet" || node.kind === "Delta" || node.kind === "Context"\n',
			why: "Only the four kinds are held, as before: a share the statement holds of the call's rows drives nothing, its region is one flat join, and beside the share PostgreSQL estimates as large each relation it binds is hashed whole, its rows growing with the learners."
		},
		{
			file: "packages/engine/src/lower/shapes/region/index.ts",
			original: '\t\tif (p.read !== "fenced") {\n',
			replacement: "\t\tif (true) {\n",
			why: "No step is fenced: the chain prints the flat join, and a relation the call's rows bind is joined to them by PostgreSQL's estimates, read whole beside them where it hashes."
		},
		{
			file: "packages/engine/src/lower/shapes/region/index.ts",
			original: "const computedApart = (node: RelNode): boolean => {\n\tswitch (node.kind) {\n",
			replacement:
				'const computedApart = (node: RelNode): boolean => {\n\tif (node.kind !== "Base") {\n\t\treturn false\n\t}\n\tswitch (node.kind) {\n',
			why: "A region holding a fold is fenced like a stored relation, evaluated again at each seat's values: two seats of one stage each read the stage's attempts, twice the attempts of the stages the call names."
		},
		{
			file: "packages/engine/src/analysis/theory/navigate.ts",
			original: "\t\t\tchainedApart(source, interned) ? bound : passes ? inputs : noVariables,\n",
			replacement: "\t\t\tchainedApart(source, interned) ? bound : noVariables,\n",
			why: "A definition the call's rows bind is navigated blind to their columns, as before: it leads with every learner's snapshots of the first variable and reads the sessions last, its snapshots read growing with the learners."
		},
		{
			file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
			original: "\t\tif (passedIn(source)) {\n",
			replacement: "\t\tif (false) {\n",
			why: "A set the call passes in ranks below a unit's rows, as before: the learner's every session at the stage leads the chain and the call's array filters it, the sessions read growing with the learner's history."
		}
	]
})
