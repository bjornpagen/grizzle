import { Array as Arr } from "effect"
import type * as ts from "typescript/ast"

/**
 * The nodes at and under `root` in pre-order, each before its children and the children in source order, walked over a
 * stack of pending nodes on the heap: no depth of nesting deepens the call stack, so no source exhausts it. A node's
 * children are walked when `descend` holds of it.
 */
export function* preorder(
	root: ts.Node,
	descend: (node: ts.Node) => boolean
): Generator<ts.Node, void, undefined> {
	const pending: Array<ts.Node> = [root]
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		yield node
		if (!descend(node)) {
			continue
		}
		const children: Array<ts.Node> = []
		node.forEachChild((child) => {
			children.push(child)
		})
		for (const child of Arr.reverse(children)) {
			pending.push(child)
		}
	}
}

/** Every node: a walk that descends into each. */
export const everyNode = (): boolean => true
