import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { unplaced } from "#compiler/analysis/physical/analyze.ts"
import {
	type ConsumerEdge,
	observationEnds,
	observedNodes
} from "#compiler/analysis/physical/consumers.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { assert } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { caseHang } from "#test/support/limits.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { physical } from "#test/unit/analysis/physical/support.ts"

/**
 * The observation ends of a node (analysis/physical/consumers.ts observationEnds), against every observation path of the
 * node enumerated by brute force: each path climbs preserving edges from the node and ends at the first edge that
 * observes or ignores, or at a preserving edge into a node no consumer reads. The ends are exactly the last steps of
 * those paths, however many paths share one, and a node is observed exactly when one of its ends observes.
 */

/** A step as a set member: its consumer, how it treats the input's repeats, and why. */
const stepKey = (e: Pick<ConsumerEdge, "consumer" | "sensitivity" | "why">): string =>
	e.consumer.kind === "result"
		? `result ${e.sensitivity} ${e.why}`
		: `${e.consumer.node.id} ${e.consumer.role} ${e.sensitivity} ${e.why}`

/** The last steps of every observation path from `node`, by brute force over the paths. */
const pathEnds = (node: RelNode, edges: ReadonlyArray<ConsumerEdge>): ReadonlySet<string> => {
	const into = (at: RelNode) => Arr.filter(edges, (e) => e.input === at)
	const ends = new Set<string>()
	const walk = (at: RelNode): void => {
		const out = into(at)
		for (const e of out) {
			if (e.sensitivity !== "preserves") {
				ends.add(stepKey(e))
			} else if (into(e.consumer.node).length === 0) {
				ends.add(stepKey(e))
			} else {
				walk(e.consumer.node)
			}
		}
	}
	walk(node)
	return ends
}

type EndsFeature = "an end that observes" | "an end that ignores"

describe("the observation ends of a node", () => {
	it.effect("are the last steps of its observation paths", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "unit/analysis/physical/observation-ends",
					draw: drawn(queryCaseGen(defaultGenConfig)),
					literal: Formatter.format,
					coverage: required<EndsFeature>(["an end that observes", "an end that ignores"], {
						cases: 200,
						sense: notesOnly
					}),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(q, c) =>
					Effect.sync(() => {
						const analysis = physical(q.query.dag, {
							context: "snapshot",
							catalog: genCatalog(q.schema),
							realization: unplaced,
							roots: "result"
						})
						const observed = observedNodes(analysis.order, analysis.edges)
						for (const node of analysis.order) {
							const ends = observationEnds(node, analysis.edges)
							const keys = Arr.map(ends, stepKey)
							assert.deepEqual<ReadonlySet<string>>(
								new Set(keys),
								pathEnds(node, analysis.edges),
								`the ends of ${node.id}`
							)
							assert.equal(
								observed.has(node),
								Arr.some(ends, (e) => e.sensitivity === "observes"),
								`whether ${node.id} is observed`
							)
							for (const e of ends) {
								c.note(
									e.sensitivity === "observes" ? "an end that observes" : "an end that ignores"
								)
							}
						}
					})
			)
		)
	)
})
