import type { Realization } from "#compiler/analysis/physical/props.ts"
import type { NodeOf, RelKind, RelNode } from "#compiler/ir/rel.ts"

/**
 * Typed readers shared by the lowering tests: a value the test expects to be there, and a node of the kind the test
 * expects. Each one checks what it returns, so a missing value or a node of another kind fails the test with its name
 * instead of being read as something it is not.
 */

/** The value, which the test expects to be defined. */
export const present = <A>(value: A | undefined, what: string): A => {
	if (value === undefined) {
		throw new Error(`expected ${what}`)
	}
	return value
}

/** Whether a node is of kind K. */
const isNodeOf = <K extends RelKind>(node: RelNode, kind: K): node is NodeOf<K> =>
	node.kind === kind

/** The node, which the test expects to be of kind K. */
export const nodeOfKind = <K extends RelKind>(node: RelNode, kind: K): NodeOf<K> => {
	if (!isNodeOf(node, kind)) {
		throw new Error(`expected a ${kind} node at ${node.id}, found ${node.kind}`)
	}
	return node
}

/**
 * The realization of a DAG a share planning is tested on without a placement (lower/optimize/dedup): no node behind a
 * DISTINCT, so the planning reads none of them as read whole at each read (cte-policy readWhole) for it.
 */
export const placedPlain = (): Realization => "plain"
