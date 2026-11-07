/**
 * The tree theorem as grizzle lowers it (trees.md, w4-w7 §2.2): a tree relation's rows, the direct pre-order numbering
 * every test judges them by, and the model of what PostgreSQL does with each transaction of them under grizzle's
 * natives.
 *
 * A tree relation T(id, r, parent, at, children, start, end) is the ordered family of T over itself, its members every
 * row but the root (φ₀ = `start > 0`), with two drawn law columns beside the fields: ‹n› (`copy`), the parent's count,
 * and ‹ps› (`parentStart`), the parent's start. Its generated law columns are read off the row: ‹parent₀› = `CASE WHEN
 * start > 0 THEN parent END`, ‹p› = `CASE WHEN at > 0 AND at < ‹n› THEN at − 1 END` and ‹pn› = `CASE WHEN children > 0
 * THEN children − 1 END`. grizzle's natives, each with the role a test names it by (`TreeNative`):
 *
 * - `identity`, the primary key (id); `family key`, UNIQUE (‹parent₀›, at); `document order`, T1's UNIQUE (r, start);
 *   the owner axis's target superkey UNIQUE (id, children, start, r) and the member superkey UNIQUE (‹parent₀›, at, end)
 *   the predecessor and last axes share;
 * - `bound`, CHECK (start = 0 OR at < ‹n›); `root`, T2's CHECK ((parent = id) = (start = 0)); `root pin`, CHECK (start >
 *   0 OR at = 0); `first child`, T3's CHECK (start = 0 OR at > 0 OR start = ‹ps› + 1);
 *   `interval`, T6's CHECK (end > start AND (children > 0 OR end = start + 1));
 * - `owner axis`, FOREIGN KEY (parent, ‹n›, ‹ps›, r) REFERENCES T (id, children, start, r), NO ACTION,
 *   immediate, from the plain parent: the family's copy, T3's ‹ps› and T0's root copy, the root referencing itself, so
 *   its ‹n› is its own count and its ‹ps› its own start; `predecessor axis`, FOREIGN KEY (‹parent₀›, ‹p›, start)
 *   REFERENCES T (‹parent₀›, at, end), immediate: the closure and T4; `last axis`, FOREIGN KEY (id, ‹pn›, end)
 *   REFERENCES T (‹parent₀›, at, end), deferred: the last slot and T5.
 *
 * Every native is NULLS DISTINCT or MATCH SIMPLE, so a NULL in any column takes a row out of it: the root, whose
 * ‹parent₀› is NULL, holds no slot and no sibling's reference, its own copies are held by its owner axis to itself,
 * and its pin holds its slot at 0.
 *
 * A row is the substrate proof's TreeRow (test/pg/substrate/tree.ts), one definition for both. The oracle is a second
 * implementation of the theorem: the forest a state's parent links and slots describe, numbered by a naive recursive
 * pre-order walk (`numbered`). A state is lawful exactly when it is that numbering of the forest it describes
 * (`treeBreachOf`). The lowering model (`treePredicted`) is the third reading: each native checked at its moment, a
 * statement's end or COMMIT. A lowering may drop a pair or a pin (`TreeLowering`), the mutants a box must kill.
 *
 * Both stand beside the substrate's breachOf and predicted under names of their own because they judge another
 * lowering: grizzle's root pin holds the root at slot 0, which the substrate's RFC lowering leaves free, so
 * `treeBreachOf` refuses a root's at that breachOf accepts; and grizzle's natives are not the substrate's DDL (the
 * members selected by start > 0 rather than parent ≠ id, and the root pin), so `treePredicted` models those.
 */
import { Array as Arr, Option, Order, Result } from "effect"
import type { TreeRow } from "#test/pg/substrate/tree.ts"
import type { Moment, Timing } from "#test/support/families/mutate.ts"

/** A tree as its caller nests it: a node's key and its children in slot order. */
export interface Node {
	readonly id: number
	readonly children: ReadonlyArray<Node>
}

/** One tree under its root field's value. */
export interface Rooted {
	readonly root: number
	readonly tree: Node
}

/** Trees of distinct root values, in ascending order of root value. */
export type Forest = ReadonlyArray<Rooted>

/**
 * The direct pre-order numbering of a forest: a naive recursive walk of each tree, a node's start its pre-order
 * position, its end its start plus its subtree's size, its `at` its slot, ‹n› its parent's count and ‹ps› its parent's
 * start; the root self-parented at slot 0, its ‹n› its own count and its ‹ps› 0. Rows come in each tree's pre-order,
 * the trees in the forest's order.
 */
export const numbered = (forest: Forest): ReadonlyArray<TreeRow> =>
	Arr.flatMap(forest, ({ root, tree }) => {
		const rows: Array<TreeRow> = []
		const size = (node: Node): number =>
			Arr.reduce(node.children, 1, (sum, child) => sum + size(child))
		const visit = (
			node: Node,
			parent:
				| { readonly id: number; readonly children: number; readonly start: number }
				| undefined,
			at: number,
			start: number
		): void => {
			rows.push({
				id: node.id,
				root,
				parent: parent?.id ?? node.id,
				at,
				children: node.children.length,
				start,
				end: start + size(node),
				copy: parent?.children ?? node.children.length,
				parentStart: parent?.start ?? 0
			})
			let next = start + 1
			for (const [slot, child] of node.children.entries()) {
				visit(child, { id: node.id, children: node.children.length, start }, slot, next)
				next += size(child)
			}
		}
		visit(tree, undefined, 0, 0)
		return rows
	})

/**
 * Why a state is no forest of numbered trees, the first of these its rows show:
 *
 * - `a duplicate id`, two rows of one key; `an orphan`, a parent that is no row;
 * - `no root` or `two roots`, a root value without one self-parented row or with two;
 * - `a cycle`, a row whose parent links circle without reaching a root; `a row under another tree`, one whose links
 *   reach the root of another root value;
 * - `a family`, a row whose children's slots are not exactly 0 … count − 1;
 * - `a root's at`, a root at a slot other than 0, which the root pin refuses and the theorem's family says nothing of;
 * - `a copy` or `an interval`, a row whose ‹n›, ‹ps›, start or end differs from the numbering's.
 */
export type NumberingBreach =
	| "a duplicate id"
	| "an orphan"
	| "no root"
	| "two roots"
	| "a cycle"
	| "a row under another tree"
	| "a family"
	| "a root's at"
	| "a copy"
	| "an interval"

/**
 * The forest a state describes, read off its parent links and slots alone, independent of every interval and copy, or
 * the first breach (NumberingBreach) that leaves it none: each root value's one self-parented row, every row reached from
 * it through rows of its own value, each row's children in slot order, exactly 0 … count − 1.
 */
const forestOf = (rows: ReadonlyArray<TreeRow>): Result.Result<Forest, NumberingBreach> => {
	const byId = new Map<number, TreeRow>()
	for (const row of rows) {
		if (byId.has(row.id)) {
			return Result.fail("a duplicate id")
		}
		byId.set(row.id, row)
	}
	if (Arr.some(rows, (r) => !byId.has(r.parent))) {
		return Result.fail("an orphan")
	}
	const values = Arr.sort(Arr.dedupe(Arr.map(rows, (r) => r.root)), Order.Number)
	const rootsOf = (value: number) => Arr.filter(rows, (r) => r.root === value && r.parent === r.id)
	if (Arr.some(values, (v) => rootsOf(v).length === 0)) {
		return Result.fail("no root")
	}
	if (Arr.some(values, (v) => rootsOf(v).length > 1)) {
		return Result.fail("two roots")
	}
	const childrenOf = (row: TreeRow): ReadonlyArray<TreeRow> =>
		Arr.sort(
			Arr.filter(rows, (r) => r.parent === row.id && r.id !== row.id),
			Order.mapInput(Order.Number, (r: TreeRow) => r.at)
		)
	/** Every row of a root value its root reaches through rows of that value, each once. */
	const reached = new Set<number>()
	for (const value of values) {
		const pending = [...rootsOf(value)]
		for (let row = pending.pop(); row !== undefined; row = pending.pop()) {
			if (!reached.has(row.id)) {
				reached.add(row.id)
				for (const c of childrenOf(row)) {
					if (c.root === value) {
						pending.push(c)
					}
				}
			}
		}
	}
	/** Whether a row's parent links reach a self-parented row before they circle. */
	const rooted = (row: TreeRow): boolean => {
		let at = row
		for (let step = 0; step <= rows.length; step += 1) {
			if (at.parent === at.id) {
				return true
			}
			at = byId.get(at.parent) ?? at
		}
		return false
	}
	const stray = Arr.findFirst(rows, (r) => !reached.has(r.id))
	if (Option.isSome(stray)) {
		return Result.fail(rooted(stray.value) ? "a row under another tree" : "a cycle")
	}
	if (
		Arr.some(rows, (r) => {
			const kids = childrenOf(r)
			return r.children !== kids.length || Arr.some(kids, (k, i) => k.at !== i)
		})
	) {
		return Result.fail("a family")
	}
	const nodeOf = (row: TreeRow): Node => ({
		id: row.id,
		children: Arr.map(childrenOf(row), nodeOf)
	})
	return Result.succeed(
		Arr.map(values, (root) => ({ root, tree: nodeOf(Arr.getUnsafe(rootsOf(root), 0)) }))
	)
}

/**
 * The theorem as a checker: none when the state is exactly the direct pre-order numbering of the forest its parent
 * links describe (one tree per root value, every row reachable, the root at slot 0, every copy its parent's and every
 * interval its pre-order interval), and otherwise the breach that shows it is not.
 */
export const treeBreachOf = (rows: ReadonlyArray<TreeRow>): Option.Option<NumberingBreach> => {
	const forest = forestOf(rows)
	if (Result.isFailure(forest)) {
		return Option.some(forest.failure)
	}
	const want = new Map(Arr.map(numbered(forest.success), (r) => [r.id, r] as const))
	const differs = (pick: (r: TreeRow) => ReadonlyArray<number>) =>
		Arr.some(rows, (r) => {
			const w = want.get(r.id)
			return w === undefined || Arr.some(pick(r), (v, i) => v !== Arr.getUnsafe(pick(w), i))
		})
	if (differs((r) => (r.parent === r.id ? [r.at] : []))) {
		return Option.some("a root's at")
	}
	if (differs((r) => [r.copy, r.parentStart])) {
		return Option.some("a copy")
	}
	if (differs((r) => [r.start, r.end])) {
		return Option.some("an interval")
	}
	return Option.none()
}

/**
 * A native of grizzle's tree lowering, by the role a test names it by (the header lists each). Every one is the tree
 * statement's law: a refusal by any of them names it.
 */
export type TreeNative =
	| "identity"
	| "family key"
	| "document order"
	| "owner superkey"
	| "member superkey"
	| "bound"
	| "root"
	| "root pin"
	| "first child"
	| "interval"
	| "owner axis"
	| "predecessor axis"
	| "last axis"

/** Every native, in the order the model checks them. */
const TREE_NATIVES: Arr.NonEmptyReadonlyArray<TreeNative> = [
	"identity",
	"family key",
	"document order",
	"owner superkey",
	"member superkey",
	"bound",
	"root",
	"root pin",
	"first child",
	"interval",
	"owner axis",
	"predecessor axis",
	"last axis"
]

/**
 * A lowering of the tree: grizzle's, or a mutant of it with one pair or pin dropped, which a box must find out:
 *
 * - `rootCopy`, T0's r → r pair on the owner axis (P3's counterexample is what its drop admits);
 * - `lastEnd`, T5's end → end pair on the last axis (a parent whose last child ends early);
 * - `rootPin`, the root's pin (a root at a slot other than 0, the slot the root's family never holds).
 */
export interface TreeLowering {
	readonly rootCopy: boolean
	readonly lastEnd: boolean
	readonly rootPin: boolean
}

/** grizzle's lowering: every pair and pin of §2.2. */
export const grizzleTree: TreeLowering = { rootCopy: true, lastEnd: true, rootPin: true }

/** The SQLSTATE PostgreSQL refuses a native's violation with: 23505 a unique, 23514 a check, 23503 a foreign key. */
export const treeSqlstate = (native: TreeNative): "23505" | "23514" | "23503" => {
	switch (native) {
		case "identity":
		case "family key":
		case "document order":
		case "owner superkey":
		case "member superkey":
			return "23505"
		case "bound":
		case "root":
		case "root pin":
		case "first child":
		case "interval":
			return "23514"
		case "owner axis":
		case "predecessor axis":
		case "last axis":
			return "23503"
	}
}

/** When PostgreSQL checks a native: the last axis at COMMIT (the owner ↔ family cycle), every other at its statement. */
const treeTiming = (native: TreeNative): Timing => (native === "last axis" ? "commit" : "statement")

/** A native a state breaks, on the row whose key, check or reference it is. */
export interface TreeViolation {
	readonly native: TreeNative
	readonly id: number
}

/** A column a native reads: a value, or NULL. */
type Cell = number | undefined

/** ‹parent₀›: the row's parent where it is a member (start > 0), NULL at the root. */
const parent0 = (r: TreeRow): Cell => (r.start > 0 ? r.parent : undefined)

/** ‹p›: the predecessor's slot, below the copy. */
const predecessor = (r: TreeRow): Cell => (r.at > 0 && r.at < r.copy ? r.at - 1 : undefined)

/** ‹pn›: the last slot of the row's own children. */
const lastSlot = (r: TreeRow): Cell => (r.children > 0 ? r.children - 1 : undefined)

/** Whether two tuples are equal with no NULL in either: NULLS DISTINCT and MATCH SIMPLE alike. */
const sameTuple = (a: ReadonlyArray<Cell>, b: ReadonlyArray<Cell>): boolean =>
	a.length === b.length && Arr.every(a, (x, i) => x !== undefined && x === b[i])

/**
 * Every native of a lowering the rows break, whenever PostgreSQL checks it: a unique two rows hold with no NULL, a
 * CHECK that is false, and a reference with no NULL whose target no row holds.
 */
const treeViolations = (
	lowering: TreeLowering,
	rows: ReadonlyArray<TreeRow>
): ReadonlyArray<TreeViolation> => {
	const keyOf = (native: TreeNative, r: TreeRow): ReadonlyArray<Cell> => {
		switch (native) {
			case "identity":
				return [r.id]
			case "family key":
				return [parent0(r), r.at]
			case "document order":
				return [r.root, r.start]
			case "owner superkey":
				return lowering.rootCopy ? [r.id, r.children, r.start, r.root] : [r.id, r.children, r.start]
			case "member superkey":
				return [parent0(r), r.at, r.end]
			case "bound":
			case "root":
			case "root pin":
			case "first child":
			case "interval":
			case "owner axis":
			case "predecessor axis":
			case "last axis":
				return []
		}
	}
	const holds = (native: TreeNative, r: TreeRow): boolean => {
		switch (native) {
			case "identity":
			case "family key":
			case "document order":
			case "owner superkey":
			case "member superkey":
				return !Arr.some(rows, (o) => o !== r && sameTuple(keyOf(native, r), keyOf(native, o)))
			case "bound":
				return r.start === 0 || r.at < r.copy
			case "root":
				return (r.parent === r.id) === (r.start === 0)
			case "root pin":
				return !lowering.rootPin || r.start > 0 || r.at === 0
			case "first child":
				return r.start === 0 || r.at > 0 || r.start === r.parentStart + 1
			case "interval":
				return r.end > r.start && (r.children > 0 || r.end === r.start + 1)
			case "owner axis": {
				const wanted = [r.parent, r.copy, r.parentStart, ...(lowering.rootCopy ? [r.root] : [])]
				return Arr.some(rows, (o) =>
					sameTuple(wanted, [o.id, o.children, o.start, ...(lowering.rootCopy ? [o.root] : [])])
				)
			}
			case "predecessor axis": {
				const wanted = [parent0(r), predecessor(r), r.start]
				return (
					Arr.some(wanted, (c) => c === undefined) ||
					Arr.some(rows, (o) => sameTuple(wanted, [parent0(o), o.at, o.end]))
				)
			}
			case "last axis": {
				const wanted = [r.id, lastSlot(r), ...(lowering.lastEnd ? [r.end] : [])]
				return (
					Arr.some(wanted, (c) => c === undefined) ||
					Arr.some(rows, (o) =>
						sameTuple(wanted, [parent0(o), o.at, ...(lowering.lastEnd ? [o.end] : [])])
					)
				)
			}
		}
	}
	return Arr.flatMap(TREE_NATIVES, (native) =>
		Arr.flatMap(rows, (r): ReadonlyArray<TreeViolation> =>
			holds(native, r) ? [] : [{ native, id: r.id }]
		)
	)
}

/**
 * One statement a tree's writer sends: an INSERT of rows in the order listed, or the DELETE of every row of the given
 * root values, the one statement that removes a tree written whole.
 */
export type TreeStatement =
	| { readonly kind: "insert"; readonly rows: Arr.NonEmptyReadonlyArray<TreeRow> }
	| { readonly kind: "deleteTree"; readonly roots: Arr.NonEmptyReadonlyArray<number> }

/** The rows a statement leaves, before any native is checked. */
const treeApplied = (
	rows: ReadonlyArray<TreeRow>,
	statement: TreeStatement
): ReadonlyArray<TreeRow> =>
	statement.kind === "insert"
		? Arr.appendAll(rows, statement.rows)
		: Arr.filter(rows, (r) => !statement.roots.includes(r.root))

/** What the model says PostgreSQL does with a transaction: it commits to rows, or is refused at a moment by any of a set. */
export type TreePredicted =
	| { readonly kind: "committed"; readonly after: ReadonlyArray<TreeRow> }
	| {
			readonly kind: "refused"
			readonly moment: Moment
			readonly violations: Arr.NonEmptyReadonlyArray<TreeViolation>
	  }

/**
 * The model of one transaction of statements over committed rows `before`: after each statement every native checked
 * at a statement must hold of the whole state, which is PostgreSQL's check of the rows that statement touched since
 * the state before broke none; at COMMIT the deferred last axis must hold too. PostgreSQL reports one violation of the
 * set, which one depending on an order of rows and constraints it does not promise.
 */
export const treePredicted = (
	lowering: TreeLowering,
	before: ReadonlyArray<TreeRow>,
	statements: ReadonlyArray<TreeStatement>
): TreePredicted => {
	let state = before
	for (const [index, statement] of statements.entries()) {
		state = treeApplied(state, statement)
		const broken = Arr.filter(
			treeViolations(lowering, state),
			(v) => treeTiming(v.native) === "statement"
		)
		if (Arr.isReadonlyArrayNonEmpty(broken)) {
			return { kind: "refused", moment: { kind: "statement", index }, violations: broken }
		}
	}
	const deferred = treeViolations(lowering, state)
	return Arr.isReadonlyArrayNonEmpty(deferred)
		? { kind: "refused", moment: { kind: "commit" }, violations: deferred }
		: { kind: "committed", after: state }
}

/**
 * A row's descendants through the parent links, itself excluded: the rows a descendants read must return, judged
 * independently of the intervals the read filters by.
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
