import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	drawnNatural,
	type HostFacts,
	lawOfShape,
	schemaOf,
	theoryOf,
	uuidOf,
	violates
} from "#test/unit/analysis/theory/support.ts"

/**
 * The tree theorem through the theory (trees.md §2, w4-w7 §2.2): a tree's law, its family's lemmas over every row but
 * its root and T0 to T6 with the root pin, evaluated by the reference evaluator, is violated exactly on the states that
 * are not, for each value of the root field, one tree with pre-order intervals. The oracle is a direct pre-order
 * numbering; the box is every forest of at most four rows over two root values, and every single mutation of one
 * field in range, which holds P3's cross-tree row, a cycle and a second root.
 */

const byNumber = Order.Number

/** Whether `xs`, sorted, is exactly 0 … n − 1, each once. */
const isSlots = (xs: ReadonlyArray<number>, n: number): boolean => {
	const sorted = Arr.sort(xs, byNumber)
	return sorted.length === n && Arr.every(sorted, (x, i) => x === i)
}

/** A tree row as the tree box states it: its key, its parent's, its root field's value and its drawn fields. */
interface Row {
	readonly id: number
	readonly parent: number
	readonly r: number
	readonly at: number
	readonly children: number
	readonly start: number
	readonly end: number
}

/** The tree fields a mutation sets. */
type Mutated = "parent" | "r" | "at" | "children" | "start" | "end"
const mutable: ReadonlyArray<Mutated> = ["parent", "r", "at", "children", "start", "end"]

/**
 * One ordered tree of `size` nodes in pre-order, each node after the root a child of a node on the rightmost path:
 * every ordered tree of that size, by construction. Each node's parent, by position, with the root its own.
 */
const treeOf =
	(size: number): Gen<ReadonlyArray<number>> =>
	(source) => {
		const parents: Array<number> = [0]
		const path: Array<number> = [0]
		for (let i = 1; i < size; i += 1) {
			const depth = source.pick(0, path.length - 1)
			const parent = defined(path[depth])
			path.length = depth + 1
			path.push(i)
			parents.push(parent)
		}
		return parents
	}

/** A tree's rows drawn as grizzle draws them: at, children, start and end by a direct pre-order numbering. */
const drawnRows = (
	parents: ReadonlyArray<number>,
	offset: number,
	r: number
): ReadonlyArray<Row> => {
	const children = (p: number): ReadonlyArray<number> =>
		Arr.filter(
			Arr.makeBy(parents.length, (i) => i),
			(i) => i !== p && parents[i] === p
		)
	const size = (p: number): number => 1 + Arr.reduce(children(p), 0, (n, c) => n + size(c))
	return Arr.makeBy(parents.length, (i) => {
		const parent = defined(parents[i])
		const at = i === 0 ? 0 : children(parent).indexOf(i)
		return {
			id: offset + i,
			parent: offset + parent,
			r,
			at,
			children: children(i).length,
			start: i,
			end: i + size(i)
		}
	})
}

/** A state of the tree box: a forest of one or two trees of at most four rows in all, and at most one mutation. */
interface TreeState {
	readonly rows: ReadonlyArray<Row>
	readonly mutation:
		| { readonly row: number; readonly field: Mutated; readonly value: number }
		| undefined
}

const treeState: Gen<TreeState> = (source) => {
	const trees = int(1, 2)(source)
	const first = int(1, trees === 1 ? 4 : 3)(source)
	const second = trees === 1 ? 0 : int(1, 4 - first)(source)
	const rows = [
		...drawnRows(treeOf(first)(source), 1, 0),
		...(second === 0 ? [] : drawnRows(treeOf(second)(source), 1 + first, 1))
	]
	if (int(0, 1)(source) === 0) {
		return { rows, mutation: undefined }
	}
	const row = source.pick(0, rows.length - 1)
	const field = defined(mutable[source.pick(0, mutable.length - 1)])
	const range = { parent: rows.length, r: 2, at: 4, children: 4, start: 5, end: 6 }[field]
	const value = field === "parent" ? 1 + source.pick(0, range - 1) : source.pick(0, range - 1)
	return { rows, mutation: { row, field, value } }
}

/** The rows of a tree state, its mutation applied. */
const rowsOf = (s: TreeState): ReadonlyArray<Row> =>
	Arr.map(s.rows, (row, i) =>
		s.mutation === undefined || s.mutation.row !== i
			? row
			: { ...row, [s.mutation.field]: s.mutation.value }
	)

/**
 * trees.md §2's theorem, written as its own checker: the rows of each root field's value form one tree, rooted at
 * its one self-parented row at slot 0, each row's children gapless in at and counted by its children, and each row's
 * [start, end) its pre-order interval, numbered by a direct depth-first walk.
 */
const isTree = (rows: ReadonlyArray<Row>): boolean => {
	const byId = new Map(Arr.map(rows, (row) => [row.id, row] as const))
	for (const row of rows) {
		const parent = byId.get(row.parent)
		if (parent === undefined || parent.r !== row.r) {
			return false
		}
	}
	const kids = (p: Row): ReadonlyArray<Row> =>
		Arr.sort(
			Arr.filter(rows, (c) => c.parent === p.id && c.id !== p.id),
			Order.mapInput(byNumber, (c: Row) => c.at)
		)
	for (const row of rows) {
		const cs = kids(row)
		if (
			cs.length !== row.children ||
			!isSlots(
				Arr.map(cs, (c) => c.at),
				row.children
			)
		) {
			return false
		}
	}
	for (const r of new Set(Arr.map(rows, (row) => row.r))) {
		const group = Arr.filter(rows, (row) => row.r === r)
		const roots = Arr.filter(group, (row) => row.parent === row.id)
		const root = roots[0]
		if (root === undefined || roots.length > 1 || root.at !== 0) {
			return false
		}
		const visited = new Set<number>()
		let next = 0
		/** Numbers a subtree in pre-order, false on a revisit or a wrong interval. */
		const walk = (row: Row): boolean => {
			if (visited.has(row.id)) {
				return false
			}
			visited.add(row.id)
			const start = next
			next += 1
			if (!Arr.every(kids(row), walk)) {
				return false
			}
			return row.start === start && row.end === next
		}
		if (!walk(root) || visited.size !== group.length) {
			return false
		}
	}
	return true
}

/** What a tree state's mutation is, by the field it sets, or a lawful tree. */
type TreeFeature =
	| "lawful"
	| "unlawful"
	| `${Mutated} mutated`
	| "a cycle"
	| "a second root"
	| "a row under another tree"

/** The named mutations a state's mutation is: a parent edit that makes a cycle or a second root, an r off its tree's. */
const namedOf = (s: TreeState, rows: ReadonlyArray<Row>): ReadonlyArray<TreeFeature> => {
	const m = s.mutation
	if (m === undefined) {
		return []
	}
	const row = defined(rows[m.row])
	const named: Array<TreeFeature> = [`${m.field} mutated`]
	if (m.field === "parent" && row.parent === row.id && defined(s.rows[m.row]).parent !== row.id) {
		named.push("a second root")
	}
	if (m.field === "parent" && row.parent !== row.id) {
		const byId = new Map(Arr.map(rows, (x) => [x.id, x] as const))
		const seen = new Set<number>()
		let at: Row | undefined = row
		while (at !== undefined && at.parent !== at.id && !seen.has(at.id)) {
			seen.add(at.id)
			at = byId.get(at.parent)
		}
		if (at !== undefined && at.parent !== at.id) {
			named.push("a cycle")
		}
	}
	if (m.field === "r" && row.parent !== row.id && row.r !== defined(s.rows[m.row]).r) {
		named.push("a row under another tree")
	}
	return named
}

const treeSchema: SchemaDesc = schemaOf(
	[
		relation(
			"T",
			{
				id: f.uuid,
				parent: f.uuid,
				doc: f.uuid,
				at: drawnNatural,
				children: drawnNatural,
				start: drawnNatural,
				end: drawnNatural
			},
			["id"]
		)
	],
	[
		{
			kind: "tree",
			member: on("T", ["parent", "at"]),
			slots: { owner: "T", count: "children" },
			root: "doc"
		}
	]
)

describe("a tree's law", () => {
	const t = theoryOf(treeSchema)
	it.effect(
		"is violated exactly when the rows of some r are no one tree with pre-order intervals",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/analysis/theory/violations/tree",
						generator: treeState,
						literal: Formatter.format,
						limit: 8_000,
						box: "every forest of one or two trees of at most four rows, r over two values, and every single mutation of one field in range",
						oracle: {
							kind: "second-implementation",
							name: "trees.md §2's theorem by a direct pre-order numbering"
						},
						coverage: requiredInSpace<TreeFeature>([
							"lawful",
							"unlawful",
							"parent mutated",
							"r mutated",
							"at mutated",
							"children mutated",
							"start mutated",
							"end mutated",
							"a cycle",
							"a second root",
							"a row under another tree"
						]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							const rows = rowsOf(s)
							const lawful = isTree(rows)
							k.note(lawful ? "lawful" : "unlawful")
							for (const named of namedOf(s, rows)) {
								k.note(named)
							}
							const facts: HostFacts = {
								T: Arr.map(rows, (row) => ({
									id: uuidOf(row.id),
									parent: uuidOf(row.parent),
									doc: uuidOf(1000 + row.r),
									at: BigInt(row.at),
									children: BigInt(row.children),
									start: BigInt(row.start),
									end: BigInt(row.end)
								}))
							}
							assert.equal(
								violates(t, lawOfShape(t, "tree"), facts),
								!lawful,
								`${Formatter.format(rows)} is ${lawful ? "one tree per r" : "no tree"}`
							)
						})
				)
			)
	)
})
