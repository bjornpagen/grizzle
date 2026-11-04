import { type ConsumerEdge, consumerIn } from "#compiler/analysis/physical/consumers.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { deliveredInput, type NodeOf, type RelKind, type RelNode } from "#compiler/ir/rel.ts"

/** The kinds whose realization the policy fixes to their exact set form. */
const pinnedDistinctKinds: ReadonlyArray<RelKind> = ["Recursive", "Intersect", "Difference"]

/**
 * The fixed placement policy: which set forms are kept whatever the evidence,
 * where a union starts, which edges a fold discharges itself, and where a node's duplicate elimination can sit.
 *
 * - Recursive closure keeps its recursive UNION: it removes repeated complete states within and across iterations, and
 *   no evidence about seed, step, edges, acyclicity or depth replaces it. The compiler
 *   applies no UNION ALL elision to recursive feedback.
 * - INTERSECT and EXCEPT keep their set forms; an ALL form needs an explicit
 *   multiplicity proof and performance evidence.
 * - A union starts as set UNION, which absorbs its arms' repeats, so redundant per-arm DISTINCT is omitted.
 *   It becomes UNION ALL only when each arm is unique and the final coerced headings are pairwise
 *   disjoint by a retained literal discriminant (R17.unionAll); distinct source identities projected away
 *   never qualify.
 * - A Group with aggregates owes its contributions on the complete bound tuple B, so its observing edge is discharged
 *   by its own contribution DISTINCT on B, never by a DISTINCT on a narrower or a wider tuple.
 * - An attachment delivers its parent's rows, a law's Forbid its violation query's and an ordered result its input's,
 *   ordered (the conservative lowering lowers each as that input): none is a fragment of its own that a
 *   DISTINCT could close, so a duplicate elimination owed on one sits on the node whose rows it delivers, and none is
 *   ever realized `distinct`.
 */
export const isPinnedDistinct = (node: RelNode): boolean => pinnedDistinctKinds.includes(node.kind)

/**
 * Where placement starts: the pinned set forms and set UNION realized `distinct`, every other node plainly, so the
 * physical analysis shows exactly where a consumer observes repeats.
 */
export const initialRealization = (node: RelNode): Realization =>
	isPinnedDistinct(node) || node.kind === "Union" ? "distinct" : "plain"

/**
 * The kinds whose conservative lowering closes their fragment with an exact duplicate elimination: a
 * plain realization of one of them proved unique is a DISTINCT elision and carries an R17.elide certificate. A Group
 * is unique by its grouping key and gets no DISTINCT after the fold; its contribution DISTINCT is the fold's own
 * (R17.contribution). Attach and Forbid deliver another node's rows, and an ordered result orders its input's.
 */
export const elisionKinds: ReadonlyArray<RelKind> = [
	"Base",
	"Closed",
	"InputSet",
	"Delta",
	"MatchRegion",
	"Filter",
	"ProjectSet",
	"SemiJoin",
	"AntiJoin",
	"Union",
	"Take",
	"Produce",
	"SelfRef",
	"ApproximateNearest",
	"Window",
	"OrderedSetAggregate"
]

/** The Group with aggregates that consumes this edge as its input, if one does: the fold discharges it on B itself. */
export const edgeFold = (edge: ConsumerEdge): NodeOf<"Group"> | undefined => {
	const consumer = consumerIn(edge.consumer, "input")
	return consumer?.kind === "Group" && consumer.aggs.length > 0 ? consumer : undefined
}

/**
 * The node that carries a duplicate elimination owed on `node`: `node` itself, or, through every node that delivers
 * another node's rows unchanged (rel.ts deliveredInput: an attachment, a law query, an ordered result), the node whose
 * rows it delivers. A delivering node has no fragment of its own, since its lowering lowers that node, so no emission
 * can carry a DISTINCT realized on one: placement never realizes one `distinct`, and the test kernel's verification
 * (test/support/oracle/verify) fails a plan that does. Each node holds the one it delivers, built before it, so the
 * walk ends.
 */
export const placementTarget = (node: RelNode): RelNode => {
	let at = node
	for (let next = deliveredInput(at); next !== undefined; next = deliveredInput(at)) {
		at = next
	}
	return at
}
