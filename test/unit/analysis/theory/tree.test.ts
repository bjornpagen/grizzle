/**
 * The tree theorem through the theory (trees.md §2, w4-w7 §2.2) for a tree keyed by its root field and its start: a
 * tree's law, its family's lemmas over every row but its roots and T2 to T6 with the root pin, beside its relation's
 * primary key (r, start), evaluated by the reference evaluator, is violated exactly on the states that are not, for
 * each value of the root field, one tree with pre-order intervals. The oracle is a direct pre-order numbering
 * (test/support/families/tree.ts lawful); the box is every forest of at most four rows over two root values, and every
 * single mutation of one field in range, which holds a row under another tree, a parent after its child and a second
 * root.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): tree-violation-no-close-arm (the tree's violation omits T5, each
 * parent's end its last child's end).
 *
 * Features: lawful forests, and each mutation kind's verdict.
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { assert, defined } from "#test/support/assert.ts"
import { type KeyedRow, lawful, numbered, treeOfParents } from "#test/support/families/tree.ts"
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

const treeState: Gen<TreeState> = (source) => {
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

/** The rows of a tree state, its mutation applied. */
const rowsOf = (s: TreeState): ReadonlyArray<KeyedRow> =>
	Arr.map(s.rows, (row, i) => {
		const m = s.mutation
		if (m === undefined || m.row !== i) {
			return row
		}
		return m.field === "r" ? { ...row, root: [String(m.value)] } : { ...row, [m.field]: m.value }
	})

/** A row's root value, its one field's. */
const rOf = (row: KeyedRow): string => defined(row.root[0], "a row's root value")

/** What a tree state's mutation is, by the field it sets, or a lawful tree. */
type TreeFeature =
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
const namedOf = (s: TreeState, rows: ReadonlyArray<KeyedRow>): ReadonlyArray<TreeFeature> => {
	const m = s.mutation
	if (m === undefined) {
		return []
	}
	const row = defined(rows[m.row])
	const was = defined(s.rows[m.row])
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
							"a parent after its child",
							"a second root",
							"a row under another tree"
						]),
						caseHang
					},
					(s, k) =>
						Effect.sync(() => {
							const rows = rowsOf(s)
							const isLawful = lawful(rows)
							k.note(isLawful ? "lawful" : "unlawful")
							for (const named of namedOf(s, rows)) {
								k.note(named)
							}
							const facts: HostFacts = {
								T: Arr.map(rows, (row) => ({
									doc: uuidOf(1000 + Number(rOf(row))),
									parent: BigInt(row.parent),
									at: BigInt(row.at),
									children: BigInt(row.children),
									start: BigInt(row.start),
									end: BigInt(row.end)
								}))
							}
							assert.equal(
								violates(t, lawOfShape(t, "tree"), facts) ||
									violates(t, lawOfShape(t, "pk"), facts),
								!isLawful,
								`${Formatter.format(rows)} is ${isLawful ? "one tree per r" : "no tree"}`
							)
						})
				)
			)
	)
})
