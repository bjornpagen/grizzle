import {
	headingTargets,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import type { Expr, FromItem, OperandSelect, Target } from "#compiler/sql/ast.ts"
import { keyedRead, lit, operandSelect, types } from "#compiler/sql/build.ts"

/**
 * A step's rows: `input`'s rows where `where` holds, read apart, as a subquery with OFFSET 0. This is the one printer of
 * a read PostgreSQL plans apart from the query that reads it: a Step node's (lowerStep), and an existence test's right
 * side read per left row, its join's equalities inside it as outer references (semi-join/exists.ts).
 *
 *   SELECT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2) [WHERE <where>] OFFSET 0
 *
 * PostgreSQL pulls a subquery up into the query that reads it only when the subquery is simple, and one with an OFFSET
 * is not (src/backend/optimizer/prep/prepjointree.c is_simple_subquery: `subquery->limitOffset` refuses it, :2020 at
 * REL_19_0 5c839a2a), so the planner plans the step's input on its own and the query that reads it joins the step's
 * rows, never the relations inside it. The input's rows are a set and the step keeps every one `where` keeps, so no
 * duplicate elimination is added: the step's rows are a keyed read of its input (keyedRead), a set where the input is
 * one, as a delivery requires.
 */
export const fencedRead = (
	targets: ReadonlyArray<Target>,
	input: FromItem,
	where: Expr | undefined
): OperandSelect => ({
	...operandSelect(keyedRead(targets, [input], where)),
	offset: lit.int(0, types.integer)
})

/**
 * Step: its input's rows, read apart (fencedRead), every one of them. A step that reads outer values is placed LATERAL
 * by the region that reads it (match-region), so it runs once per binding of the steps before it.
 */
const lowerStep: NodeLowerer<"Step"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	return fencedRead(headingTargets(node.heading, input.map), input.item, undefined)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const stepLowering: Lowerers<"Step"> = { Step: lowerStep }
