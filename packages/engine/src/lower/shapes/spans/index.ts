import type { NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { produceQuery } from "#compiler/lower/conservative/producers/index.ts"
import type { ShapeFacts } from "#compiler/lower/shapes/share/physical.ts"
import { optimizedProducerForm } from "#compiler/lower/shapes/spans/forms.ts"

/**
 * Span producers in the optimized lowering.
 *
 * A Produce node lowers through the conservative builders (lower/conservative/producers) in its optimized form
 * (forms.ts): intersection and difference keep their outer DISTINCT only where the placement realized the node
 * `distinct`, and pack drops its own, being unique by construction, and keeps its contributions' unless the analysis
 * keys them. The shape dispatch (../index.ts)
 * reads `producerLowerer` at this fixed path and never edits it. A point lookup against a span-keyed relation is the
 * ordinary `s @> t` the Filter lowers to, which the span key's GiST index serves.
 */
export const producerLowerer =
	(facts: ShapeFacts): NodeLowerer<"Produce"> =>
	(node, cx, env) =>
		produceQuery(optimizedProducerForm(node, facts))(node, cx, env)
