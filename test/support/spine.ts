import type { AttachedHeads, AttachmentScope } from "#adapter/reader/analysis.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { RelDag } from "#compiler/ir/rel.ts"

/**
 * A delivered spine over a DAG no Description states, every child column of every attachment carried: each attachment
 * by its name at every level, its heads every column of its child's heading. A generated query has no head keys, so
 * the reader delivers each attachment's whole child, the conservative reading its claims are sound under.
 */
export const everyColumnCarried = (dag: RelDag): AttachmentScope => {
	const under = new Map<string, AttachedHeads>()
	for (const node of topoOrder(dag)) {
		if (node.kind !== "Attach") {
			continue
		}
		const heads = new Set(under.get(node.name)?.heads)
		for (const column of node.child.heading) {
			heads.add(column.name)
		}
		under.set(node.name, { heads, under })
	}
	return { under }
}
