/**
 * A rewrite pass's decisions read the physical properties of the cells they weigh, each computed when first read
 * (lower/optimize/demand/frame.ts physicalAnalyses, through the pass's PropsUnder), where each state of the edited DAG
 * that a decision read computed the physical analysis of its whole DAG (analysis/physical analysisOver: every node's
 * edges classified and every observed input's and root's properties computed, its observed nodes and its obligations),
 * the spine above every edit among them, which no decision read. On qti's write compile at hub 7a0902e41 (edullm
 * qti-database, its readback lowering) those analyses took 64.5 s of 961 s. The work is counted, never timed
 * (test/support/kernel/calls.ts): the calls of physicalPropsOf (analysis/physical/rules.ts).
 *
 * Oracle: a bound read off the query: the existence pass weighs which of a region's existence-only occurrences to move
 * by their sources' properties alone (existence/index.ts unkeyedFirst), so the properties it computes do not grow with
 * the height of the projections above the region.
 *
 * Features: a spine of one projection and of eight.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import { existencePass } from "#compiler/lower/optimize/existence/index.ts"
import { succeeded } from "#test/support/assert.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { Posting, Q } from "#test/support/unit/lower/conservative/fixtures.ts"
import {
	ledgerCatalog,
	passContext,
	queryOf,
	runPasses
} from "#test/support/unit/lower/rewrite/support.ts"

type Situation = "a spine of one projection" | "a spine of eight projections"

/** The heights of the box. */
const heights = [1, 2, 3, 4, 5, 6, 7, 8] as const

/**
 * A region of three occurrences of Posting, each its account bound to one shared variable and nothing else, so each is
 * an existence test the pass may move, under a spine of `height` projections of the shared variable.
 */
const spineOf = (height: number) => {
	const q = new Q()
	const region = q.region(
		Array.from({ length: 3 }, () => ({
			source: q.base(Posting, conservativeMeta),
			bind: { account: "a" },
			constants: {}
		}))
	)
	let top = q.project(region, [["a", "a"]], conservativeMeta)
	for (let at = 1; at < height; at++) {
		top = q.project(top, [["a", "a"]], conservativeMeta)
	}
	return queryOf(q.build(top).dag, [])
}

/** The calls of physicalPropsOf the existence pass makes over the spine of `height`. */
const propsWork = (height: number) =>
	Effect.map(
		callCounts(
			Effect.sync(() =>
				succeeded(
					runPasses(
						spineOf(height),
						[existencePass],
						passContext({ catalog: ledgerCatalog, evidence: "snapshot" })
					)
				)
			),
			{ props: { file: "packages/engine/src/analysis/physical/rules.ts", name: "physicalPropsOf" } }
		),
		([ran, counts]) => ({ ran, props: counts.props })
	)

/** A rewrite pass computes the physical properties of the cells its decisions weigh, however tall the DAG above them. */
export const aRewritePassComputesThePhysicalPropertiesOfTheCellsItsDecisionsWeighHoweverTallTheDagAboveThem =
	property.exhaust(
		finite((s) => s.draw(element(heights))),
		{
			needs: {},
			situations: [
				"a spine of one projection",
				"a spine of eight projections"
			] satisfies ReadonlyArray<Reached<Situation>>,
			check: (_, c: Case<Situation>) => (height) =>
				Effect.gen(function* () {
					const one = yield* propsWork(1)
					const done = yield* propsWork(height)
					assert.ok(
						Arr.some(one.ran.certificates, (x) => x.rule === "R02.semiJoin"),
						"the pass moves an existence test, weighing its candidates' sources"
					)
					assert.ok(one.props > 0, "the pass weighs its candidates by their sources' properties")
					assert.equal(
						done.props,
						one.props,
						`the pass computes as many properties under a spine of ${height} as under a spine of one`
					)
					if (height === 1) {
						c.note("a spine of one projection")
					}
					if (height === 8) {
						c.note("a spine of eight projections")
					}
				}),
			oracle: {
				kind: "universal",
				name: "a bound: the calls of physicalPropsOf under a spine of h projections are those under a spine of one"
			},
			box: "a region of three existence-only occurrences of Posting under every spine of one to eight projections",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/optimize/demand/frame.ts",
					original: "\tphysical: { props: (cell) => props.of(finished.dag.node(cell)) }\n",
					replacement:
						"\tphysical: ((roots) => ({ props: (cell) => props.of(finished.dag.node(cell)) }))(finished.dag.dag.roots.map((root) => props.of(root)))\n",
					why: "Each state a decision reads computes the properties of its whole DAG, as each computed its whole analysis at 7a0902e41: the spine above the region is computed at every state, the properties grow with its height, and the property fails."
				}
			]
		}
	)
