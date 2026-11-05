/**
 * A tree's rows, as one depth-first walk draws them (trees.md §1, §5).
 *
 * A tree relation T is the ordered family of T over itself, `T(parent, at)`, whose every row also carries its pre-order
 * interval `[start, end)`. Its caller writes a tree as nested arrays, a root and each node's children in order, and
 * grizzle draws every position from them:
 *
 * - `at`, a node's place among its siblings, and `children`, its count;
 * - `start`, its place in the tree's pre-order, and `end`, `start` plus the number of nodes of its subtree;
 * - ‹n›, its parent's count copied, and ‹ps›, its parent's start.
 *
 * The root is the one self-parented row, outside the family, so the root pin (trees.md T2) gives its law columns one
 * state: at 0, ‹ps› its own start 0, and ‹n› its own count. None of them is the caller's, so no write can state a gap,
 * an overlap or a child outside its parent.
 */
import type { Member, Owner } from "#compiler/write/family/draw.ts"

/** A node as its caller nests it: its key's texts, its own columns' texts (the member layout), its children in order. */
export interface TreeNode {
	readonly key: Owner
	readonly member: Member
	readonly children: ReadonlyArray<TreeNode>
}

/**
 * A node as the walk draws it. A member's parent is its parent's key, `copy` its parent's count and `parentStart` its
 * parent's start; the root's parent is its own key, its `at` and `parentStart` 0, and its `copy` its own count.
 */
export interface DrawnNode {
	readonly parent: Owner
	readonly at: number
	readonly children: number
	readonly start: number
	readonly end: number
	readonly parentStart: number
	readonly copy: number
	readonly node: TreeNode
}

/** A node met by the walk: the node, and where its parent and its place among its siblings put it. */
interface Met {
	readonly node: TreeNode
	/** Its parent's pre-order position, none for the root. */
	readonly parent: number | undefined
	readonly at: number
}

/**
 * Every node of the tree under `root`, drawn, in pre-order: one iterative pass (no recursion, so any depth walks)
 * numbers the nodes as it meets them, and one pass back over that numbering, children before parents, sums each
 * subtree's size into its parent's. A node's `start` is its pre-order position and its `end` its start plus its
 * subtree's size.
 */
export const walk = (root: TreeNode): ReadonlyArray<DrawnNode> => {
	const met: Array<Met> = []
	const pending: Array<Met> = [{ node: root, parent: undefined, at: 0 }]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		const position = met.length
		met.push(next)
		const children = next.node.children
		for (let at = children.length - 1; at >= 0; at -= 1) {
			const child = children[at]
			if (child !== undefined) {
				pending.push({ node: child, parent: position, at })
			}
		}
	}
	/** Each node's subtree size: every node's parent precedes it in pre-order, so a pass from the last node to the
	 * first has summed a node's whole subtree before it adds the node to its parent's. */
	const sizes = met.map(() => 1)
	for (let position = met.length - 1; position > 0; position -= 1) {
		const parent = met[position]?.parent
		if (parent !== undefined) {
			sizes[parent] = (sizes[parent] ?? 1) + (sizes[position] ?? 1)
		}
	}
	return met.map((m, start): DrawnNode => {
		const parent = m.parent === undefined ? undefined : met[m.parent]
		return Object.freeze({
			parent: parent === undefined ? m.node.key : parent.node.key,
			at: m.at,
			children: m.node.children.length,
			start,
			end: start + (sizes[start] ?? 1),
			parentStart: m.parent ?? 0,
			copy: parent === undefined ? m.node.children.length : parent.node.children.length,
			node: m.node
		})
	})
}
