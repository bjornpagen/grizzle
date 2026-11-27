import { isNonEmpty, mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { Heading } from "#compiler/ir/rel.ts"
import {
	type ColumnMap,
	columnIn,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import type { Expr, FromItem, OperandSelect, Target } from "#compiler/sql/ast.ts"
import {
	keyedRead,
	lit,
	operandSelect,
	provedCore,
	target,
	types,
	unitTargets
} from "#compiler/sql/build.ts"

/**
 * A step's rows: `input`'s rows where `where` holds, read apart, as a subquery with OFFSET 0. This is the one printer of
 * a read of columns PostgreSQL plans apart from the query that reads it: a Step node's (lowerStep, headingRead), and an
 * existence test's right side read per left row, its join's equalities inside it as outer references
 * (semi-join/exists.ts); a read of no column is `headingRead`'s.
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
 * A read of `input` where `where` holds, apart, of the columns of `heading` read through `map`: their rows (fencedRead),
 * or, where `heading` holds no column, the one row of no column, which stands where any row of the input stands:
 *
 *   SELECT true FROM (<input>) AS r2 [WHERE <where>] LIMIT 1
 *
 * A relation of no column holds one row or none, so its read stops at the first row it finds, a seek of each key it is
 * read at and no further, and PostgreSQL plans it for that one row (src/backend/optimizer/plan/planner.c
 * preprocess_limit), never a bitmap of every row that matches: a probe's guard reads a learner's relation at the
 * written content's units, every learner's rows there (analysis/theory/query.ts probeGuard), where the read of every
 * row read them all (qti-pie's member_place by its package, every child's). A LIMIT is as much a fence as an OFFSET
 * (prepjointree.c is_simple_subquery refuses `subquery->limitCount`), so the read is planned apart as a step's is.
 */
export const headingRead = (
	heading: Heading,
	map: ColumnMap,
	input: FromItem,
	where: Expr | undefined
): OperandSelect =>
	isNonEmpty(heading)
		? fencedRead(
				mapNonEmpty(heading, (c) => target(columnIn(map, c.name))),
				input,
				where
			)
		: {
				...operandSelect(provedCore("oneRow", unitTargets, [input], where)),
				limit: lit.int(1, types.integer)
			}

/**
 * Step: its input's rows, read apart (headingRead), every one of them, or the one row of no column. A step that reads
 * outer values is placed LATERAL by the region that reads it (match-region), so it runs once per binding of the steps
 * before it.
 */
const lowerStep: NodeLowerer<"Step"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	return headingRead(node.heading, input.map, input.item, undefined)
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const stepLowering: Lowerers<"Step"> = { Step: lowerStep }
