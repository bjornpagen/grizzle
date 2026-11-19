import { placementCertificate } from "#compiler/analysis/certificates/builder.ts"

import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	analyzePhysical,
	type PhysicalAnalysis,
	type PhysicalEnv,
	reanalyzePhysical,
	type RootObservation
} from "#compiler/analysis/physical/analyze.ts"
import type { Realization } from "#compiler/analysis/physical/props.ts"
import { type CompileError, malformedDescription } from "#compiler/core/errors.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { SourceLoc } from "#compiler/core/loc.ts"
import type { Certificate, MultiplicityRule } from "#compiler/ir/certificate.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { inputsOf, type RelDag, type RelNode } from "#compiler/ir/rel.ts"
import { certifyPlan } from "#compiler/lower/optimize/dedup/certify.ts"
import type { DedupPlan, Placement } from "#compiler/lower/optimize/dedup/plan.ts"
import {
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

/** The physical analysis's environment of a realization, each node's decision by its label, under the placement's. */
const physicalEnv = (
	realization: ReadonlyMap<NodeId, Realization>,
	env: PlacementEnv
): PhysicalEnv => ({
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
 * The worklist ends. Each round analyzes the current realization once, every node below the round before's decisions
 * carrying the properties that round computed (analysis/physical/analyze.ts reanalyzePhysical), then either
 *
 * 1. relaxes every set UNION whose plain form a physical key proves unique to UNION ALL (R17.unionAll),
 *    which can only keep its consumers' obligations discharged, since its plain form is unique; or
 * 2. places a DISTINCT on each outstanding obligation's input that no other outstanding input lies below, because a
 *    lower placement can make a higher one redundant (a filter over a placed projection inherits its key).
 *
 * Every node goes from plain to `distinct` at most once, and a union from `distinct` to plain at most once, after which
 * a placement on it pins it to UNION. A relaxing round moves at least one union, and a placing round at least one node:
 * the first target in topological order lies above no other, so some target is always lowest, and a lowest target
 * already `distinct` is a defect. So at most V + U + 1 rounds run, for V nodes of which U are unions, each linear in the
 * DAG.
 *
 * A Group with aggregates observes its input on the input's whole heading, as every observing consumer does, and its
 * obligation is placed on a node like any other: its bound tuple is a key of its input (ir/rel.ts FoldInput), so the
 * input distinct over its heading holds one row per bound tuple, and the fold has nothing of its own to deduplicate.
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
	const analyzed = physicalEnv(realization, env)
	/**
	 * The current realization's analysis: the policy's at first, then each round's carried into the next over the labels
	 * the round decided (reanalyzePhysical), so a node below every decision keeps the properties it was computed with.
	 */
	let a = analyzePhysical(dag, analyzed)
	for (;;) {
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
			a = reanalyzePhysical(a, analyzed, new Set(relaxed.map((node) => node.id)))
			continue
		}
		/** 2. The outstanding obligations a node placement discharges. */
		const outstanding = a.obligations.flatMap((o) => (o.discharged ? [] : [o]))
		if (outstanding.length === 0) {
			return finishPlan(env, a, realization, placements, placementCerts)
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
		a = reanalyzePhysical(a, analyzed, new Set([...placed].map((node) => node.id)))
	}
}

const finishPlan = (
	env: PlacementEnv,
	a: PhysicalAnalysis,
	realization: ReadonlyMap<NodeId, Realization>,
	placements: ReadonlyArray<Placement>,
	placementCerts: ReadonlyArray<Certificate<MultiplicityRule>>
): Result.Result<DedupPlan, CompileError> => {
	const certified = certifyPlan(a, placementCerts)
	if (!certified.ok) {
		return Result.err(certified.error)
	}
	const realized: Record<NodeId, Realization> = {}
	for (const [id, r] of realization) {
		realized[id] = r
	}
	return Result.ok({
		context: env.context,
		realization: Object.freeze(realized),
		placements: Object.freeze([...placements]),
		certificates: certified.value,
		analysis: a
	})
}
