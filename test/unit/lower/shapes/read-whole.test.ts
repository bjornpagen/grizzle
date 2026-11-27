/**
 * A node every read of which computes it whole is computed once, a MATERIALIZED CTE its reads share (cte-policy
 * readWhole, rule 3c), however many copies of it the read's imports make (cte-policy copyClasses, rule 3d): a closed
 * derivation, whose rows are constants; a node realized behind a DISTINCT, which PostgreSQL never pulls up into a
 * reader; and a node the statement's values fix at one row at most. A closed relation read by several rules, each a
 * match of its own, is one VALUES list, where each copy printed, parsed and planned its own, edullm's decideTest
 * printing a closed relation of 49 KB four times. And a call's rows argument proved empty is the empty array of its row
 * type (lower/conservative/call), no derivation, and a constant row is printed where it stands, never a CTE of its own.
 * Two copies of one sub-query are of one share key whatever an analysis claimed of either (ir/dag-digest.ts unclaimed):
 * the checked DAG claims keys of a query that states an order, never of a closed import of none, which the conservative
 * lowering reads.
 *
 * The box, exhausted: one to three rules each matching TierRank and calling grade at its own `at`, each call's rows
 * argument a copy of its own: the ranks of a closed relation of no row, a constant rank, TierRank's, every tag's, or the
 * tag's at the read's parameter; under the optimized lowering and the conservative oracle's.
 *
 * Oracle: specification: one VALUES list of TierRank for every count of rules, under the optimized lowering and the
 * conservative oracle's alike (cte-policy copyClassesOf, lower/conservative dispatch); one ARRAY argument for each call
 * exactly where its argument holds rows; Tag scanned once exactly where the arguments read it; and the optimized
 * lowering printing a constant argument at each call, where the conservative one shares every node it lowers twice.
 *
 * Features: one rule; several rules; an empty argument; a constant argument; a closed argument; an argument behind a
 * DISTINCT; an argument the read's values fix; the optimized and the conservative lowering.
 */

import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	arrayArguments,
	boxGen,
	constantRanks,
	type Ranked,
	statementsOf,
	tagScans,
	valuesLists
} from "#test/unit/lower/shapes/read-whole.fixtures.ts"

type Feature =
	| "one rule"
	| "several rules"
	| "an empty argument"
	| "a constant argument"
	| "a closed argument"
	| "an argument behind a DISTINCT"
	| "an argument the read's values fix"
	| "optimized"
	| "conservative"

/** Each argument's feature. */
const argument: { readonly [R in Ranked]: Feature } = {
	empty: "an empty argument",
	constant: "a constant argument",
	closed: "a closed argument",
	distinct: "an argument behind a DISTINCT",
	fixed: "an argument the read's values fix"
}

/**
 * A node every read computes whole is printed once however many copies the rules make, and a proved-empty rows argument
 * is the empty array.
 */
export const aNodeEveryReadComputesWholeIsPrintedOnceForEveryCopyAndAnEmptyRowsArgumentIsTheEmptyArray =
	property.exhaust(finite(boxGen), {
		needs: {},
		situations: [
			"one rule",
			"several rules",
			"an empty argument",
			"a constant argument",
			"a closed argument",
			"an argument behind a DISTINCT",
			"an argument the read's values fix",
			"optimized",
			"conservative"
		],
		check: (_, k: Case<Feature>) => (box) =>
			Effect.sync(() => {
				k.note(box.reads === 1 ? "one rule" : "several rules")
				k.note(argument[box.ranked])
				k.note(box.lowering)
				const sql = statementsOf(box, box.lowering)
				assert.equal(
					valuesLists(sql),
					1,
					`${box.reads} rules reading TierRank, their arguments ${box.ranked}: its VALUES lists\n${sql}`
				)
				assert.equal(
					arrayArguments(sql),
					box.ranked === "empty" ? 0 : box.reads,
					`${box.reads} calls of grade, their arguments ${box.ranked}: their ARRAY arguments\n${sql}`
				)
				assert.equal(
					tagScans(sql),
					box.ranked === "distinct" || box.ranked === "fixed" ? 1 : 0,
					`${box.reads} calls of grade, their arguments ${box.ranked}: Tag's scans\n${sql}`
				)
				if (box.lowering === "optimized") {
					assert.equal(
						constantRanks(sql),
						box.ranked === "constant" ? box.reads : 0,
						`${box.reads} calls of grade, their arguments ${box.ranked}: the constant rank printed at each\n${sql}`
					)
				}
			}),
		oracle: {
			kind: "specification",
			name: "TierRank printed as one VALUES list at every count of rules, an ARRAY argument for each call exactly where its argument holds rows, and Tag scanned once exactly where the arguments read it"
		},
		box: "one to three rules matching TierRank and calling grade, its rows argument proved empty, a constant, closed, behind a DISTINCT or fixed by the read's values, each lowering",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t} else if (references > 1 && readWhole(node, realization)) {\n",
				replacement: "\t\t} else if (false) {\n",
				why: "A closed derivation read at several sites inlined at each, as before: its VALUES list printed, parsed and planned once per read."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\tconst key = unwrap(keys.key(node))\n",
				replacement: "\t\tconst key = node.id\n",
				why: "Copies of one closed relation, each a rule's match, decided apart, each read once and inlined: one VALUES list per rule."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t\tconstancy === "closed" ||\n',
				replacement: "\t\t\tfalse ||\n",
				why: "A closed derivation is no node read whole: each rule's copy of TierRank, a scan, inlined at its read, one VALUES list per rule."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\t\trealization(node) === "distinct" ||\n',
				replacement: "\t\t\tfalse ||\n",
				why: "A projection realized behind a DISTINCT is no node read whole: each call's copy of every tag's rank, a scan, inlined at its argument and computed whole at each."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\tfixedByValues(node)) &&\n",
				replacement: "\t\t\tfalse) &&\n",
				why: "A row the read's values fix is no node read whole: each call's copy of the tag at the parameter, a scan, inlined at its argument and probed again at each."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: '\t\tconstancy !== "constant"\n',
				replacement: "\t\ttrue\n",
				why: "A constant row is read whole as a closed derivation is: the constant rank, read by each call, one MATERIALIZED CTE of the statement where each call printed its few bytes and PostgreSQL folded it."
			},
			{
				file: "packages/engine/src/lower/shapes/index.ts",
				original:
					"\t\t\t\treturn cteAtFirstUse(cx, node, state.log, decision.copies, materialized, () =>\n",
				replacement:
					"\t\t\t\treturn cteAtFirstUse(cx, node, state.log, node.id, materialized, () =>\n",
				why: "Each copy of one class defines a CTE of its own, though the policy decided one for all: one VALUES list per copy."
			},
			{
				file: "packages/engine/src/lower/conservative/call/index.ts",
				original: "\t\tif (provedEmpty(a.rows)) {\n",
				replacement: "\t\tif (false) {\n",
				why: "A proved-empty rows argument lowered as an ARRAY over an empty relation, a derivation of no row at each call."
			},
			{
				file: "packages/engine/src/lower/conservative/dispatch.ts",
				original: "\t\t\tall.length > 1 &&\n",
				replacement: "\t\t\tall.length > 9 &&\n",
				why: "The conservative lowering's copies of one closed relation, each lowered once, printed once per rule."
			},
			{
				file: "packages/engine/src/ir/dag-digest.ts",
				original: "\tconst claimed = unclaimed(node)\n",
				replacement: "\tconst claimed = node\n",
				why: "A key reads the claims an analysis made: the checked DAG claims TierRank's key in the read, which states an order, and none in grade's closed argument, an import of no order, so the conservative lowering prints the two copies apart."
			}
		]
	})
