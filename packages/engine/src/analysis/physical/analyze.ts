import { type Contribution, contributionOf } from "#compiler/analysis/contribution/contribution.ts"
import {
	type ConsumerEdge,
	classifyEdges,
	consumerIn,
	type ObservingEdge,
	observedNodes,
	type RootObservation
} from "#compiler/analysis/physical/consumers.ts"

import { type Justification, withReason } from "#compiler/analysis/physical/fds.ts"

import { keyedBy, type PhysicalProps, type Realization } from "#compiler/analysis/physical/props.ts"

import {
	physicalPropsOf,
	type RuleContext,
	realizationOf
} from "#compiler/analysis/physical/rules.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { EvidenceCatalog, TemplateContext } from "#compiler/ir/evidence.ts"
import { Fold } from "#compiler/ir/fold.ts"
import { inputsOf, type KeySet, type RelDag, type RelNode } from "#compiler/ir/rel.ts"

export interface PhysicalEnv {
	/**
	 * The execution context the template is compiled for, which the shapes read off the analysis; every key the rules
	 * read holds in each (evidence.ts keyEvidence).
	 */
	readonly context: TemplateContext
	/** The installed constraints behind declared keys and containments, named as ownership installs them. */
	readonly catalog: EvidenceCatalog
	/**
	 * The realization a placement decided for the node of a label, or undefined where it decided none: that node has its
	 * kind's default (rules.ts defaultRealizationOf). By label, since a SelfRef names its Recursive by one.
	 */
	readonly realization: (node: NodeId) => Realization | undefined
	/** How the program consumes its roots. */
	readonly roots: RootObservation
}

export type { RootObservation }

/** No placement decided: every node has its default realization (rules.ts defaultRealizationOf). */
export const unplaced: PhysicalEnv["realization"] = () => undefined

/** An obligation no physical key discharges: a placement owes its duplicate elimination. */
export interface Outstanding {
	readonly edge: ObservingEdge
	readonly heading: KeySet
	readonly discharged: false
}

/**
 * An observing edge's demand: its consumer needs the input distinct on `heading`, the edge's required columns. It is
 * discharged with the justification of the input's identification by the heading, or outstanding.
 */
export type Obligation =
	| Outstanding
	| {
			readonly edge: ObservingEdge
			readonly heading: KeySet
			readonly discharged: true
			readonly proof: Justification
	  }

/** What the analysis knows of one node. */
export interface PhysicalNode {
	readonly props: PhysicalProps
	readonly realization: Realization
	/** Whether the node's repeats reach an observing consumer through preserving ones. */
	readonly observed: boolean
	/** A fold's contribution (a Group with aggregates, an OrderedSetAggregate, a Window); no other node has one. */
	readonly contribution: Contribution | undefined
}

export interface PhysicalAnalysis {
	readonly dag: RelDag
	readonly context: TemplateContext
	/** The nodes the roots reach, inputs first (ir/dag.ts topoOrder). */
	readonly order: ReadonlyArray<RelNode>
	/** What the analysis knows of a node of its DAG, each computed from its inputs' (the analysis's fold). */
	readonly of: (node: RelNode) => PhysicalNode
	readonly edges: ReadonlyArray<ConsumerEdge>
	readonly obligations: ReadonlyArray<Obligation>
}

/**
 * Physical multiplicity analysis of a query DAG.
 *
 * One pass in topological order computes every node's physical properties under its realization (rules.ts); one
 * classification of every consumer edge follows (consumers.ts); then each observing edge becomes an obligation, the
 * heading its consumer needs distinct, discharged when the input's physical keys prove it and outstanding otherwise.
 * What the analysis knows lives beside the DAG and never touches NodeMeta.
 *
 * The analysis is a pure function of the DAG, the execution context, the evidence catalog and the realization: the
 * placement pass (lower/optimize/dedup) runs it over the plain realization to learn where elimination is owed, decides,
 * and runs it again over its decision, which the test kernel's verification (test/support/oracle/verify) checks has no
 * outstanding obligation ("verify that every required set boundary is discharged and that no sensitive consumer sees
 * unproved multiplicity"). Each node's table embeds its inputs' (fds.ts Dependencies), every question about it is
 * answered by closures linear in that table, one per evidence context the table's proofs hold in and, for a minimal
 * key, as many again per column it tries to drop, and no key is ever enumerated: no search over plans and no bound on
 * what a proof may reach.
 *
 * Physical multiplicity: evidence lifetime, uniqueness inference, consumer sensitivity, and the obligations the
 * duplicate-elimination placement reads.
 */
export const analyzePhysical = (dag: RelDag, env: PhysicalEnv): PhysicalAnalysis => {
	const order = topoOrder(dag)
	const { context, catalog } = env
	const realization = (node: RelNode): Realization => realizationOf(env.realization, node)
	/** Each node's physical properties, its inputs' first: every input is yielded before its rule reads it. */
	const props = new Fold<RelNode, PhysicalProps>(function* (node) {
		for (const input of inputsOf(node)) {
			yield input
		}
		return physicalPropsOf(node, rules)
	})
	const rules: RuleContext = { props: (input) => props.of(input), catalog, placed: env.realization }
	const edges = classifyEdges(dag, order, {
		props: (node) => props.of(node),
		realization,
		roots: env.roots
	})
	/**
	 * Recursive feedback under UNION ALL is never discharged: only the recursive UNION
	 * removes states repeated across iterations.
	 */
	const obligations: Array<Obligation> = edges.flatMap((edge): ReadonlyArray<Obligation> => {
		if (edge.sensitivity !== "observes") {
			return []
		}
		const heading = edge.requires
		if (consumerIn(edge.consumer, "feedback") !== undefined) {
			return [{ edge, heading, discharged: false }]
		}
		const found = keyedBy(props.of(edge.input), heading)
		if (found === undefined) {
			return [{ edge, heading, discharged: false }]
		}
		/** An attached child is judged per parent binding. */
		const proof =
			consumerIn(edge.consumer, "child") !== undefined
				? withReason(found.just, ["perParentAttachment"])
				: found.just
		return [{ edge, heading, discharged: true, proof }]
	})
	const observed = observedNodes(order, edges)
	const contributionAt = (n: RelNode): Contribution | undefined =>
		(n.kind === "Group" && n.aggs.length > 0) ||
		n.kind === "OrderedSetAggregate" ||
		n.kind === "Window"
			? contributionOf(n, props.of(n.input))
			: undefined
	return {
		dag,
		context,
		order,
		of: (node) => ({
			props: props.of(node),
			realization: realization(node),
			observed: observed.has(node),
			contribution: contributionAt(node)
		}),
		edges,
		obligations
	}
}
