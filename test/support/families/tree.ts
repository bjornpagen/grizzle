/**
 * The keyed tree as grizzle lowers it, and the direct pre-order numbering every test judges its rows by.
 *
 * A tree relation T(r…, parent, at, children, start, end) is keyed by its root fields r… then its drawn `start`: each
 * value of r… is one tree, its root the row at start 0, its `parent` the parent's start in the same tree (the root's
 * own, 0). It is the ordered family of T over itself whose group (r…, parent) pairs with the key (r…, start), its
 * members every row but the roots (`start > 0`), with ‹n› (`copy`), the parent's count, a drawn law column beside the
 * fields. grizzle's natives, each with the role a test names it by (`TreeNative`):
 *
 * - `identity` and `document order`, the primary key (r…, start); `family key`, UNIQUE (r…, ‹parent₀›, at); the owner
 *   axis's target superkey UNIQUE (r…, start, children) and the member superkey UNIQUE (r…, ‹parent₀›, at, end) the
 *   predecessor and last axes share;
 * - the tree's CHECK: the bound (start = 0 OR at < ‹n›), T2 ((parent = start) = (start = 0)), the root pin (start > 0
 *   OR at = 0), T3 (start = 0 OR at > 0 OR start = parent + 1) and T6 (end > start AND (children > 0 OR end = start +
 *   1));
 * - `owner axis`, FOREIGN KEY (r…, parent, ‹n›, …) REFERENCES T (r…, start, children, …) from the plain group, each root
 *   referencing itself; `predecessor axis`, FOREIGN KEY (r…, ‹parent₀›, ‹p›, start) REFERENCES T (r…, ‹parent₀›, at,
 *   end); `last axis`, FOREIGN KEY (r…, start, ‹pn›, end) REFERENCES T (r…, ‹parent₀›, at, end), deferred.
 *
 * The oracle is a second implementation of the theorem: a forest numbered by a naive recursive pre-order walk
 * (`numbered`), and the forest a state's rows describe, read off their keys, parent links and slots alone (`forestOf`),
 * so a state is lawful exactly when it is the numbering of the forest it describes (`lawful`).
 */
import { Array as Arr, Option, Order } from "effect"
import type { TreeRow } from "#test/pg/substrate/tree.ts"
import { deepEquals } from "#test/support/assert.ts"

/** A tree as its caller nests it: a node's kind and its children in slot order. */
export interface Node {
	readonly kind: number
	readonly children: ReadonlyArray<Node>
}

/** One tree under its root value, the tuple of its root fields' values, each its text. */
export interface Rooted {
	readonly root: ReadonlyArray<string>
	readonly tree: Node
}

/** Trees of distinct root values. */
export type Forest = ReadonlyArray<Rooted>

/**
 * The tree the testing library's `parents` draws, its nodes numbered from the root, entry `i` the parent of node `i + 1`,
 * each node's children in their numbers' order and each node's kind its entry in `kinds`, 0 past their end.
 */
export const treeOfParents = (
	parentOf: ReadonlyArray<number>,
	kinds: ReadonlyArray<number>
): Node => {
	const nodeAt = (node: number): Node => ({
		kind: kinds[node] ?? 0,
		children: Arr.flatMap(parentOf, (p, i) => (p === node ? [nodeAt(i + 1)] : []))
	})
	return nodeAt(0)
}

/**
 * One row of a keyed tree: its root value, its parent's start (a root's own, 0), its slot, its count, its pre-order
 * interval, ‹n› its parent's count (a root's own), its kind, its parent's kind (a root's own) and the sum of its
 * children's kinds.
 */
export interface KeyedRow {
	readonly root: ReadonlyArray<string>
	readonly parent: number
	readonly at: number
	readonly children: number
	readonly start: number
	readonly end: number
	readonly copy: number
	readonly kind: number
	readonly parentKind: number
	readonly total: number
}

/** A node's subtree's size, itself included. */
const sizeOf = (node: Node): number =>
	Arr.reduce(node.children, 1, (sum, child) => sum + sizeOf(child))

/**
 * The direct pre-order numbering of a forest: a naive recursive walk of each tree, a node's start its pre-order
 * position, its end its start plus its subtree's size, its `at` its slot, its parent its parent's start, ‹n› and its
 * parent's kind its parent's, and its total the sum of its children's kinds; each root self-parented at slot 0, its ‹n›
 * its own count and its parent's kind its own. Rows come in each tree's pre-order, the trees in the forest's order.
 */
export const numbered = (forest: Forest): ReadonlyArray<KeyedRow> =>
	Arr.flatMap(forest, ({ root, tree }) => {
		const rows: Array<KeyedRow> = []
		const visit = (
			node: Node,
			parent:
				| { readonly start: number; readonly children: number; readonly kind: number }
				| undefined,
			at: number,
			start: number
		): void => {
			rows.push({
				root,
				parent: parent?.start ?? start,
				at,
				children: node.children.length,
				start,
				end: start + sizeOf(node),
				copy: parent?.children ?? node.children.length,
				kind: node.kind,
				parentKind: parent?.kind ?? node.kind,
				total: Arr.reduce(node.children, 0, (sum, child) => sum + child.kind)
			})
			let next = start + 1
			for (const [slot, child] of node.children.entries()) {
				visit(child, { start, children: node.children.length, kind: node.kind }, slot, next)
				next += sizeOf(child)
			}
		}
		visit(tree, undefined, 0, 0)
		return rows
	})

/** Whether two root values are one. */
const sameRoot = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x === b[i])

/**
 * The forest a state describes, read off its root values, starts, parent links and slots alone, independent of every
 * interval, count and copy: for each root value its one row at start 0, its own parent, each row's children the rows of
 * its root value whose parent is its start, in slot order, exactly 0 … count − 1, every row reached once. None where
 * the rows describe no forest.
 */
export const forestOf = (rows: ReadonlyArray<KeyedRow>): Option.Option<Forest> => {
	const roots = Arr.dedupeWith(
		Arr.map(rows, (r) => r.root),
		sameRoot
	)
	const reached = new Set<KeyedRow>()
	const nodeOf = (row: KeyedRow, depth: number): Option.Option<Node> => {
		if (reached.has(row) || depth > rows.length) {
			return Option.none()
		}
		reached.add(row)
		const kids = Arr.sort(
			Arr.filter(rows, (r) => r.start > 0 && sameRoot(r.root, row.root) && r.parent === row.start),
			Order.mapInput(Order.Number, (r: KeyedRow) => r.at)
		)
		if (Arr.some(kids, (k, i) => k.at !== i)) {
			return Option.none()
		}
		const children = Arr.map(kids, (k) => nodeOf(k, depth + 1))
		return Arr.every(children, Option.isSome)
			? Option.some({ kind: row.kind, children: Arr.getSomes(children) })
			: Option.none()
	}
	const trees = Arr.map(roots, (root) => {
		const at0 = Arr.filter(rows, (r) => sameRoot(r.root, root) && r.start === 0)
		const [only, ...more] = at0
		return only === undefined || more.length > 0 || only.parent !== 0
			? Option.none()
			: Option.map(nodeOf(only, 0), (tree): Rooted => ({ root, tree }))
	})
	return Arr.every(trees, Option.isSome) && reached.size === rows.length
		? Option.some(Arr.getSomes(trees))
		: Option.none()
}

/** The order rows compare in as a set: by root value, then start. */
const byKey: Order.Order<KeyedRow> = Order.combine(
	Order.mapInput(Arr.makeOrder(Order.String), (r: KeyedRow) => r.root),
	Order.mapInput(Order.Number, (r: KeyedRow) => r.start)
)

/** A state's rows in key order, compared as a set. */
export const canonicalRows = (rows: ReadonlyArray<KeyedRow>): ReadonlyArray<KeyedRow> =>
	Arr.sort(rows, byKey)

/**
 * The theorem as a checker: a state is lawful exactly when it is the direct pre-order numbering of the forest its keys
 * and parent links describe, in every field `view` reads of a row, the fields its relation holds: its slots, counts,
 * intervals and whatever copies and folds it states.
 */
export const lawful = (rows: ReadonlyArray<KeyedRow>, view: (row: KeyedRow) => unknown): boolean =>
	Option.match(forestOf(rows), {
		onNone: () => false,
		onSome: (forest) =>
			deepEquals(Arr.map(canonicalRows(numbered(forest)), view), Arr.map(canonicalRows(rows), view))
	})

/**
 * A native of grizzle's tree lowering, by the role a test names it by (the header lists each). Every one is the tree
 * statement's law but the primary key: a refusal by any of them names it.
 */
export type TreeNative =
	| "identity"
	| "family key"
	| "document order"
	| "owner superkey"
	| "member superkey"
	| "owner axis"
	| "predecessor axis"
	| "last axis"

/**
 * A row's descendants through the substrate's parent links, itself excluded: the rows a descendants read must return,
 * judged independently of the intervals the read filters by.
 */
export const descendantsOf = (rows: ReadonlyArray<TreeRow>, id: number): ReadonlyArray<number> => {
	const kids = new Map<number, Array<number>>()
	for (const r of rows) {
		if (r.parent !== r.id) {
			kids.set(r.parent, [...(kids.get(r.parent) ?? []), r.id])
		}
	}
	const found = new Set<number>()
	const pending = [...(kids.get(id) ?? [])]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (next !== id && !found.has(next)) {
			found.add(next)
			for (const k of kids.get(next) ?? []) {
				pending.push(k)
			}
		}
	}
	return [...found]
}
