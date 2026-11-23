/**
 * The rows of trees.md's tree relation as a writer sends them, and the trees test/pg/fin draws and loads: every tree and
 * two-tree forest of a bounded size (forestsOf), a tree of a given size and fanout (loadTree), and a tree's rows by
 * depth (rowsByDepth).
 *
 * A tree relation `node (id, root, parent, at, children, start, end)` is the ordered family of node over itself,
 * `node(parent, at)` counted by `fin(node, children)`, whose every row carries its pre-order interval `[start, end)`,
 * one tree per value of `root`, its root the one self-parented row. Each row also carries two copies of its parent's
 * fields, which the parent copy holds to the parent's values: its count ‹n› and its start, which T3's check reads. The
 * root copies itself.
 */
import { indices, maxOf } from "@bjornpagen/grizzle-text/base/array"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Order } from "effect"
import { upTo } from "#test/support/up-to.ts"

/**
 * One row of the tree relation as a writer sends it: its fields, and the two copies the host draws from its parent's
 * row, which the merged parent copy holds to the parent's values.
 */
export interface TreeRow {
	readonly id: number
	/** The tree's root field, copied down from the parent. */
	readonly root: number
	readonly parent: number
	readonly at: number
	readonly children: number
	readonly start: number
	readonly end: number
	/** ‹n›: the parent's `children`. */
	readonly copy: number
	/** The parent's `start`, which T3's check reads. */
	readonly parentStart: number
}

/** A row without its copies, which withCopies draws from its parent's row. */
type Bare = Omit<TreeRow, "copy" | "parentStart">

/** Rows with each copy its parent's count and start, as the host draws them, every parent a row of `rows`. */
const withCopies = (rows: Arr.NonEmptyReadonlyArray<Bare>): Arr.NonEmptyReadonlyArray<TreeRow> =>
	Arr.map(rows, (r) => {
		const parent = Arr.findFirst(rows, (p) => p.id === r.parent)
		return {
			...r,
			copy: Option.match(parent, { onNone: () => 0, onSome: (p) => p.children }),
			parentStart: Option.match(parent, { onNone: () => 0, onSome: (p) => p.start })
		}
	})

/**
 * The rows of the plane tree a pre-order depth sequence draws, built by construction rather than by the checker's
 * walk: each row's id `first` plus its pre-order index, its start that index, its parent the last row one shallower,
 * its slot its rank among its parent's children, and its end the index of the next row as shallow as it, or N.
 */
const treeOf = (
	depths: Arr.NonEmptyReadonlyArray<number>,
	root: number,
	first: number
): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const n = depths.length
	const depth = (i: number) => Arr.getUnsafe(depths, i)
	const parentOf = (i: number): number =>
		Option.getOrElse(
			Arr.findLast(indices(i), (j) => depth(j) === depth(i) - 1),
			() => i
		)
	const endOf = (i: number): number =>
		Option.getOrElse(
			Arr.findFirst(indices(n), (j) => j > i && depth(j) <= depth(i)),
			() => n
		)
	const childrenOf = (i: number) => Arr.filter(indices(n), (j) => j !== i && parentOf(j) === i)
	return withCopies(
		Arr.map(depths, (_, i) => ({
			id: first + i,
			root,
			parent: first + parentOf(i),
			at: i === 0 ? 0 : Arr.filter(childrenOf(parentOf(i)), (j) => j < i).length,
			children: childrenOf(i).length,
			start: i,
			end: endOf(i)
		}))
	)
}

/**
 * Every plane tree's pre-order depth sequence of 1 to `most` rows: the root at depth 0, and each next row one deeper
 * than the row before it or as shallow as depth 1, so each tree is drawn once, Catalan(N − 1) of N rows.
 */
const depthsOf = (most: number): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> => {
	const sequences = (
		prefix: Arr.NonEmptyReadonlyArray<number>,
		n: number
	): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> =>
		prefix.length === n
			? [prefix]
			: Arr.flatMap(
					upTo(Arr.lastNonEmpty(prefix) + 1, (i) => i + 1),
					(d) => sequences(Arr.append(prefix, d), n)
				)
	return Arr.flatMap(
		upTo(most, (i) => i + 1),
		(n) => sequences([0], n)
	)
}

/**
 * Every tree of at most `most` rows, of root value 0, and every forest of two such trees of at most `most` rows in
 * all, the second of root value 1, one per pair up to swapping the two.
 */
export const forestsOf = (
	most: number
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> => {
	const depths = depthsOf(most)
	return nonEmpty(
		[
			...Arr.map(depths, (d) => treeOf(d, 0, 0)),
			...Arr.flatMap(depths, (a, i) =>
				Arr.flatMap(depths, (b, j) =>
					j >= i && a.length + b.length <= most
						? [Arr.appendAll(treeOf(a, 0, 0), treeOf(b, 1, a.length))]
						: []
				)
			)
		],
		"a forest of one tree"
	)
}

/** A tree of `rows` rows in breadth-first numbering, every row with up to `fanout` children, its rows in pre-order. */
export const loadTree = (rows: number, fanout: number): Arr.NonEmptyReadonlyArray<TreeRow> => {
	const parentOf = (i: number) => (i === 0 ? 0 : Math.floor((i - 1) / fanout))
	const kidsOf = (i: number) =>
		Arr.filter(
			upTo(fanout, (k) => i * fanout + 1 + k),
			(k) => k < rows
		)
	const sizes = upTo(rows, () => 1)
	for (let i = rows - 1; i > 0; i -= 1) {
		sizes[parentOf(i)] = defined(sizes[parentOf(i)]) + defined(sizes[i])
	}
	/** Pre-order starts, top-down: a first child one past its parent, each next one past its predecessor's subtree. */
	const starts = upTo(rows, () => 0)
	for (let i = 0; i < rows; i += 1) {
		let next = defined(starts[i]) + 1
		for (const k of kidsOf(i)) {
			starts[k] = next
			next += defined(sizes[k])
		}
	}
	return withCopies(
		nonEmpty(
			Arr.sort(
				upTo(rows, (i): Bare => ({
					id: i,
					root: 0,
					parent: parentOf(i),
					at: i === 0 ? 0 : (i - 1) % fanout,
					children: kidsOf(i).length,
					start: defined(starts[i]),
					end: defined(starts[i]) + defined(sizes[i])
				})),
				Order.mapInput(Order.Number, (r: Bare) => r.start)
			),
			"a tree holds its root"
		)
	)
}

/**
 * The rows of one tree by depth, the root's alone first: each row one deeper than its parent, read in pre-order, which
 * puts every parent before its children.
 */
export const rowsByDepth = (
	rows: Arr.NonEmptyReadonlyArray<TreeRow>
): Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<TreeRow>> => {
	const depths = new Map<number, number>()
	for (const r of rows) {
		depths.set(r.id, r.parent === r.id ? 0 : defined(depths.get(r.parent), "a parent's depth") + 1)
	}
	const deepest = maxOf(depths.values(), 0)
	return nonEmpty(
		upTo(deepest + 1, (depth) =>
			nonEmpty(
				Arr.filter(rows, (r) => depths.get(r.id) === depth),
				`a row at depth ${depth}`
			)
		),
		"the root's depth"
	)
}
