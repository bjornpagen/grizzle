import { mapNonEmpty } from "@bjornpagen/grizzle-text/base/nonempty"
import type { LowerContext, Lowerers, NodeLowerer } from "#compiler/lower/conservative/context.ts"
import { armCore } from "#compiler/lower/conservative/union/arms.ts"

/**
 * Union: the set union of rule arms.
 *
 *   SELECT r2.c1, r2.c2 FROM (<arm 1>) AS r2(c1, c2)
 *   UNION
 *   SELECT r3.c3, r3.c4 FROM (<arm 2>) AS r3(c3, c4)
 *
 * Nonrecursive union lowers conservatively to its set union (LowerContext.unionOf): UNION, which absorbs repeats
 * within and across arms, or on a write's fact spine the arms' facts as one set by their identity; UNION ALL alone
 * needs a disjointness proof the baseline never makes. Read inside a statement, a union of several heading groups
 * has the heading common to every group (valid DAG), so every arm is projected onto those columns: arms of
 * different groups carry different literal discriminants and so never collapse, and the group-specific columns are
 * invisible to the consumer. A heterogeneous union delivered to the host is one statement per heading group instead
 * (deliver.ts), each a part of the program's one statement, never one relation padded to every group's columns.
 */
const lowerUnion: NodeLowerer<"Union"> = (node, cx: LowerContext, env) => {
	const [first, ...rest] = mapNonEmpty(node.groups, (g) =>
		mapNonEmpty(g.arms, (arm) => armCore(cx, arm, node.heading, env))
	)
	return cx.unionOf(node, [...first, ...rest.flat()])
}

/** This kind's entry of the conservative kind table (dispatch.ts). */
export const unionLowering: Lowerers<"Union"> = { Union: lowerUnion }
