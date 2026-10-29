import type { NodeOf } from "#compiler/ir/rel.ts"
import type { ProducerForm } from "#compiler/lower/conservative/producers/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"

/**
 * The optimized forms of the span producers.
 *
 * The SQL of each producer is the conservative builder's (lower/conservative/producers); the optimized lowering only
 * decides which of its set boundaries remain, from the physical facts (shapes/share/physical.ts), never from logical
 * keys or the node's kind:
 *
 * - intersection and difference keep their outer DISTINCT exactly where the placement realized the node `distinct`.
 *   The placement reads analysis/physical produceProps, the uniqueness proof for a producer: the pieces of one
 *   invocation are distinct (one intersection, disjoint differences), so the produced heading is unique when an input
 *   key lies among the carried columns, the correlation identity; otherwise it deduplicates, because different
 *   bindings can produce identical pieces.
 * - pack drops both of its boundaries. The grouped input's DISTINCT is unobservable, because range_agg is a union of
 *   point sets and a repeated span adds no point (duplicate-insensitive observation). The outer DISTINCT is
 *   redundant whatever the placement realized: the GROUP BY makes the carried columns a key of the grouped rows, and
 *   the components unnest yields from one multirange are disjoint, so (carried, component) is unique by construction,
 *   the grouped-output-key reason.
 */
export const optimizedProducerForm = (node: NodeOf<"Produce">, facts: ShapeFacts): ProducerForm =>
	node.producer === "spanPack"
		? { distinct: false, contributions: false }
		: { distinct: facts.realization(node) === "distinct", contributions: false }
