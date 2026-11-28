import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { unplaced } from "#compiler/analysis/physical/analyze.ts"
import { observedNodes } from "#compiler/analysis/physical/consumers.ts"
import { genCatalog } from "#test/support/evidence.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"
import { physical } from "#test/support/unit/analysis/physical/support.ts"
import { type EndsFeature, pathEnds } from "#test/unit/analysis/physical/consumers.fixtures.ts"

/**
 * The observed nodes are those an observation path's last step observes.
 *
 * Budget: 200 runs and 200 steered cases, what its suite stated before it became a property
 * (test/unit/analysis/physical/consumers.test.ts:53 at 8cad5bce, its runs and its coverage's cases).
 */
export const theObservedNodesAreThoseAnObservationPathsLastStepObserves = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: {},
		budget: { runs: 200, steered: 200 },
		situations: ["an end that observes", "an end that ignores"] satisfies ReadonlyArray<
			Reached<EndsFeature>
		>,
		check: (_, c: Case<EndsFeature>) => (q) =>
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
						c.note(e.sensitivity === "observes" ? "an end that observes" : "an end that ignores")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "every observation path of each node enumerated by brute force"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/analysis/physical/consumers.ts",
				original:
					'\t\t\t(into.get(node) ?? []).some(\n\t\t\t\t(e) =>\n\t\t\t\t\te.sensitivity === "observes" ||\n\t\t\t\t\t(e.sensitivity === "preserves" && observed.has(e.consumer.node))\n\t\t\t)',
				replacement: '\t\t\t(into.get(node) ?? []).some((e) => e.sensitivity === "observes")',
				why: "A node is observed only by an edge into it that observes, never through a preserving edge (analysis/physical/consumers.ts observedNodes); the property fails."
			}
		]
	}
)
