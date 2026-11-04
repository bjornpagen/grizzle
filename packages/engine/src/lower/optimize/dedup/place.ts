import { placementCertificate } from "#compiler/analysis/certificates/builder.ts"

import {
	analyzePhysical,
	type Outstanding,
	type PhysicalAnalysis,
	type RootObservation
} from "#compiler/analysis/physical/analyze.ts"
import { consumerIn } from "#compiler/analysis/physical/consumers.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { inputsOf, type NodeOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { certifyPlan, type FoldForm } from "#compiler/lower/optimize/dedup/certify.ts"
import { explainPlan, foldReasons } from "#compiler/lower/optimize/dedup/explain.ts"
import type { DedupPlan, FoldPlan, Placement } from "#compiler/lower/optimize/dedup/plan.ts"
import {
	edgeFold,
	initialRealization,
	isPinnedDistinct,
	placementTarget
} from "#compiler/lower/optimize/dedup/policy.ts"

interface PlacementEnv {
	/** The execution context the evidence must hold in. */
	readonly context: TemplateContext
	/** The installed constraints behind declared keys and containments, named as ownership installs them. */
	readonly catalog: EvidenceCatalog
	/** How the program consumes its roots. */
	readonly roots: RootObservation
}

const defect = (where: string, capability: string): CompileError =>
	malformedDescription(SourceLoc("dedup placement", [where]), capability)

/** The analysis of a realization, each node's decision by its label, under the placement's environment. */
const analyzeRealization = (
	dag: RelDag,
	realization: ReadonlyMap<NodeId, Realization>,
	env: PlacementEnv
): PhysicalAnalysis =>
	analyzePhysical(dag, {
		context: env.context,
		realization: (id) => realization.get(id),
		catalog: env.catalog,
		roots: env.roots
	})

/** The nodes some outstanding target lies strictly below: one pass in topological order over data inputs. */
const belowTargets = (
	order: ReadonlyArray<RelNode>,
	targets: ReadonlySet<RelNode>
): ReadonlySet<RelNode> => {
	const reaches = new Set<RelNode>()
	const below = new Set<RelNode>()
	for (const node of order) {
		if (inputsOf(node).some((i) => reaches.has(i))) {
			below.add(node)
		}
		if (targets.has(node) || below.has(node)) {
			reaches.add(node)
		}
	}
	return below
}

/**
 * Duplicate-elimination placement.
 *
 * "Choose duplicate-elimination placement before the first semantic consumer that requires it." Placement starts from
 * the policy's realization (policy.ts): every node plain except the pinned set forms and set UNION. The physical
 * analysis then lists each observing edge as an obligation, discharged when the input's physical keys prove the
 * heading the consumer needs distinct. An outstanding obligation is discharged by realizing its input `distinct`: that
 * input is exactly the last node before the first consumer that observes repeats, because every node in between
 * passes repeats on (a filter, a projection, a join, an attachment) and so leaves the obligation further up. When that
 * input only delivers another node's rows (an attachment, a law query, an ordered result), the DISTINCT sits on the
 * node whose rows it delivers, the last one with a fragment of its own (policy.ts placementTarget).
 *
 * The worklist is bounded. Each round analyzes the current realization once, then either
 *
 * 1. relaxes every set UNION whose plain form a physical key proves unique to UNION ALL (R17.unionAll),
 *    which can only keep its consumers' obligations discharged, since its plain form is unique; or
 * 2. places a DISTINCT on each outstanding obligation's input that no other outstanding input lies below, because a
 *    lower placement can make a higher one redundant (a filter over a placed projection inherits its key).
 *
 * Every node goes from plain to `distinct` at most once, and a union from `distinct` to plain at most once, after which
 * a placement on it pins it to UNION; so at most 2V + 1 rounds run, each linear in the DAG. A Group's observing edge is
 * not placed on a node: once nothing else is outstanding, each fold whose input still lacks one row per B deduplicates
 * its contributions on B itself (FoldInput `distinct`), and a fold whose input has one row per B folds it plainly. This
 * is the one decision (foldOf) the emission, the explanation and the test kernel's verification read.
 *
 * Every obligation the placements discharge is recorded, with its own consumer.
 *
 * Duplicate-elimination placement: elision with certificates, placement before the first sensitive consumer, UNION ALL
 * only for unique pairwise-disjoint coerced headings, recursive feedback kept under UNION.
 */
export const placeDeduplication = (
	dag: RelDag,
	env: PlacementEnv
): Result.Result<DedupPlan, CompileError> => {
	/** Each node's realization by its label, in topological order: the policy's to start with, then each decision. */
	const realization = new Map<NodeId, Realization>()
	const nodes = topoOrder(dag)
	for (const node of nodes) {
		realization.set(node.id, initialRealization(node))
	}
	/** Unions a placement made set UNION: never relaxed again, so the worklist terminates. */
	const pinnedUnions = new Set<RelNode>()
	const placements: Array<Placement> = []
	const placementCerts: Array<Certificate<MultiplicityRule>> = []
	const maxRounds = 2 * nodes.length + 2
	let rounds = 0
	for (;;) {
		if (rounds >= maxRounds) {
			return Result.err(defect("worklist", `a fixed point within ${maxRounds} rounds`))
		}
		rounds++
		const a = analyzeRealization(dag, realization, env)
		/** 1. Set UNION over unique, pairwise disjoint arms is UNION ALL. */
		const relaxed = a.order.filter(
			(node) =>
				node.kind === "Union" &&
				realization.get(node.id) === "distinct" &&
				!pinnedUnions.has(node) &&
				a.of(node).props.uniqueness.kind === "plain"
		)
		for (const node of relaxed) {
			realization.set(node.id, "plain")
		}
		if (relaxed.length > 0) {
			continue
		}
		/** 2. The outstanding obligations a node placement discharges. */
		const outstanding = a.obligations.flatMap((o) =>
			o.discharged || edgeFold(o.edge) !== undefined ? [] : [o]
		)
		if (outstanding.length === 0) {
			return finishPlan(env, a, realization, placements, placementCerts, rounds)
		}
		const targets = new Set(outstanding.map((o) => placementTarget(o.edge.input)))
		const below = belowTargets(a.order, targets)
		/** The obligations on targets no other lies above, by target in the analysis's node order. */
		const byTarget = Map.groupBy(
			outstanding
				.map((o) => ({ o, target: placementTarget(o.edge.input) }))
				.filter(({ target }) => !below.has(target)),
			({ target }) => target
		)
		const lowest = a.order.flatMap((node) => byTarget.get(node) ?? [])
		/** Each lowest target realized `distinct` once: the defect when a target already is, or is a pinned set form. */
		const placed = new Set<RelNode>()
		for (const { o, target } of lowest) {
			if (placed.has(target)) {
				continue
			}
			placed.add(target)
			if (realization.get(target.id) === "distinct") {
				return Result.err(
					defect(
						`node ${target.id}`,
						`a duplicate elimination over the whole heading of ${target.kind} ${target.id} that discharges its consumer's need for (${o.heading.join(", ")})`
					)
				)
			}
			if (isPinnedDistinct(target)) {
				return Result.err(defect(`node ${target.id}`, `a pinned set form realized plainly`))
			}
			realization.set(target.id, "distinct")
			if (target.kind === "Union") {
				pinnedUnions.add(target)
			}
		}
		for (const { o, target } of lowest) {
			placements.push({
				node: target.id,
				input: o.edge.input.id,
				consumer: o.edge.consumer,
				heading: o.heading
			})
			const cert = placementCertificate({ ...o, edge: { ...o.edge, input: target } })
			if (!cert.ok) {
				return Result.err(cert.error)
			}
			placementCerts.push(cert.value)
		}
	}
}

/** How a fold takes its input under an analysis: deduplicated on B where an obligation on its input is outstanding, and plainly otherwise. */
type Fold = { readonly kind: "owed"; readonly owed: Outstanding } | { readonly kind: "plain" }

export const foldOf = (a: PhysicalAnalysis, node: NodeOf<"Group">): Fold => {
	const [owed] = a.obligations.flatMap((o) =>
		o.discharged || consumerIn(o.edge.consumer, "input")?.id !== node.id ? [] : [o]
	)
	if (owed !== undefined) {
		return { kind: "owed", owed }
	}
	return { kind: "plain" }
}

const finishPlan = (
	env: PlacementEnv,
	a: PhysicalAnalysis,
	realization: ReadonlyMap<NodeId, Realization>,
	placements: ReadonlyArray<Placement>,
	placementCerts: ReadonlyArray<Certificate<MultiplicityRule>>,
	rounds: number
): Result.Result<DedupPlan, CompileError> => {
	/** Each fold's form, decided once (foldOf), with the node its DISTINCT deduplicates and that placement's certificate. */
	const decided = new Map<NodeOf<"Group">, Fold>()
	const decide = (group: NodeOf<"Group">): Fold => {
		const known = decided.get(group)
		if (known !== undefined) {
			return known
		}
		const fold = foldOf(a, group)
		decided.set(group, fold)
		return fold
	}
	const form: FoldForm = (group) => (decide(group).kind === "plain" ? "plain" : "distinct")
	const groups = a.order.flatMap((node) =>
		node.kind === "Group" && node.aggs.length > 0 ? [node] : []
	)
	const foldCerts: Array<Certificate<MultiplicityRule>> = []
	for (const node of groups) {
		const fold = decide(node)
		if (fold.kind === "plain") {
			continue
		}
		const cert = placementCertificate(fold.owed)
		if (!cert.ok) {
			return Result.err(cert.error)
		}
		foldCerts.push(cert.value)
	}
	const certified = certifyPlan(a, form, [...placementCerts, ...foldCerts])
	if (!certified.ok) {
		return Result.err(certified.error)
	}
	const explained = explainPlan(a, form, placements)
	const folds: Record<NodeId, FoldPlan> = {}
	for (const node of groups) {
		const fold = decide(node)
		const reasons = foldReasons(a, node, form(node))
		folds[node.id] =
			fold.kind === "plain"
				? { input: "plain", bound: node.bound, reasons }
				: {
						input: "distinct",
						bound: node.bound,
						reasons,
						/** The node the fold's DISTINCT deduplicates: the obligation's input. */
						deduplicates: fold.owed.edge.input.id
					}
	}
	const realized: Record<NodeId, Realization> = {}
	for (const [id, r] of realization) {
		realized[id] = r
	}
	return Result.ok({
		context: env.context,
		realization: Object.freeze(realized),
		folds: Object.freeze(folds),
		placements: Object.freeze([...placements]),
		decisions: explained.decisions,
		certificates: certified.value,
		diagnostics: explained.diagnostics,
		analysis: a,
		rounds
	})
}
