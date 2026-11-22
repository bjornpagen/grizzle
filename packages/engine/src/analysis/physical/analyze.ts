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
	/** A catalog fold's contribution (an OrderedSetAggregate, a Window); no other node has one. */
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
export const analyzePhysical = (dag: RelDag, env: PhysicalEnv): PhysicalAnalysis =>
	analysisOver(dag, topoOrder(dag), propsUnder(env))

/** No node's properties carried: every node is computed from its inputs'. */
const noneKept: ReadonlyMap<RelNode, PhysicalProps> = new Map()

/**
 * Each node's physical properties under one env, its inputs' first, each computed once for as long as its holder holds
 * it: a node's properties read its own realization, its inputs' properties and, for a SelfRef, its Recursive's
 * realization (rules.ts), so one value answers every DAG under `env` that holds the node, whichever state of an edit
 * it is read in: a rewrite pass reads the cells of every state of its edited DAG through one (lower/optimize/demand/frame.ts
 * physicalAnalyses), so a node an edit kept (ir/dag.ts finishCells) is computed once for the pass. A node `kept` holds
 * carries the properties it holds there.
 */
export class PropsUnder {
	readonly env: PhysicalEnv
	readonly #props: Fold<RelNode, PhysicalProps>

	constructor(env: PhysicalEnv, kept: ReadonlyMap<RelNode, PhysicalProps>) {
		this.env = env
		this.#props = new FoldedRules(env, kept).fold
	}

	/** The physical properties of `node` under the env. */
	of(node: RelNode): PhysicalProps {
		return this.#props.of(node)
	}
}

/**
 * Each closure an analysis hands out, and its fold's step, is made by a function of its own that captures what it reads
 * alone, never in PropsUnder's constructor or analysisOver's scope: V8 holds every variable any closure of a scope
 * captures in that scope's one context, and keeps a closure past the analysis through its own metadata (a hidden
 * class's constructor, an allocation site's boilerplate, a feedback vector) once the code that made it is optimized, so
 * a closure made in that scope kept the PropsUnder, its fold's memo of every node's properties among it (GENMEM: six
 * physical props contexts pinned so in edullm's qti generate at hub a212aa699), as logical/annotate.ts's are made
 * (aa7fb978a).
 */

/** The fold's step: a node `kept` carries, its own properties computed from its inputs' otherwise, inputs first. */
const propsStep = (kept: ReadonlyMap<RelNode, PhysicalProps>, rules: RuleContext) =>
	function* (node: RelNode): Generator<RelNode, PhysicalProps, PhysicalProps> {
		const carried = kept.get(node)
		if (carried !== undefined) {
			return carried
		}
		for (const input of inputsOf(node)) {
			yield input
		}
		return physicalPropsOf(node, rules)
	}

/**
 * The context a node's rule reads (rules.ts RuleContext): the env's catalog and decisions, and its inputs' properties
 * off the fold it makes and owns, a method of its own, so no closure of an analysis's scope holds the fold.
 */
class FoldedRules implements RuleContext {
	readonly catalog: EvidenceCatalog
	readonly placed: PhysicalEnv["realization"]
	readonly fold: Fold<RelNode, PhysicalProps>

	constructor(env: PhysicalEnv, kept: ReadonlyMap<RelNode, PhysicalProps>) {
		this.catalog = env.catalog
		this.placed = env.realization
		this.fold = new Fold<RelNode, PhysicalProps>(propsStep(kept, this))
	}

	/** The properties of an input of the node a rule computes, which the fold computed before the node. */
	props(input: RelNode): PhysicalProps {
		return this.fold.of(input)
	}
}

/** A node's properties under one env, read off its PropsUnder. */
const propsOf =
	(props: PropsUnder) =>
	(node: RelNode): PhysicalProps =>
		props.of(node)

/** A node's realization under the env's decisions. */
const realizationIn =
	(placed: PhysicalEnv["realization"]) =>
	(node: RelNode): Realization =>
		realizationOf(placed, node)

/** A node's contribution (contribution.ts): an ordered-set aggregate's or a window's, over its input's properties. */
const contributionIn =
	(props: PropsUnder) =>
	(n: RelNode): Contribution | undefined =>
		n.kind === "OrderedSetAggregate" || n.kind === "Window"
			? contributionOf(n, props.of(n.input))
			: undefined

/** What the analysis knows of a node (PhysicalAnalysis `of`): its properties, realization, observation and contribution. */
const nodeAnalysisOf =
	(
		props: PropsUnder,
		placed: PhysicalEnv["realization"],
		observed: ReadonlySet<RelNode>
	): PhysicalAnalysis["of"] =>
	(node) => ({
		props: props.of(node),
		realization: realizationOf(placed, node),
		observed: observed.has(node),
		contribution: contributionIn(props)(node)
	})

/** Each node's physical properties under `env`, none carried (PropsUnder). */
export const propsUnder = (env: PhysicalEnv): PropsUnder => new PropsUnder(env, noneKept)

/**
 * The analysis of `previous`'s DAG under `env`, whose realization differs from the one `previous` was computed under at
 * the labels `changed` alone: a placement round's, after the round before decided those nodes (lower/optimize/dedup).
 * A node's properties read its own realization, its inputs' properties and, for a SelfRef, its Recursive's realization
 * (rules.ts), so a node none of whose inputs is computed again, whose label is not changed and that is no SelfRef of a
 * changed Recursive has the properties `previous` computed, which it carries; every other node is computed again,
 * inputs first. The analysis is the one analyzePhysical computes under `env`.
 */
export const reanalyzePhysical = (
	previous: PhysicalAnalysis,
	env: PhysicalEnv,
	changed: ReadonlySet<NodeId>
): PhysicalAnalysis => {
	const again = new Set<RelNode>()
	const kept = new Map<RelNode, PhysicalProps>()
	for (const node of previous.order) {
		if (
			changed.has(node.id) ||
			(node.kind === "SelfRef" && changed.has(node.recursive)) ||
			inputsOf(node).some((input) => again.has(input))
		) {
			again.add(node)
		} else {
			kept.set(node, previous.of(node).props)
		}
	}
	return analysisOver(previous.dag, previous.order, new PropsUnder(env, kept))
}

/** The analysis of `dag`, its nodes in topological order `order`, under `props`'s env, each node's properties
 * `props`'s. */
const analysisOver = (
	dag: RelDag,
	order: ReadonlyArray<RelNode>,
	props: PropsUnder
): PhysicalAnalysis => {
	const { env } = props
	const { context } = env
	const edges = classifyEdges(dag, order, {
		props: propsOf(props),
		realization: realizationIn(env.realization),
		roots: env.roots
	})
	const obligations: Array<Obligation> = edges.flatMap((edge): ReadonlyArray<Obligation> => {
		if (edge.sensitivity !== "observes") {
			return []
		}
		const heading = edge.requires
		const input = props.of(edge.input)
		/**
		 * A consumer that observes repeats counts or delivers each row, so rows that are distinct facts discharge it,
		 * -0 and +0 two (PhysicalProps facts), as a key of its heading does.
		 */
		const found =
			keyedBy(input, heading)?.just ??
			(input.columns.every((c) => heading.includes(c)) ? input.facts : undefined)
		if (found === undefined) {
			return [{ edge, heading, discharged: false }]
		}
		/** An attached child is judged per parent binding. */
		const proof =
			consumerIn(edge.consumer, "child") !== undefined
				? withReason(found, ["perParentAttachment"])
				: found
		return [{ edge, heading, discharged: true, proof }]
	})
	return {
		dag,
		context,
		order,
		of: nodeAnalysisOf(props, env.realization, observedNodes(order, edges)),
		edges,
		obligations
	}
}
