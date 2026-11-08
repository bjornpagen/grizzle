import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import type { Consumer } from "#compiler/analysis/physical/consumers.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/** A node realized `distinct` to discharge an observing consumer's need. */
export interface Placement {
	/** The node realized `distinct`. */
	readonly node: NodeId
	/**
	 * The input of the observing edge the placement discharges. It differs from `node` only for a placement moved
	 * below a node that delivers its input's rows unchanged (an attachment's parent, a law's violation query, an
	 * ordered result's input).
	 */
	readonly input: NodeId
	/** The consumer that observes repeats. */
	readonly consumer: Consumer
	/** The heading the consumer needs distinct: the input's whole heading. */
	readonly heading: KeySet
}

/**
 * The product of duplicate-elimination placement.
 *
 * A plan says, for every node of the rewritten DAG, how its semantic set boundary is realized: `plain` (an ordinary
 * SELECT, UNION ALL for a union) or `distinct` (an exact duplicate-eliminating operator over the node's complete
 * heading: SELECT DISTINCT, set UNION, INTERSECT, EXCEPT, recursive UNION). Every node of the DAG is named; the emission
 * reads it, and the test kernel's verification re-derives what it claims. A fold has no decision of its own: it reads
 * its input as realized, whose bound tuple is a key of it (ir/rel.ts FoldInput), and an observing consumer's need for
 * its input distinct is discharged like any other.
 *
 * It also keeps what certifies the decision: each node placement, with the consumer whose observation it discharges;
 * the certificates of the multiplicity rewrites it performs; and the physical analysis of the final realization, which
 * the test kernel's verification (test/support/oracle/verify/multiplicity.ts) recomputes rather than trusts.
 */
export interface DedupPlan {
	/** The execution context the plan's evidence holds in; a plan is never reused in another. */
	readonly context: TemplateContext
	readonly realization: Readonly<Record<NodeId, Realization>>
	/** In the order they were placed: topological within each worklist round. */
	readonly placements: ReadonlyArray<Placement>
	readonly certificates: ReadonlyArray<Certificate<MultiplicityRule>>
	readonly analysis: PhysicalAnalysis
}
