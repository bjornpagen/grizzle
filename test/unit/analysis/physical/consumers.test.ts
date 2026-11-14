import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The observed nodes (analysis/physical/consumers.ts observedNodes), against every observation path of each node
 * enumerated by brute force: each path climbs preserving edges from the node and ends at the first edge that observes
 * or ignores, or at a preserving edge into a node no consumer reads. A node is observed exactly when one of those ends
 * observes.
 *
 * Property: over the differential oracle's generated queries, analyzed unplaced, every node is observed exactly when
 * one of its observation paths ends at an edge that observes. Oracle: the paths enumerated by brute force, a second
 * implementation. Plants (~/.cache/grizzle-release/BR03/plants): observed-preserving-unclimbed (a node is observed only
 * by an edge into it that observes, never through a preserving edge). Features: an end that observes, an end that
 * ignores.
 */ import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { unplaced } from "#compiler/analysis/physical/analyze.ts"
import { type ConsumerEdge, observedNodes } from "#compiler/analysis/physical/consumers.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import { assert } from "#test/support/assert.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { caseHang } from "#test/support/limits.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { physical } from "#test/unit/analysis/physical/support.ts"

/** The last steps of every observation path from `node`, by brute force over the paths. */
const pathEnds = (
	node: RelNode,
	edges: ReadonlyArray<ConsumerEdge>
): ReadonlyArray<ConsumerEdge> => {
	const into = (at: RelNode) => Arr.filter(edges, (e) => e.input === at)
	const ends: Array<ConsumerEdge> = []
	const walk = (at: RelNode): void => {
		const out = into(at)
		for (const e of out) {
			if (e.sensitivity !== "preserves") {
				ends.push(e)
			} else if (into(e.consumer.node).length === 0) {
				ends.push(e)
			} else {
				walk(e.consumer.node)
			}
		}
	}
	walk(node)
	return ends
}

type EndsFeature = "an end that observes" | "an end that ignores"

describe("the observed nodes", () => {
	it.effect("are those an observation path's last step observes", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "every observation path of each node enumerated by brute force"
					},
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
							const ends = pathEnds(node, analysis.edges)
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
