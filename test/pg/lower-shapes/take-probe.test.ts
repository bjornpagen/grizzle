/**
 * A take(k) has one form, the probe (lower/shapes/take takeShape): each parent's evaluation reads its input ORDER BY
 * the take's completed order LIMIT k, an index on the correlation columns then that order serving it by one descent and
 * k entries, so n parents read n × (h + k + 1) pages of an index of height h at most (each descent's h pages, at most
 * one leaf more for its k entries, k heap pages for its rows), whatever the relation's size. The form over
 * every group at once (DISTINCT ON, row_number) and the parent count that chose it are gone: choosing it needs the
 * relation's size, a number no compile knows.
 *
 * On PostgreSQL 19, parents each with a few children more than k, a few read beside a few hundred no read reaches.
 *
 * Oracle: a bound, the read's scans of the children read at most n × (h + k + 1) pages, n the parents read, h the
 * probed index's height (pageinspect bt_metap), k the take.
 *
 * Features: the take as an attachment's child and bound to a relation parameter's facts (`bind`); k = 1 and k = 3; one
 * parent and several.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import {
	type ProbeFeature,
	probeGen,
	runTakeProbe,
	takeProbeTemplate
} from "#test/pg/lower-shapes/take-probe.fixtures.ts"
import { pgClassStates } from "#test/support/advice.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A take read per parent reads at most n × (h + k + 1) pages: one descent of the index on its correlation columns and
 * its order for each parent, and its k entries and rows.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aTakeReadsEachParentByOneDescentAndItsKRows = property.explore(probeGen, {
	needs: { stored: Substrate.rolledBack(takeProbeTemplate) },
	situations: [
		"an attachment's child",
		"bound to a relation parameter's facts",
		"k = 1",
		"k = 3",
		"one parent",
		"several parents",
		...Arr.map(pgClassStates, (s) => `with every table ${s}` as const)
	] satisfies ReadonlyArray<Reached<ProbeFeature>>,
	check:
		({ stored }, c) =>
		(drawn) =>
			Effect.gen(function* () {
				const { connection, cluster, database, value } = yield* stored
				yield* runTakeProbe(value.installed, { connection, cluster, database }, drawn, c)
			}),
	oracle: {
		kind: "universal",
		name: "bound: the read's scans of the children read at most n × (h + k + 1) pages, n the parents read, h the probed index's height, k the take, beside a few hundred parents no read reaches"
	},
	kept: [],
	kills: [
		{
			file: "packages/engine/src/lower/shapes/take/index.ts",
			original: '\t\t\tlimit: orderedLimit("take seek", orderBy, cx.boundExpr(node.bound))\n',
			replacement: "\t\t\tlimit: undefined\n",
			why: "The take reads its every input row: each parent's probe reads all of its children, at least k + 2, each on a heap page of its own, past n × (h + k + 1)."
		}
	]
})
