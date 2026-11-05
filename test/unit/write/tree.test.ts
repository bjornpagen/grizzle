import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int, parents } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { bindFrame } from "#adapter/wire/batch.ts"
import { arrayTexts } from "#compiler/codec/recordset.ts"
import { maxOf } from "#compiler/core/array.ts"
import { placedTexts } from "#compiler/write/family/draw.ts"
import {
	type FamilyStatement,
	type FamilyWrite,
	inForce,
	plan,
	type Transport
} from "#compiler/write/family/order.ts"
import { type DrawnNode, type TreeNode, walk } from "#compiler/write/family/tree.ts"
import { canonical as rowsById, type TreeRow as NodeRow } from "#test/pg/substrate/tree.ts"
import { assert, defined, succeeded } from "#test/support/assert.ts"
import {
	type Forest,
	grizzleTree,
	type Node,
	numbered,
	type TreeStatement,
	treePredicted
} from "#test/support/families/tree.ts"
import { caseHang } from "#test/support/limits.ts"

/**
 * The tree walk and the tree write (write/family/tree.ts, order.ts's tree arm): one iterative depth-first walk draws
 * every node's `at`, `children`, `start`, `end`, ‹ps› and ‹n› from the nested arrays, and a tree's write sends its nodes
 * in pre-order, cut into maximal chunks, after one delete per batch of the trees it replaces.
 *
 * The oracles:
 * - a second implementation: NP's direct recursive pre-order numbering (test/support/families/tree.ts `numbered`), which
 *   the walk must equal row for row, in its order, since rows come in pre-order; and, where recursion would not
 *   reach, the closed form of a chain's and a star's numbering;
 * - PostgreSQL's verdict as NP's tree model predicts it (`treePredicted` over grizzle's lowering, `grizzleTree`): after
 *   each statement of a write every immediate law holds of the whole state, the deferred last axis at commit, and the
 *   write commits to exactly the trees it states.
 *
 * The bounds: every tree of one to seven nodes, its children in id order (874 labelled trees); chains and stars of 1,
 * 2, 3, 99,999 and 100,000 nodes; every forest of one tree of up to six nodes or two of up to three (the second's root
 * value apart), written fresh or over an earlier forest of the same root values it replaces, under the transport in
 * force and under one that carries one row per statement (2,040 cases). The named mutants are a write whose nodes go in
 * reverse pre-order, children before their parents, and a replacing write whose inserts go before its delete: each
 * must be refused, the first wherever one row goes per statement and a tree has two nodes, the second whenever the
 * write replaces.
 */

/** A tree drawn as the parent of each node after the root, ids from 0 at the root; children in id order. */
const treeOf = (parentOf: ReadonlyArray<number>, offset: number): Node => {
	const count = parentOf.length + 1
	const children: Array<Array<number>> = Arr.makeBy(count, () => [])
	for (const [i, p] of parentOf.entries()) {
		defined(children[p], "a parent precedes its child").push(i + 1)
	}
	const built: Array<Node | undefined> = Arr.makeBy(count, () => undefined)
	for (let id = count - 1; id >= 0; id -= 1) {
		built[id] = {
			id: id + offset,
			children: Arr.map(defined(children[id], "a node's children"), (c) =>
				defined(built[c], "a child is built before its parent")
			)
		}
	}
	return defined(built[0], "the root")
}

/** A tree as the walk takes it: each node's key its id's text, its member texts its root value's and its id's. */
const treeNodeOf = (root: number, tree: Node): TreeNode => {
	const order: Array<Node> = []
	const pending: Array<Node> = [tree]
	for (let n = pending.pop(); n !== undefined; n = pending.pop()) {
		order.push(n)
		for (const child of n.children) {
			pending.push(child)
		}
	}
	const built = new Map<Node, TreeNode>()
	for (const n of Arr.reverse(order)) {
		built.set(n, {
			key: [String(n.id)],
			member: [String(root), String(n.id)],
			children: Arr.map(n.children, (c) =>
				defined(built.get(c), "a child is built before its parent")
			)
		})
	}
	return defined(built.get(tree), "the root")
}

const decimal = (text: string | undefined): number => Number(defined(text, "a drawn text"))

/** A drawn node as NP's row. */
const rowOf = (n: DrawnNode): NodeRow => ({
	id: decimal(n.node.key[0]),
	root: decimal(n.node.member[0]),
	parent: decimal(n.parent[0]),
	at: n.at,
	children: n.children,
	start: n.start,
	end: n.end,
	copy: n.copy,
	parentStart: n.parentStart
})

/** An inserted row's texts read back as NP's row, by the layout placedNode writes. */
const insertedOf = (texts: ReadonlyArray<string>): NodeRow => {
	assert.equal(
		texts.length,
		9,
		"a tree row's texts are its group, at, ‹n›, its drawn interval and ‹ps›, then its own"
	)
	const [parent, at, copy, children, start, end, parentStart, root, id] = Arr.map(texts, Number)
	return {
		id: defined(id, "id"),
		root: defined(root, "root"),
		parent: defined(parent, "parent"),
		at: defined(at, "at"),
		children: defined(children, "children"),
		start: defined(start, "start"),
		end: defined(end, "end"),
		copy: defined(copy, "copy"),
		parentStart: defined(parentStart, "parentStart")
	}
}

/** A planned statement as NP's tree statement. */
const modelled = (s: FamilyStatement): TreeStatement => {
	switch (s.kind) {
		case "insert":
			return { kind: "insert", rows: Arr.map(s.rows, (r) => insertedOf(placedTexts(r))) }
		case "deleteTree":
			return { kind: "deleteTree", roots: Arr.map(s.rows, (owner) => decimal(owner[0])) }
		case "delete":
		case "count":
			return assert.fail(`a tree's write sends no ${s.kind} statement`)
	}
}

type TreeFeature =
	| "a single node"
	| "a chain"
	| "a star"
	| "a node of two children or more"
	| "seven nodes"

describe("the tree walk, exhaustively", () => {
	it.effect(
		"numbers every tree of up to seven nodes as a direct pre-order numbering does, node for node, in pre-order",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/tree/walk",
						generator: parents({ min: 1, max: 7 }),
						literal: Formatter.format,
						limit: 874,
						coverage: requiredInSpace<TreeFeature>([
							"a single node",
							"a chain",
							"a star",
							"a node of two children or more",
							"seven nodes"
						]),
						caseHang,
						box: "every labelled tree of 1 to 7 nodes, children in id order",
						oracle: {
							kind: "second-implementation",
							name: "numbered (test/support/families/tree.ts)"
						}
					},
					(parentOf, c) =>
						Effect.sync(() => {
							const tree = treeOf(parentOf, 0)
							const drawn: ReadonlyArray<NodeRow> = Arr.map(walk(treeNodeOf(7, tree)), rowOf)
							assert.deepEqual(
								drawn,
								numbered([{ root: 7, tree }]),
								"the walk's rows are the numbering's"
							)
							if (parentOf.length === 0) {
								c.note("a single node")
							}
							if (parentOf.length > 1 && Arr.every(parentOf, (p, i) => p === i)) {
								c.note("a chain")
							}
							if (parentOf.length > 1 && Arr.every(parentOf, (p) => p === 0)) {
								c.note("a star")
							}
							if (Arr.some(drawn, (r) => r.children >= 2)) {
								c.note("a node of two children or more")
							}
							if (parentOf.length === 6) {
								c.note("seven nodes")
							}
						})
				)
			)
	)
})

type Shape = "chain" | "star"
const SIZES = [1, 2, 3, 99_999, 100_000] as const

/**
 * The closed form of a shape's numbering of `n` nodes: a chain's node at depth d starts at d and ends at n, its one
 * child at 0; a star's root ends at n and its i-th child is [i + 1, i + 2), its parent's start 0 and its copy n − 1.
 */
const closedForm = (shape: Shape, n: number, d: number): Omit<NodeRow, "root"> => {
	switch (shape) {
		case "chain":
			return {
				id: d,
				parent: d === 0 ? 0 : d - 1,
				at: 0,
				children: d === n - 1 ? 0 : 1,
				start: d,
				end: n,
				copy: d === 0 ? (n > 1 ? 1 : 0) : 1,
				parentStart: d === 0 ? 0 : d - 1
			}
		case "star":
			return d === 0
				? {
						id: 0,
						parent: 0,
						at: 0,
						children: n - 1,
						start: 0,
						end: n,
						copy: n - 1,
						parentStart: 0
					}
				: {
						id: d,
						parent: 0,
						at: d - 1,
						children: 0,
						start: d,
						end: d + 1,
						copy: n - 1,
						parentStart: 0
					}
	}
}

describe("the tree walk at depth and width", () => {
	it.effect(
		"draws chains and stars of up to 100,000 nodes iteratively, as their numbering's closed form",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/tree/scale",
						generator: (source): readonly [Shape, number] => [
							source.draw(element(["chain", "star"] as const)),
							source.draw(element(SIZES))
						],
						literal: Formatter.format,
						limit: 10,
						coverage: requiredInSpace<"deep" | "wide">(["deep", "wide"]),
						caseHang,
						box: "chains and stars of 1, 2, 3, 99,999 and 100,000 nodes",
						oracle: { kind: "specification", name: "the closed form of a pre-order numbering" }
					},
					([shape, n], c) =>
						Effect.sync(() => {
							const parentOf = Array.from({ length: n - 1 }, (_, i) => (shape === "chain" ? i : 0))
							const drawn = walk(treeNodeOf(1, treeOf(parentOf, 0)))
							assert.equal(drawn.length, n, "every node is drawn once")
							for (const [d, node] of drawn.entries()) {
								const { root, ...row } = rowOf(node)
								assert.equal(root, 1, "a node's root value is its tree's")
								const expected = closedForm(shape, n, d)
								if (
									row.id !== expected.id ||
									row.parent !== expected.parent ||
									row.at !== expected.at ||
									row.children !== expected.children ||
									row.start !== expected.start ||
									row.end !== expected.end ||
									row.copy !== expected.copy ||
									row.parentStart !== expected.parentStart
								) {
									assert.deepEqual(row, expected, `node ${d} of a ${shape} of ${n}`)
								}
							}
							if (n === 100_000) {
								c.note(shape === "chain" ? "deep" : "wide")
							}
						})
				)
			)
	)
})

/** The transport in force over the wire's frame. */
const roomy = inForce(bindFrame)

/** A text's array literal alone, as the encoder writes it. */
const literalAlone = (text: string): number =>
	defined(succeeded(arrayTexts("t", ["c"], [[text]], roomy.literalUnits))[0], "one literal").length

/** A transport whose arrays hold one row each: every text of the box, up to ids and values below 100, fits alone. */
const oneRowEach: Transport = {
	...roomy,
	literalUnits: maxOf(Arr.map(["99", "99"], literalAlone), 0)
}

type Transported = "in force" | "one row each"

/** One case of the write box: its trees, their root values apart, what it replaces, and the transport. */
interface WriteCase {
	readonly forest: Forest
	readonly replaces: boolean
	readonly transport: Transported
	readonly mutant: Mutant
}

/**
 * A named mutant of the tree write: its nodes inserted in reverse pre-order, children before their parents; or a
 * replacing write's inserts sent before its delete, the new root beside the old at one root value.
 */
type Mutant = "none" | "reverse pre-order" | "inserts first"

/** A forest of one tree of up to six nodes or two of up to three, ids apart across trees. */
const forestGen: Gen<Forest> = (source) => {
	const trees = source.draw(int(1, 2))
	const forest: Array<Forest[number]> = []
	let offset = 0
	for (let t = 0; t < trees; t += 1) {
		const parentOf = source.draw(parents({ min: 1, max: trees === 1 ? 6 : 3 }))
		forest.push({ root: 10 + t, tree: treeOf(parentOf, offset) })
		offset += parentOf.length + 1
	}
	return forest
}

const writeGen: Gen<WriteCase> = (source) => ({
	forest: source.draw(forestGen),
	replaces: source.draw(element([false, true])),
	transport: source.draw(element(["in force", "one row each"] as const)),
	mutant: source.draw(element(["none", "reverse pre-order", "inserts first"] as const))
})

/** The forest an earlier write left at the same root values, which a replacing write deletes first: each tree's root
 * with one leaf, ids past the box's. */
const earlierOf = (forest: Forest): Forest =>
	Arr.map(forest, ({ root }, t) => ({
		root,
		tree: { id: 100 + 2 * t, children: [{ id: 101 + 2 * t, children: [] }] }
	}))

/** The statements a mutant sends in place of the plan's. */
const mutantOf = (
	mutant: Mutant,
	sent: ReadonlyArray<TreeStatement>
): ReadonlyArray<TreeStatement> => {
	const deletes = Arr.filter(sent, (s) => s.kind === "deleteTree")
	const inserts = Arr.filter(
		sent,
		(s): s is Extract<TreeStatement, { readonly kind: "insert" }> => s.kind === "insert"
	)
	switch (mutant) {
		case "none":
			return sent
		case "reverse pre-order":
			return [
				...deletes,
				...Arr.map(Arr.reverse(inserts), (s): TreeStatement => ({
					kind: "insert",
					rows: Arr.reverse(s.rows)
				}))
			]
		case "inserts first":
			return [...inserts, ...deletes]
	}
}

type WriteFeature = "two trees" | "a replaced tree" | "a statement cut" | "a mutant refused"

describe("the tree write, exhaustively", () => {
	it.effect(
		"writes every forest of one tree of six nodes or two of three in pre-order chunks, every immediate law true at each statement's end, and commits to its numbering; the named mutants are refused",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/write/tree/write",
						generator: writeGen,
						literal: Formatter.format,
						limit: 12_000,
						coverage: requiredInSpace<WriteFeature>([
							"two trees",
							"a replaced tree",
							"a statement cut",
							"a mutant refused"
						]),
						caseHang,
						box: "every forest of one tree of 1 to 6 nodes or two of 1 to 3, fresh or replacing, under two transports, with each named mutant",
						oracle: {
							kind: "second-implementation",
							name: "treePredicted over grizzleTree (test/support/families/tree.ts), PostgreSQL's verdict as NP's model predicts it"
						}
					},
					(w, c) =>
						Effect.sync(() => {
							const earlier = earlierOf(w.forest)
							const before = w.replaces ? numbered(earlier) : []
							const write: FamilyWrite = {
								kind: "tree",
								trees: Arr.map(w.forest, ({ root, tree }) => ({
									root: [String(root)],
									replaces: w.replaces,
									nodes: walk(treeNodeOf(root, tree))
								}))
							}
							const transport = w.transport === "in force" ? roomy : oneRowEach
							const planned = succeeded(plan(write, transport), "every row fits alone")
							const [deletes, counts, inserts] = planned
							assert.equal(counts.length, 0, "a tree's write sends no count statement")
							if (deletes.length + inserts.length > (w.replaces ? 2 : 1) && inserts.length > 1) {
								c.note("a statement cut")
							}
							const sent = Arr.map(Arr.flatten(planned), modelled)
							const statements = mutantOf(w.mutant, sent)
							const outcome = treePredicted(grizzleTree, before, statements)
							const expected = numbered(w.forest)
							const mutated =
								w.mutant === "reverse pre-order"
									? w.transport === "one row each" && Arr.some(expected, (r) => r.parent !== r.id)
									: w.mutant === "inserts first" && w.replaces
							if (mutated) {
								assert.equal(outcome.kind, "refused", `the mutant ${w.mutant} is refused`)
								c.note("a mutant refused")
								return
							}
							if (w.mutant !== "none") {
								return
							}
							assert.equal(outcome.kind, "committed", "a tree written whole commits")
							if (outcome.kind === "committed") {
								assert.deepEqual(
									rowsById(outcome.after),
									rowsById(expected),
									"it commits to its numbering"
								)
							}
							if (w.forest.length === 2) {
								c.note("two trees")
							}
							if (w.replaces) {
								c.note("a replaced tree")
							}
						})
				)
			)
	)
})
