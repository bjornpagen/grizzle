import {
	columnIn,
	extendEnv,
	headingTargets,
	type Lowerers,
	type NodeLowerer
} from "#compiler/lower/conservative/context.ts"
import { lowerExpr } from "#compiler/lower/conservative/expr/index.ts"
import { completedOrderItems } from "#compiler/lower/conservative/take/order.ts"
import { columnType } from "#compiler/runtime/lower/columns.ts"
import type { Expr, OrderItem } from "#compiler/sql/ast.ts"
import { conjunction, distinctCore, select } from "#compiler/sql/build.ts"

/**
 * Take: the first k tuples of a set under a completed total order, a set again.
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (<input>) AS r2(c1, c2)
 *   [WHERE r2.c1 = <outer>]
 *   ORDER BY r2.c2 DESC, r2.c1 LIMIT 3
 *
 * The input is a set before the bound, because LIMIT never replaces deduplication before selecting k facts;
 * the DISTINCT and the ORDER BY sit in one query, and every order column is a selected column. The
 * order the IR carries is total over the input (valid DAG); the baseline still appends the remaining heading
 * columns, ascending, so its choice of k never rests on a key it would otherwise have to trust. A correlated take, one
 * whose correlation columns are fixed by outer values, puts those equalities in its WHERE, and the consumer that
 * reads it makes it LATERAL. The bound is a positive literal, or an integer parameter cast to its type.
 */
const lowerTake: NodeLowerer<"Take"> = (node, cx, env) => {
	const input = cx.source(node.input, env)
	const scope = extendEnv(env, [[node.input.id, input.map]])
	const correlation: Array<Expr> = node.correlation.map((c) =>
		cx.equal(
			columnType(node.heading, c.column),
			columnIn(input.map, c.column),
			lowerExpr(cx, c.expr, scope)
		)
	)
	const orderBy: ReadonlyArray<OrderItem> = completedOrderItems(node.order, node.heading, input.map)
	return {
		...select(
			distinctCore(headingTargets(node.heading, input.map), [input.item], conjunction(correlation))
		),
		orderBy,
		limit: cx.boundExpr(node.bound)
	}
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const takeLowering: Lowerers<"Take"> = { Take: lowerTake }
