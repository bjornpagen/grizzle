import { type Lowerers, type NodeLowerer, nodeLabel } from "#compiler/lower/conservative/context.ts"
import { existenceTest } from "#compiler/lower/conservative/semi-join/exists.ts"

/**
 * SemiJoin: keep a left tuple when at least one right witness exists.
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (<left>) AS r2(c1, c2)
 *   WHERE EXISTS (SELECT 1 FROM (<right>) AS r3(c3, c4) WHERE r3.c3 = r2.c1)
 *
 * The witness payload is not a contribution: EXISTS observes only whether a row exists, so the subquery
 * needs `SELECT 1` and no fabricated witness key. The right side lowers as a set like every node.
 */
const lowerSemiJoin: NodeLowerer<"SemiJoin"> = (node, cx, env) =>
	existenceTest(cx, env, node, nodeLabel(node), false)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const semiJoinLowering: Lowerers<"SemiJoin"> = { SemiJoin: lowerSemiJoin }
