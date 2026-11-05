import {
	explanation,
	type MultiplicityReason,
	reasonEffect
} from "#compiler/analysis/certificates/reasons.ts"
import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { type ObservationWhy, observationEnds } from "#compiler/analysis/physical/consumers.ts"
import type { JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { plainLosses, type Realization } from "#compiler/analysis/physical/props.ts"
import type { Diagnostic } from "#compiler/core/diag.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { RelNode } from "#compiler/ir/rel.ts"
import type { NodeDecision, NodeStatus, Placement } from "#compiler/lower/optimize/dedup/plan.ts"

const unique = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(items)]

const evidence = (
	reasons: ReadonlyArray<MultiplicityReason>
): ReadonlyArray<MultiplicityReason> => {
	const absent = unique(reasons.filter((r) => reasonEffect[r] === "absent"))
	return absent.length > 0 ? absent : ["atMostOneRow"]
}

const ignoringReason = (why: ObservationWhy): MultiplicityReason =>
	why === "existence is an emptiness test" ||
	why === "a law's violation query is tested for emptiness"
		? "existentialObservation"
		: why === "recursive UNION removes repeated states"
			? "globalRecursiveClosure"
			: "exactDeduplication"

const lossReasons = (a: PhysicalAnalysis, node: RelNode): ReadonlyArray<MultiplicityReason> => {
	const reasons = unique(plainLosses(a.of(node).props).map((l) => l.reason))
	return reasons.length > 0 ? reasons : ["unknownEvidence"]
}

/** A node's status, with the key an elided node's plain form is proved unique by. */
type Decided =
	| { readonly status: "elided"; readonly key: JustifiedKey }
	| { readonly status: Exclude<NodeStatus, "elided"> }

const statusOf = (
	a: PhysicalAnalysis,
	node: RelNode,
	realization: Realization,
	placed: ReadonlySet<NodeId>
): Decided => {
	if (realization === "distinct") {
		return { status: placed.has(node.id) ? "placed" : "kept" }
	}
	const uniqueness = a.of(node).props.uniqueness
	return uniqueness.kind === "plain"
		? { status: "elided", key: uniqueness.key }
		: { status: "ignored" }
}

const nodeReasons = (
	a: PhysicalAnalysis,
	node: RelNode,
	decided: Decided
): ReadonlyArray<MultiplicityReason> => {
	switch (decided.status) {
		case "elided":
			return evidence(decided.key.just.reasons)
		case "placed":
			return lossReasons(a, node)
		case "kept":
			return node.kind === "Recursive"
				? ["globalRecursiveClosure"]
				: node.kind === "Union"
					? lossReasons(a, node)
					: ["exactDeduplication"]
		case "ignored": {
			const reasons = observationEnds(node, a.edges).flatMap(
				(last): ReadonlyArray<MultiplicityReason> =>
					last.sensitivity === "ignores" ? [ignoringReason(last.why)] : []
			)
			return reasons.length > 0 ? unique(reasons) : ["unknownEvidence"]
		}
	}
}

const explanationStatus = (status: NodeStatus): "elided" | "required" | "ignored" =>
	status === "elided" ? "elided" : status === "ignored" ? "ignored" : "required"

interface PlanExplanation {
	readonly decisions: ReadonlyArray<NodeDecision>
	readonly diagnostics: ReadonlyArray<Diagnostic>
}

/**
 * The decisions and reasons of a plan, from the analysis of its realization.
 *
 * Why each duplicate elimination is present or absent.
 *
 * "Diagnostics explain why deduplication is present or absent ... These are explanations, not tuning controls." Every
 * node gets one decision, rendered as a Multiplicity diagnostic in the reason vocabulary of certificates/reasons.ts; a
 * fold has none of its own, since it reads its input as placement realizes it, one row per bound tuple:
 *
 * - elided: the reasons the plain form's key rests on (a retained primary key, combined join keys, a grouped output
 *   key, a fixed key component, ...);
 * - placed: why the plain form may repeat (a projected key loss, a noninjective expression, overlapping arms, unknown
 *   evidence), where a consumer observes it;
 * - kept: the set form the policy keeps (the recursive closure, a set operator, set UNION over arms not proved
 *   disjoint);
 * - ignored: why repeats cannot change the result (an existential observation, the recursive closure, an exact
 *   deduplication above), read from the ends of the node's observation paths (consumers.ts observationEnds).
 */
export const explainPlan = (
	a: PhysicalAnalysis,
	placements: ReadonlyArray<Placement>
): PlanExplanation => {
	const placed = new Set<NodeId>(placements.map((p) => p.node))
	const decisions: Array<NodeDecision> = []
	const diagnostics: Array<Diagnostic> = []
	for (const node of a.order) {
		const r = a.of(node).realization
		const decided = statusOf(a, node, r, placed)
		const reasons = nodeReasons(a, node, decided)
		const status = decided.status
		decisions.push({ node: node.id, realization: r, status, reasons })
		diagnostics.push(
			explanation({
				node: node.id,
				kind: node.kind,
				status: explanationStatus(status),
				reasons,
				heading: node.heading.map((c) => c.name),
				loc: node.loc
			})
		)
	}
	return { decisions, diagnostics }
}
