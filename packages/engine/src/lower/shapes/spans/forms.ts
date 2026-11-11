import type { NodeOf, ProducerNode } from "#compiler/ir/rel.ts"
import type {
	Contributions,
	ProducerForm,
	ProducedRows
} from "#compiler/lower/conservative/producers/shared.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"

/**
 * The optimized forms of the span producers.
 *
 * The SQL of each producer is the conservative builder's (lower/conservative/producers); the optimized lowering only
 * decides which of its set boundaries remain, from the physical facts (shapes/share/physical.ts), never from logical
 * keys or the node's kind:
 *
 * - intersection and difference are realized as the placement decided, as every plain node is (shapes/index.ts
 *   realized): their outer DISTINCT where it realized the node `distinct`, and otherwise a plain core, under the
 *   analysis's proof where it proved the produced heading unique and an operand its consumers make a set where it did
 *   not. The proof is analysis/physical produceProps: the pieces of one invocation are distinct (one intersection,
 *   disjoint differences), so the produced heading is unique when an input key lies among the carried columns, the
 *   correlation identity; otherwise different bindings can produce identical pieces.
 * - pack drops its outer DISTINCT whatever the placement realized: the GROUP BY makes the carried columns a key of the
 *   grouped rows, and the components unnest yields from one multirange are disjoint, so (carried, component) is unique
 *   by construction, the grouped-output-key reason, a plain core keyed by its targets. Its contributions stay a set,
 *   which range_agg folds: read plainly where the analysis keys the input by the carried columns and the span, and
 *   through SELECT DISTINCT otherwise.
 */
export const optimizedProducerForm = (node: NodeOf<"Produce">, facts: ShapeFacts): ProducerForm =>
	node.producer === "spanPack"
		? { produced: "keyed", contributions: packContributions(node, facts) }
		: { produced: producedRows(node, facts), contributions: "distinct" }

/** The produced rows of an intersection or a difference, as the placement realized the node. */
const producedRows = (node: NodeOf<"Produce">, facts: ShapeFacts): ProducedRows =>
	facts.realization(node) === "distinct"
		? "distinct"
		: facts.unique(node) === undefined
			? "operand"
			: "certified"

/**
 * A pack's contributions: keyed where its span is a column of its input and the input is keyed by the carried columns
 * and that column, so the plain read of a set input repeats none; otherwise DISTINCT.
 */
const packContributions = (node: ProducerNode<"spanPack">, facts: ShapeFacts): Contributions => {
	const [span] = node.args
	return span.kind === "column" &&
		span.column.node === node.input.id &&
		facts.keyedBy(node.input, [...node.carried, span.column.name]) !== undefined
		? "keyed"
		: "distinct"
}
