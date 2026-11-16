/** What the properties of consumers.test.ts read: its spaces, models and helpers. */

import { Array as Arr } from "effect"
import { type ConsumerEdge } from "#compiler/analysis/physical/consumers.ts"
import type { RelNode } from "#compiler/ir/rel.ts"

/** The last steps of every observation path from `node`, by brute force over the paths. */
export const pathEnds = (
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

export type EndsFeature = "an end that observes" | "an end that ignores"
