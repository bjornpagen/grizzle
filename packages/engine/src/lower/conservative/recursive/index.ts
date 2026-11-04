import { appendAll } from "#compiler/core/array.ts"
import type { NodeOf, RelNode } from "#compiler/ir/rel.ts"
import { typeLabel } from "#compiler/ir/scalar.ts"
import {
	columnIn,
	headingTargets,
	type Lowerers,
	type NodeLowerer,
	namedMap,
	nodeLabel,
	outputNames,
	queryInputs,
	refuse
} from "#compiler/lower/conservative/context.ts"
import type { Select, SelectCore } from "#compiler/sql/ast.ts"
import { cast, core, cteRefAs, select, target } from "#compiler/sql/build.ts"

/**
 * What a node does to the feedback flowing through some of its inputs, when it is not monotone and distributive over
 * it.
 */
interface Blocking {
	readonly inputs: ReadonlyArray<RelNode>
	readonly what: string
}

/**
 * The inputs of a node through which feedback may not flow, with what the operator does to it; undefined when every
 * input may carry it. A span pack groups its input as an aggregate does; intersection and difference of spans are per
 * row. A recursion nested over the feedback computes its own fixed point of one iteration's batch.
 */
const nonPositive = (node: RelNode): Blocking | undefined => {
	switch (node.kind) {
		case "Group":
			return { inputs: [node.input], what: "an aggregate over the feedback" }
		case "Take":
			return { inputs: [node.input], what: "a bound over the feedback" }
		case "ApproximateNearest":
			return { inputs: [node.source], what: "an approximate search over the feedback" }
		case "Window":
			return { inputs: [node.input], what: "a window over the feedback" }
		case "OrderedSetAggregate":
			return { inputs: [node.input], what: "an ordered-set aggregate over the feedback" }
		case "AntiJoin":
		case "Difference":
			return { inputs: [node.right], what: "a negation of the feedback" }
		case "Intersect":
			return { inputs: [node.left, node.right], what: "an intersection with the feedback" }
		case "Produce":
			return node.producer === "spanPack"
				? { inputs: [node.input], what: "a span pack over the feedback" }
				: undefined
		case "Recursive":
			return { inputs: [node.base, node.step], what: "a recursion over the feedback" }
		case "Base":
		case "Closed":
		case "Context":
		case "InputSet":
		case "Delta":
		case "MatchRegion":
		case "Filter":
		case "ProjectSet":
		case "SemiJoin":
		case "Union":
		case "SelfRef":
		case "OrderedResult":
		case "Attach":
		case "Forbid":
			return undefined
	}
}

/**
 * The first node on a path from a recursion's step to its SelfRef through which the feedback may not flow, with what
 * it does to the feedback; undefined when the feedback is positive and linear, so its fixed point distributes over a
 * union of seeds.
 *
 * The array iterator reads the length at every step, so the inputs pushed below are visited too.
 */
export const feedbackBlock = (
	rec: NodeOf<"Recursive">
): { readonly node: RelNode; readonly what: string } | undefined => {
	const reaches = new Map<RelNode, boolean>()
	const reachesSelf = (node: RelNode): boolean => {
		const known = reaches.get(node)
		if (known !== undefined) {
			return known
		}
		const result = node === rec.self || queryInputs(node).some(reachesSelf)
		reaches.set(node, result)
		return result
	}
	const visited = new Set<RelNode>()
	const queue: Array<RelNode> = [rec.step]
	for (const node of queue) {
		if (visited.has(node) || node === rec.self || !reachesSelf(node)) {
			continue
		}
		visited.add(node)
		const blocking = nonPositive(node)
		if (blocking?.inputs.some(reachesSelf) === true) {
			return { node, what: blocking.what }
		}
		appendAll(queue, queryInputs(node))
	}
	return undefined
}

/**
 * Refuses what no lowering of the recursion may emit, optimized or conservative, so the two artifacts of a template
 * refuse alike: feedback that is not positive and linear, and a state column without the hashing capability. A
 * recursion is never lowered inside its own terms: a node holds only nodes built before it, and the Recursive is
 * built after its terms.
 */
export const requireAdmittedFeedback = (rec: NodeOf<"Recursive">): void => {
	const at = nodeLabel(rec)
	const block = feedbackBlock(rec)
	if (block !== undefined) {
		refuse(
			"UnsupportedOperation",
			nodeLabel(block.node),
			`positive linear feedback in the step of ${rec.id}: ${block.what} ${rec.self.id}; precompute independent aggregates before feedback or aggregate the completed result afterward`
		)
	}
	for (const c of rec.heading) {
		if (!c.type.caps.includes("hashing")) {
			refuse(
				"UnsupportedOperation",
				at,
				`hashing: ${typeLabel(c.type)} state column ${c.name} has no hash operator class, and a recursive UNION deduplicates only by hashing`
			)
		}
	}
}

/**
 * Recursive: the least fixed point of positive linear feedback, a set of its complete state tuple.
 *
 *   WITH RECURSIVE r1(c1, c2) AS (
 *     SELECT r2.c3::integer, r2.c4::integer FROM (<base>) AS r2(c3, c4)
 *     UNION
 *     SELECT r3.c5::integer, r3.c6::integer FROM (<step reading r1>) AS r3(c5, c6)
 *   )
 *   SELECT r4.c1, r4.c2 FROM r1 AS r4
 *
 * Recursive UNION removes repeated states within and across iterations before they feed the working table,
 * and it is the only feedback form the baseline emits: UNION ALL is never substituted, whatever the
 * edge keys or the graph's shape. Both terms are cast column by column to the declared state type's
 * representation, its base, so PostgreSQL's recursive type agreement never rests on a seed literal's inferred type and
 * no column silently widens. The step reads the working table through its SelfRef, which lowers to a
 * scan of the recursive CTE; the CTE is in scope for every query nested in its body.
 *
 * PostgreSQL deduplicates a recursive UNION only by hashing, so every state column needs the hashing capability; a
 * state with a money or vector column is refused with UnsupportedOperation rather than emitted for PostgreSQL to
 * reject with 0A000.
 *
 * Only positive linear feedback is lowered. PostgreSQL checks aggregates, LIMIT and negation of the
 * self-reference only at the top level of the recursive term, so a Group or Take nested in a derived table over the
 * working table runs, and folds or bounds one iteration's batch instead of the fixed point. Before
 * lowering, every path from the step to its SelfRef is walked, and a path through an operator that is not monotone
 * and distributive over the feedback is refused: a fold, a span pack, a bound, an approximate search, a window, a
 * nested recursion, the negated side of an anti-join or difference, or either side of an intersection. The optimized
 * lowerings refuse alike (requireAdmittedFeedback), and a seeded recursion relies on the same walk (feedbackBlock).
 */
const lowerRecursive: NodeLowerer<"Recursive"> = (node, cx, env) => {
	requireAdmittedFeedback(node)
	const origin = { kind: "node", node: node.id } as const
	const cte = cx.relationAlias(origin)
	const named = cx.freshColumns(outputNames(node.heading), origin)
	/** Both terms are lowered with the recursion registered as the feedback its SelfRef scans. */
	const terms = cx.withFeedback(node, cte, named)
	/** Each term's heading has the state's columns (valid DAG). */
	const term = (input: RelNode): SelectCore => {
		const source = terms.source(input, env)
		const targets =
			node.heading.length === 0
				? headingTargets(node.heading, source.map)
				: node.heading.map((c) =>
						target(cast(columnIn(source.map, c.name), terms.baseTypeRef(c.type)))
					)
		return core(targets, [source.item], undefined)
	}
	const base = term(node.base)
	const step = term(node.step)
	const body: Select = select({ kind: "setOp", op: "UNION", arms: [base, step] })
	const alias = cx.relationAlias(origin)
	const map = namedMap(alias, named)
	return {
		...select(core(headingTargets(node.heading, map), [cteRefAs(cte, alias)], undefined)),
		with: {
			recursive: true,
			ctes: [
				{ name: cte, columns: named.map((n) => n.column), query: body, materialized: undefined }
			]
		}
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const recursiveLowering: Lowerers<"Recursive"> = { Recursive: lowerRecursive }
