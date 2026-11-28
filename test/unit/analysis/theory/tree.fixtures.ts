/** What the properties of tree.test.ts read: its spaces, models and helpers. */

import { deepEquals, defined } from "@bjornpagen/testing/assert"
import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { type KeyedRow, numbered, treeOfParents } from "#test/support/families/tree.ts"
import { f, on, relation, type SchemaDesc } from "#test/support/fixtures/ir/desc.ts"
import { drawnNatural, schemaOf, theoryOf } from "#test/support/unit/analysis/theory/support.ts"

/** The tree fields a mutation sets. */
type Mutated = "parent" | "r" | "at" | "children" | "start" | "end"

const mutable: ReadonlyArray<Mutated> = ["parent", "r", "at", "children", "start", "end"]

/**
 * One ordered tree of `size` nodes in pre-order, each node after the root a child of a node on the rightmost path:
 * every ordered tree of that size, by construction. Each node's parent but the root's, by position, as the testing
 * library's `parents` states a tree.
 */
const treeOf =
	(size: number): Gen<ReadonlyArray<number>> =>
	(source) => {
		const parents: Array<number> = []
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

/** A state of the tree box: a forest of one or two trees of at most four rows in all, and at most one mutation. */
interface TreeState {
	readonly rows: ReadonlyArray<KeyedRow>
	readonly mutation:
		| { readonly row: number; readonly field: Mutated; readonly value: number }
		| undefined
}

export const treeState: Gen<TreeState> = (source) => {
	const trees = int(1, 2)(source)
	const first = int(1, trees === 1 ? 4 : 3)(source)
	const second = trees === 1 ? 0 : int(1, 4 - first)(source)
	const rows = numbered([
		{ root: ["0"], tree: treeOfParents(treeOf(first)(source), []) },
		...(second === 0 ? [] : [{ root: ["1"], tree: treeOfParents(treeOf(second)(source), []) }])
	])
	if (int(0, 1)(source) === 0) {
		return { rows, mutation: undefined }
	}
	const row = source.pick(0, rows.length - 1)
	const field = defined(mutable[source.pick(0, mutable.length - 1)])
	const range = { parent: 5, r: 2, at: 4, children: 4, start: 5, end: 6 }[field]
	return { rows, mutation: { row, field, value: source.pick(0, range - 1) } }
}

/** A row as the theory's facts state it: its tree's fields alone. */
export const structureOf = (r: KeyedRow) => ({
	root: r.root,
	parent: r.parent,
	at: r.at,
	children: r.children,
	start: r.start,
	end: r.end
})

/**
 * The rows of a tree state, its mutation applied: a set of facts, so a row mutated into another, field for field of
 * what the facts state, is that one row.
 */
export const rowsOf = (s: TreeState): ReadonlyArray<KeyedRow> =>
	Arr.dedupeWith(
		Arr.map(s.rows, (row, i) => {
			const m = s.mutation
			if (m === undefined || m.row !== i) {
				return row
			}
			return m.field === "r" ? { ...row, root: [String(m.value)] } : { ...row, [m.field]: m.value }
		}),
		(a, b) => deepEquals(structureOf(a), structureOf(b))
	)

/** A row's root value, its one field's. */
export const rOf = (row: KeyedRow): string => defined(row.root[0], "a row's root value")

/** What a tree state's mutation is, by the field it sets, or a lawful tree. */
export type TreeFeature =
	| "lawful"
	| "unlawful"
	| `${Mutated} mutated`
	| "a parent after its child"
	| "a second root"
	| "a row under another tree"

/**
 * The named mutations a state's mutation is: a parent edit that makes a second root or puts a parent after its child,
 * an r off its tree's.
 */
export const namedOf = (s: TreeState): ReadonlyArray<TreeFeature> => {
	const m = s.mutation
	if (m === undefined) {
		return []
	}
	const was = defined(s.rows[m.row])
	const row = m.field === "r" ? { ...was, root: [String(m.value)] } : { ...was, [m.field]: m.value }
	const named: Array<TreeFeature> = [`${m.field} mutated`]
	if (m.field === "parent" && row.start > 0 && row.parent === row.start) {
		named.push("a second root")
	}
	if (m.field === "parent" && row.parent > row.start) {
		named.push("a parent after its child")
	}
	if (m.field === "r" && row.start > 0 && rOf(row) !== rOf(was)) {
		named.push("a row under another tree")
	}
	return named
}

const treeSchema: SchemaDesc = schemaOf(
	[
		relation(
			"T",
			{
				doc: f.uuid,
				parent: drawnNatural,
				at: drawnNatural,
				children: drawnNatural,
				start: drawnNatural,
				end: drawnNatural
			},
			["doc", "start"]
		)
	],
	[
		{
			kind: "tree",
			member: on("T", ["parent", "at"]),
			slots: { owner: "T", count: "children" },
			root: ["doc"]
		}
	]
)

export const t = theoryOf(treeSchema)
