/**
 * The rows of trees.md's tree relation as a writer sends them, and the tree test/pg/fin loads: a tree of a given size
 * and fanout (loadTree), and a tree's rows by depth (rowsByDepth).
 *
 * A tree relation `node (id, root, parent, at, children, start, end)` is the ordered family of node over itself,
 * `node(parent, at)` counted by `fin(node, children)`, whose every row carries its pre-order interval `[start, end)`,
 * one tree per value of `root`, its root the one self-parented row. Each row also carries its successor ‹s› among its
 * siblings, the slot after its own below its parent's count and its own slot at its parent's last child, the root's its
 * slot, 0; and a copy of its parent's start, which T3's check reads, the root's its own.
 */
import { maxOf } from "@bjornpagen/grizzle-text/base/array"
import { defined, nonEmpty } from "@bjornpagen/testing/assert"
import { Array as Arr, Option, Order } from "effect"
import { upTo } from "#test/support/up-to.ts"

/**
 * One row of the tree relation as a writer sends it: its fields, and what the host draws from its parent's row: its
 * successor among its parent's children and its parent's start.
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
	/** ‹s›: the slot after `at` below the parent's `children`, else `at`, the last child's and the root's. */
	readonly next: number
	/** The parent's `start`, which T3's check reads. */
	readonly parentStart: number
}

/** A row without what withCopies draws from its parent's row. */
type Bare = Omit<TreeRow, "next" | "parentStart">

/** Rows with each successor and parent's start as the host draws them from the parent, every parent a row of `rows`. */
const withCopies = (rows: Arr.NonEmptyReadonlyArray<Bare>): Arr.NonEmptyReadonlyArray<TreeRow> =>
	Arr.map(rows, (r) => {
		const parent = Arr.findFirst(rows, (p) => p.id === r.parent)
		return {
			...r,
			next: Option.match(parent, {
				onNone: () => r.at,
				onSome: (p) => (p.id !== r.id && r.at + 1 < p.children ? r.at + 1 : r.at)
			}),
			parentStart: Option.match(parent, { onNone: () => 0, onSome: (p) => p.start })
		}
	})

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
