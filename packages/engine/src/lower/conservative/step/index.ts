import {
	headingTargets,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { keyedRead, lit, operandSelect, types } from "#compiler/sql/build.ts"

/**
 * Step: its input's rows, read apart, as a subquery with OFFSET 0.
 *
 *   SELECT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2) OFFSET 0
 *
 * PostgreSQL pulls a subquery up into the query that reads it only when the subquery is simple, and one with an OFFSET
 * is not (src/backend/optimizer/prep/prepjointree.c is_simple_subquery: `subquery->limitOffset` refuses it, :2020 at
 * REL_19_0 5c839a2a), so the planner plans the step's input on its own and the query that reads
 * it joins the step's rows, never the relations inside it. A step that reads outer values is placed LATERAL by the region
 * that reads it (match-region), so it runs once per binding of the steps before it. The input's rows are a set and the
 * step keeps every one, so no duplicate elimination is added: every column of its input's heading is a key of a set,
 * and the step's rows are a keyed read of its input (keyedRead), a set where the input is one, as a delivery requires.
 */
const lowerStep: NodeLowerer<"Step"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	return {
		...operandSelect(keyedRead(headingTargets(node.heading, input.map), [input.item], undefined)),
		offset: lit.int(0, types.integer)
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const stepLowering: Lowerers<"Step"> = { Step: lowerStep }
