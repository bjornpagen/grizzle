import type { PhysicalAnalysis } from "#compiler/analysis/physical/analyze.ts"
import { consumerIn } from "#compiler/analysis/physical/consumers.ts"
import { isUnique, keyedBy, type Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeId } from "#compiler/core/ids.ts"
import type { Cardinality } from "#compiler/ir/cardinality.ts"
import type { Certificate } from "#compiler/ir/certificate.ts"
import type { TemplateContext } from "#compiler/ir/evidence.ts"
import type { KeySet, NodeOf, RelNode } from "#compiler/ir/rel.ts"
import type { FoldInput } from "#compiler/lower/optimize/dedup/plan.ts"

/**
 * The physical facts every shape lowering reads.
 *
 * A shape decides two things from the physical analysis (analysis/physical) and the duplicate-elimination placement
 * (lower/optimize/dedup): where a set boundary still owes an exact DISTINCT, and which of its SQL forms the fixed
 * policy selects. It never decides either from logical keys, a node's kind or a name: a ProjectSet's logical promise is
 * not physical uniqueness. ShapeFacts is the narrow view the shapes take of those analyses, so a shape can be driven by
 * a real analysis, by the conservative baseline that proves nothing, or by a test that states facts.
 *
 * Every observing consumer a shape lowers discharges its own input's obligation when the facts do not prove the input
 * unique ("verify that ... no sensitive consumer sees unproved multiplicity"): a bound deduplicates
 * before it selects, a fold deduplicates its complete bound tuple, a delivered attachment its rows per parent. Where
 * the placement already realized the input `distinct`, the input is unique and no second DISTINCT is emitted.
 */
export interface ShapeFacts {
	/** The evidence context the template is compiled for. */
	readonly context: TemplateContext
	/** A node's own set boundary: `distinct` where the placement realized exact elimination at it. */
	readonly realization: (node: RelNode) => Realization
	/** Whether a node's rows, as realized, are physically unique on its whole heading. */
	readonly unique: (node: RelNode) => boolean
	/**
	 * Whether `columns` determine a physical key of the node's rows: then the node has at most one row per value of
	 * `columns`, and an order over them is total over the node.
	 */
	readonly keyedBy: (node: RelNode, columns: KeySet) => boolean
	/** The node's maximum cardinality, where the analysis knows one. */
	readonly maxCard: (node: RelNode) => Cardinality
	/** Whether an attachment's child rows are unique per parent binding. */
	readonly childUniquePerParent: (attach: NodeOf<"Attach">) => boolean
	/** Compiling a derived-relation definition, which always wants every group (R20). */
	readonly derivedDefinition: boolean
	/** Where a shape records the certificate of the form it selected. */
	readonly certify: (certificate: Certificate) => void
}

/**
 * The certificate sink of a compilation that keeps no shape certificate: a page's (page/compile.ts says why it relies
 * on no premise its query template's cache entry lacks).
 */
export const discardCertificates: ShapeFacts["certify"] = () => {}

interface AnalysisFactsOptions {
	/** Compiling a derived-relation definition, which always wants every group (R20). */
	readonly derivedDefinition: boolean
	readonly certify: (certificate: Certificate) => void
}

/**
 * The facts of a placement (dedup/plan.ts): its physical analysis, run over its realization (analysis/physical
 * analyzePhysical with `realization`), gives uniqueness and keys under that realization, cardinality bounds and the
 * per-parent discharge of each attachment's child obligation; its fold forms say which folds take their input as it
 * is (dedup/place.ts decides it, once).
 */
export const shapeFactsFromPlan = (
	plan: {
		readonly analysis: PhysicalAnalysis
		readonly folds: Readonly<Record<NodeId, { readonly input: FoldInput }>>
	},
	options: AnalysisFactsOptions
): ShapeFacts => {
	const analysis = plan.analysis
	/** The attachments of the analyzed DAG, by label, and those whose child edge observes or is discharged. */
	const analyzed = new Set<NodeId>(analysis.order.map((node) => node.id))
	const childUnique = new Set<NodeId>()
	const childObserved = new Set<NodeId>()
	for (const o of analysis.obligations) {
		const attach = consumerIn(o.edge.consumer, "child")
		if (attach === undefined) {
			continue
		}
		childObserved.add(attach.id)
		if (o.discharged) {
			childUnique.add(attach.id)
		}
	}
	/** The analysis reads every node of the DAG the shapes lower (analysis/physical analyzePhysical). */
	const propsOf = (node: RelNode) => analysis.of(node).props
	return {
		context: analysis.context,
		realization: (node) => analysis.of(node).realization,
		unique: (node) => isUnique(propsOf(node)),
		keyedBy: (node, columns) => keyedBy(propsOf(node), columns) !== undefined,
		maxCard: (node) => propsOf(node).maxCard,
		/**
		 * A child edge that observes and is discharged proves the child unique per parent; a child edge that does not
		 * observe (the child is realized distinct, absorbing repeats) proves it too.
		 */
		childUniquePerParent: (attach) =>
			analyzed.has(attach.id) && (childUnique.has(attach.id) || !childObserved.has(attach.id)),
		derivedDefinition: options.derivedDefinition,
		certify: options.certify
	}
}
