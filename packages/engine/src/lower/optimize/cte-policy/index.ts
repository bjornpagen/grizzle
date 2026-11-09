import { analyzeDemand, noPins } from "#compiler/analysis/demand/demand.ts"
import { catchRefusal, Refusal } from "#compiler/core/canonical.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import {
	type CertificateRule,
	localCertificate,
	makeCertificate
} from "#compiler/ir/certificate.ts"
import { nodeScopes } from "#compiler/ir/dag.ts"
import type { Pass } from "#compiler/ir/pass.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { RelKind, RelNode, ValidDag } from "#compiler/ir/rel.ts"
import {
	feedbackReadsOf,
	nodeGraph,
	readsOutside,
	subtreeOf
} from "#compiler/lower/optimize/demand/editor.ts"

export type CteStrategy = "inline" | "notMaterialized" | "materialized" | "recursive"

type CostClass = "scan" | "join" | "expensive"

type CteReason =
	| "singleUse"
	| "recursive"
	| "correlated"
	| "feedback"
	| "cheapScan"
	| "sharedExpensive"
	| "sharedJoin"

interface CteDecision {
	readonly node: NodeId
	readonly strategy: CteStrategy
	readonly references: number
	readonly cost: CostClass
	readonly reason: CteReason
	/** The node's demanded columns: what a CTE for it must carry. */
	readonly columns: ReadonlyArray<string>
}

export interface CtePlan {
	/** One decision per shared node; every other node is inlined. */
	readonly decisions: Readonly<Record<NodeId, CteDecision>>
}

/** The plan of a statement whose stages no policy shared: every node is inlined. */
export const emptyCtePlan: CtePlan = { decisions: {} }

interface CtePlannedQuery extends LogicalQuery {
	readonly cte: CtePlan
}

const expensiveKinds: ReadonlyArray<RelKind> = [
	"Group",
	"Window",
	"OrderedSetAggregate",
	"Recursive",
	"Intersect",
	"Difference",
	"Union",
	"Take",
	"Produce",
	"ApproximateNearest"
]

/**
 * The cost class of a node's subtree: expensive when any stage folds, sorts, bounds, recurses or compares sets; a join
 * when it matches several sources or tests existence; otherwise a scan of one source.
 */
export const costClass = (root: RelNode): CostClass => {
	let join = false
	for (const node of subtreeOf(nodeGraph, root)) {
		if (expensiveKinds.includes(node.kind)) {
			return "expensive"
		}
		if (
			(node.kind === "MatchRegion" && node.occurrences.length > 1) ||
			node.kind === "SemiJoin" ||
			node.kind === "AntiJoin"
		) {
			join = true
		}
	}
	return join ? "join" : "scan"
}

/** A shared node and the policy's decision for it. */
interface Decided {
	readonly node: RelNode
	readonly decision: CteDecision
}

/**
 * The policy's decision for every shared node of a DAG, a node read more than once, in topological order: an expensive
 * one is materialized.
 */
const ctePlan = (dag: ValidDag): ReadonlyArray<Decided> => {
	const d = analyzeDemand(dag, noPins)
	const scopes = nodeScopes(dag)
	const feedback = feedbackReadsOf(nodeGraph, d.order)
	const decided: Array<Decided> = []
	for (const node of d.order) {
		const references = d.references(node)
		if (references < 2) {
			continue
		}
		const cost = costClass(node)
		const demanded = d.demanded(node)
		const decide = (strategy: CteStrategy, reason: CteReason): CteDecision => ({
			node: node.id,
			strategy,
			references,
			cost,
			reason,
			columns: node.heading.flatMap((c) => (demanded.has(c.name) ? [c.name] : []))
		})
		let decision: CteDecision
		if (node.kind === "Recursive") {
			decision = decide("recursive", "recursive")
		} else if (feedback.has(node)) {
			decision = decide("inline", "feedback")
		} else if (
			readsOutside(nodeGraph, subtreeOf(nodeGraph, node)) ||
			scopes.of(node).freeVars.length > 0 ||
			d.lateral(node)
		) {
			decision = decide("inline", "correlated")
		} else if (cost === "scan") {
			decision = decide("inline", "cheapScan")
		} else if (cost === "expensive") {
			decision = decide("materialized", "sharedExpensive")
		} else {
			decision = decide("notMaterialized", "sharedJoin")
		}
		decided.push({ node, decision })
	}
	return decided
}

const cteRule = (strategy: Exclude<CteStrategy, "inline">): CertificateRule => `cte.${strategy}`

/**
 * The policy as a pass: the query unchanged, with its plan, and a certificate for each shared stage the statement
 * computes as a CTE. The decision rests on no evidence (queryLocal); it is a placement, not a rewrite of meaning.
 *
 * The CTE policy: which shared stages a statement computes once.
 *
 * "A CTE is a relational program boundary, not inherently an optimization." The rewrites leave a DAG in which a node
 * read by several consumers is a sharing boundary; the emitter must spell each such node as a derived table at every
 * use (inline), a CTE PostgreSQL may fold into each use (NOT MATERIALIZED), or a CTE it computes once (MATERIALIZED).
 * The choice is the compiler's, never an application hint, and is made here from the graph alone: reference count,
 * complete parameter bindings, correlation, demanded fields and cost class. It runs no trial query and reads no
 * statistics. A node is shared when it is read more than once.
 *
 * The rules, in order:
 *
 * 1. A node read once, or never shared, is inlined: an eligible single-use stage folds.
 * 2. A recursive relation is a WITH RECURSIVE: always a CTE, computed once per statement.
 * 3. A correlated node, a node some expression reads laterally, and a node on a recursive step are inlined: a CTE
 *    cannot read an outer row, and a recursive term admits one self-reference.
 * 4. A node whose stages are all scans, filters and projections of one source is inlined at each use: each use can then
 *    probe the source's indexes with its own restrictions, which a shared result would hide ("sharing an unfiltered
 *    computation is not automatically preferable to two selective indexed probes").
 * 5. A node that folds, sorts, bounds, deduplicates a set operation or recurses is expensive. Shared, it is
 *    MATERIALIZED: one evaluation feeds every use.
 * 6. Any other shared node, a join of several sources, is NOT MATERIALIZED: PostgreSQL may optimize each use jointly
 *    with its consumer, and the boundary stays a program boundary rather than a forced fence.
 *
 * NOT MATERIALIZED never erases a DISTINCT, aggregate or other semantic boundary, and MATERIALIZED blocks parent
 * restrictions from entering the stage: the restrictions every use shares were already moved below it by
 * predicate movement. Distinct imports with different parameter bindings are different nodes, so they are never shared.
 * CTE rows belong to one execution and are never a result cache.
 */
export const ctePolicyPass: Pass<LogicalQuery, CtePlannedQuery> = {
	name: "ctePolicy",
	measure: "single-traversal",
	run: (query, ctx) =>
		catchRefusal(() => {
			const decided = ctePlan(query.dag)
			const decisions: Record<NodeId, CteDecision> = {}
			for (const { node, decision } of decided) {
				decisions[node.id] = decision
			}
			for (const { node, decision } of decided) {
				if (decision.strategy === "inline") {
					continue
				}
				const cert = makeCertificate(
					localCertificate(
						cteRule(decision.strategy),
						[decision.node],
						[decision.node],
						[decision.node],
						node.heading.map((c) => c.name)
					)
				)
				if (!cert.ok) {
					throw new Refusal(cert.error)
				}
				ctx.certificates.record(cert.value)
			}
			return { ...query, cte: { decisions } }
		})
}
