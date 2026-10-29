import { type Lowerers, type NodeLowerer, nodeLabel } from "#compiler/lower/conservative/context.ts"
import { existenceTest } from "#compiler/lower/conservative/semi-join/exists.ts"

/**
 * AntiJoin: keep a left tuple when no right witness exists; `r.not`.
 *
 *   SELECT DISTINCT r2.c1, r2.c2 FROM (<left>) AS r2(c1, c2)
 *   WHERE NOT EXISTS (SELECT 1 FROM (<right>) AS r3(c3, c4) WHERE r3.c3 = r2.c1)
 *
 * Relational negation is NOT EXISTS, never an outer join with an IS NULL test. Every compared column is
 * NOT NULL, so the correlation is two-valued and NOT EXISTS is exactly the anti-join.
 */
const lowerAntiJoin: NodeLowerer<"AntiJoin"> = (node, cx, env) =>
	existenceTest(cx, env, node, nodeLabel(node), true)

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const antiJoinLowering: Lowerers<"AntiJoin"> = { AntiJoin: lowerAntiJoin }
