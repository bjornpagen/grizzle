import type { MultiplicityReason } from "#compiler/analysis/certificates/reasons.ts"
import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import type { Consumer } from "#compiler/analysis/physical/consumers.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import type { Diagnostic } from "#compiler/core/diag.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { KeySet } from "#compiler/ir/rel.ts"

/** Whether a fold deduplicates its complete bound tuple before folding. */
export type FoldInput = "plain" | "distinct"

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
 * One fold's decision: its complete bound tuple B, why, and how it takes its input: plainly, the input already holding
 * one row per B, or deduplicated on B by its own contribution DISTINCT over `deduplicates`, the input of the observing
 * edge it discharges.
 *
 * The product of duplicate-elimination placement.
 *
 * A plan says, for every node of the rewritten DAG, how its semantic set boundary is realized, and, for every fold,
 * whether its contributions are deduplicated before folding:
 *
 * - `realization`: `plain` (an ordinary SELECT, UNION ALL for a union) or `distinct` (an exact duplicate-eliminating
 *   operator over the node's complete heading: SELECT DISTINCT, set UNION, INTERSECT, EXCEPT, recursive UNION). Every
 *   node of the DAG is named; the emission reads it, and the test kernel's verification re-derives what it claims.
 * - `folds`: for every Group with aggregates, its whole decision in one record: `distinct` when the fold deduplicates its
 *   complete bound tuple B before folding (the conservative lowering's SELECT DISTINCT <B>), with the node whose rows it
 *   deduplicates, and `plain` when the input already has one row per B, each with B and its reasons.
 *
 * It also keeps what explains and certifies the decision: each node placement, with the consumer whose observation it
 * discharges; each node's decision with its reasons (certificates/reasons.ts); the certificates of the multiplicity
 * rewrites it performs; and the physical analysis of the final realization, which the test kernel's verification
 * (test/support/oracle/verify/multiplicity.ts) recomputes rather than trusts.
 */
export type FoldPlan = {
	readonly bound: KeySet
	readonly reasons: ReadonlyArray<MultiplicityReason>
} & ({ readonly input: "plain" } | { readonly input: "distinct"; readonly deduplicates: NodeId })

/**
 * How one node's set boundary is decided:
 * - elided: realized plainly because a physical key proves the plain form unique;
 * - placed: realized `distinct` because a consumer observes its repeats and nothing proves them away;
 * - kept: realized `distinct` by the fixed policy (recursive UNION, the INTERSECT and EXCEPT set forms, set UNION for
 *   arms not proved unique and pairwise disjoint);
 * - ignored: realized plainly although it may repeat, because every consumer its repeats reach absorbs or ignores them.
 */
export type NodeStatus = "elided" | "placed" | "kept" | "ignored"

export interface NodeDecision {
	readonly node: NodeId
	readonly realization: Realization
	readonly status: NodeStatus
	readonly reasons: ReadonlyArray<MultiplicityReason>
}

export interface DedupPlan {
	/** The execution context the plan's evidence holds in; a plan is never reused in another. */
	readonly context: TemplateContext
	readonly realization: Readonly<Record<NodeId, Realization>>
	/** One per Group with aggregates. */
	readonly folds: Readonly<Record<NodeId, FoldPlan>>
	/** In the order they were placed: topological within each worklist round. */
	readonly placements: ReadonlyArray<Placement>
	/** One per node, in topological order. */
	readonly decisions: ReadonlyArray<NodeDecision>
	readonly certificates: ReadonlyArray<Certificate<MultiplicityRule>>
	readonly diagnostics: ReadonlyArray<Diagnostic>
	readonly analysis: PhysicalAnalysis
	/** How many analyses the bounded worklist ran. */
	readonly rounds: number
}
