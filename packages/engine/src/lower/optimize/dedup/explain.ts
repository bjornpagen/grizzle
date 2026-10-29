import {
	explanation,
	type MultiplicityReason,
	reasonEffect
} from "#compiler/analysis/certificates/reasons.ts"
import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { type ObservationWhy, observationPaths } from "#compiler/analysis/physical/consumers.ts"
import type { JustifiedKey } from "#compiler/analysis/physical/fds.ts"
import { plainLosses, type Realization } from "#compiler/analysis/physical/props.ts"
import type { Diagnostic } from "#compiler/core/diag.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import type { FoldForm } from "#compiler/lower/optimize/dedup/certify.ts"
import type {
	FoldInput,
	NodeDecision,
	NodeStatus,
	Placement
} from "#compiler/lower/optimize/dedup/plan.ts"
import { edgeFold } from "#compiler/lower/optimize/dedup/policy.ts"

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

/** An observing step that is a fold deduplicating its contributions on B. */
const nodeReasons = (
	a: PhysicalAnalysis,
	node: RelNode,
	decided: Decided,
	form: FoldForm
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
			const reasons = observationPaths(node, a.edges).flatMap(
				(path): ReadonlyArray<MultiplicityReason> => {
					const last = path[path.length - 1]
					if (last === undefined || last.sensitivity === "preserves") {
						return []
					}
					if (last.sensitivity === "ignores") {
						return [ignoringReason(last.why)]
					}
					const consumer = last.consumer.kind === "node" ? last.consumer.node : undefined
					return consumer?.kind === "Group" &&
						consumer.aggs.length > 0 &&
						form(consumer) === "distinct"
						? ["exactDeduplication"]
						: []
				}
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
 * Why a fold with aggregates takes its input as `input` does: a fold deduplicating an input whose obligation its keys
 * discharge does so to compute a bound column it reads nowhere else, which can fail (place.ts); one deduplicating an
 * outstanding obligation, because its input may repeat; one folding plainly, because its contribution identity is
 * removable or its obligation is discharged.
 */
export const foldReasons = (
	a: PhysicalAnalysis,
	group: NodeOf<"Group">,
	input: FoldInput
): ReadonlyArray<MultiplicityReason> => {
	const identity = a.of(group).contribution?.identity
	const owed = a.obligations.find((o) => edgeFold(o.edge) === group)
	const discharged = owed?.discharged === true ? owed : undefined
	return input === "distinct"
		? discharged !== undefined
			? ["unreadBoundCanFail"]
			: lossReasons(a, group.input)
		: identity?.kind === "removable"
			? evidence(identity.removal.reasons)
			: evidence(discharged === undefined ? [] : discharged.proof.reasons)
}

/**
 * The decisions and reasons of a plan, from the analysis of its realization.
 *
 * Why each duplicate elimination is present or absent.
 *
 * "Diagnostics explain why deduplication is present or absent ... These are explanations, not tuning controls." Every
 * node gets one decision and every fold one more, each rendered as a Multiplicity diagnostic in the reason vocabulary
 * of certificates/reasons.ts:
 *
 * - elided: the reasons the plain form's key rests on (a retained primary key, combined join keys, a grouped output
 *   key, a fixed key component, ...);
 * - placed: why the plain form may repeat (a projected key loss, a noninjective expression, overlapping arms, unknown
 *   evidence), where a consumer observes it;
 * - kept: the set form the policy keeps (the recursive closure, a set operator, set UNION over arms not proved
 *   disjoint);
 * - ignored: why repeats cannot change the result (an existential observation, the recursive closure, an exact
 *   deduplication above), read from the node's bounded observation paths.
 */
export const explainPlan = (
	a: PhysicalAnalysis,
	form: FoldForm,
	placements: ReadonlyArray<Placement>
): PlanExplanation => {
	const placed = new Set<NodeId>(placements.map((p) => p.node))
	const decisions: Array<NodeDecision> = []
	const diagnostics: Array<Diagnostic> = []
	for (const node of a.order) {
		const r = a.of(node).realization
		const decided = statusOf(a, node, r, placed)
		const reasons = nodeReasons(a, node, decided, form)
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
		if (node.kind !== "Group" || node.aggs.length === 0) {
			continue
		}
		const input = form(node)
		diagnostics.push(
			explanation({
				node: node.id,
				kind: "contribution",
				status: input === "distinct" ? "required" : "elided",
				reasons: foldReasons(a, node, input),
				heading: node.bound,
				loc: node.loc
			})
		)
	}
	return { decisions, diagnostics }
}
