import type { Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { differenceQuery } from "#compiler/lower/conservative/producers/difference.ts"
import { intersectionQuery } from "#compiler/lower/conservative/producers/intersection.ts"
import { packQuery } from "#compiler/lower/conservative/producers/pack.ts"
import {
	conservativeProducerForm,
	type ProducerForm
} from "#compiler/lower/conservative/producers/shared.ts"

export type { ProducerForm } from "#compiler/lower/conservative/producers/shared.ts"

/**
 * A Produce node in a given form: the conservative baseline here, the optimized form in lower/shapes/spans.
 *
 * Span producers in the conservative lowering.
 *
 * A Produce node yields zero or more facts per binding of its input, the carried columns and one produced span, so a
 * producer never delivers a NULL or empty pseudo-span:
 *
 * - spanIntersection: `a * b` under `a && b`, zero or one span (intersection.ts);
 * - spanDifference: range_minus_multi as a LATERAL FROM producer, zero, one or two spans (difference.ts);
 * - spanPack: unnest of the grouped range_agg, one span per maximal covered component of each group (pack.ts).
 *
 * Each closes its produced heading with SELECT DISTINCT, the oracle baseline's boundary at every set boundary:
 * different bindings can produce the same piece. A node lowers to a set, or, realized plain where its consumers make
 * its rows a set, an operand (context.ts NodeLowerer).
 */
export const produceQuery =
	(form: ProducerForm): NodeLowerer<"Produce"> =>
	(node, cx, env) => {
		switch (node.producer) {
			case "spanIntersection":
				return intersectionQuery(node, cx, env, form)
			case "spanDifference":
				return differenceQuery(node, cx, env, form)
			case "spanPack":
				return packQuery(node, cx, env, form)
		}
	}

const lowerProduce: NodeLowerer<"Produce"> = produceQuery(conservativeProducerForm)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const produceLowering: Lowerers<"Produce"> = { Produce: lowerProduce }
