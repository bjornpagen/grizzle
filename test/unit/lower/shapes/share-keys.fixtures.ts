/** What the properties of share-keys.test.ts read: their programs and the share planning they are held to. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { array, boolean, finite, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { DagTemplates } from "#compiler/ir/dag-digest.ts"
import { conservativeMeta, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import type { ShareIndex } from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { asc, plainRegion, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"
import { outerCol } from "#test/unit/lower/rewrite/support.ts"

/** A program's statements, each reading the one shared `pick` or a copy of its own, and each bounding its own reads. */
export interface Sketch {
	/** Per statement, whether it reads the one shared pick, or builds a copy of its own. */
	readonly shared: ReadonlyArray<boolean>
}

export const sketchGen: Gen<Sketch> = (source) => ({
	shared: source.draw(array(boolean, { min: 1, max: 6 }))
})

/** One account's tasks, bounded to their first id: the account a parameter of `param` names. */
const firstOf = (q: Q, param: string): RelNode =>
	q.take(
		q.project(
			q.region([
				{
					source: q.base(Task, conservativeMeta),
					bind: { id: "id", account: "account" },
					constants: { account: q.param(param, T.uuid, "compare") }
				}
			]),
			[["id", "id"]],
			conservativeMeta
		),
		asc("id"),
		{ kind: "literal", k: 1n },
		[],
		conservativeMeta
	)

/**
 * The program of a sketch: `first` bounds one account's tasks to its first id, `pick` a union of two projections of
 * its imports; each statement reads the shared pick or its own copy, under its own name, and bounds what it reads to
 * its first id under that name, a sub-query of its own, of a shape no other statement's has.
 */
export const programOf = (sketch: Sketch) => {
	const q = new Q()
	const pick = () =>
		q.union(
			[
				q.project(firstOf(q, "a"), [["id", "id"]], conservativeMeta),
				q.project(firstOf(q, "a"), [["id", "id"]], conservativeMeta)
			],
			[]
		)
	const shared = pick()
	const roots = Arr.map(indices(sketch.shared.length), (i) => {
		const p = defined(sketch.shared[i], "a statement's sharing") ? shared : pick()
		return q.take(
			q.project(p, [[`id${i}`, "id"]], conservativeMeta),
			asc(`id${i}`),
			{ kind: "literal", k: 1n },
			[],
			conservativeMeta
		)
	})
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, roots }
}

/** The nodes a statement rooted at `root` reads, each once, without entering a node `stop` names. */
const reach = (index: ShareIndex, root: RelNode, stop: (node: RelNode) => boolean) => {
	const seen = new Set<RelNode>([root])
	const queue = [root]
	for (const node of queue) {
		for (const input of index.inputs(node)) {
			if (!seen.has(input) && !stop(input)) {
				seen.add(input)
				queue.push(input)
			}
		}
	}
	return queue
}

/**
 * The share planning keyed by the digest of each node's whole reach (share/index.ts shareKey), as it was before share
 * keys were digested from blocks, the reference: every node a statement reads keyed, the highest key enough statements
 * read chosen first, the least key among equals, its copies every node of its key read before it was carried.
 */
export const referenceShares = (
	index: ShareIndex,
	dag: ValidDag,
	roots: ReadonlyArray<RelNode>
): ReadonlyArray<{
	readonly key: string
	readonly node: RelNode
	readonly copies: ReadonlyArray<RelNode>
}> => {
	const keyOf = (node: RelNode): string | undefined =>
		index.eligible(node)
			? succeeded(shareKey(dag, node, new DagTemplates("derivation")))
			: undefined
	const chosen: Array<{ readonly key: string; readonly node: RelNode }> = []
	const carriedKeys = new Set<string>()
	const copiesOf = new Map<string, Array<RelNode>>()
	const stop = (node: RelNode): boolean => {
		const key = keyOf(node)
		return key !== undefined && carriedKeys.has(key)
	}
	for (;;) {
		const units = [
			...Arr.map(roots, (root) => ({ root, own: false })),
			...Arr.map(chosen, (c) => ({ root: c.node, own: true }))
		]
		const statementsOf = new Map<string, Set<number>>()
		for (const [u, unit] of units.entries()) {
			const nodes = !unit.own && stop(unit.root) ? [] : reach(index, unit.root, stop)
			for (const node of nodes) {
				const key = keyOf(node)
				if (key === undefined || carriedKeys.has(key) || node.heading.length === 0) {
					continue
				}
				const set = statementsOf.get(key) ?? new Set<number>()
				set.add(u)
				statementsOf.set(key, set)
				const copies = copiesOf.get(key) ?? []
				if (!copies.includes(node)) {
					copies.push(node)
				}
				copiesOf.set(key, copies)
			}
		}
		let best: { readonly key: string; readonly node: RelNode; readonly height: number } | undefined
		for (const [key, statements] of statementsOf) {
			if (statements.size < 2) {
				continue
			}
			const node = defined(copiesOf.get(key)?.[0], "a key's first copy")
			const height = index.height(node)
			if (
				best === undefined ||
				height > best.height ||
				(height === best.height && key < best.key)
			) {
				best = { key, node, height }
			}
		}
		if (best === undefined) {
			break
		}
		carriedKeys.add(best.key)
		chosen.push({ key: best.key, node: best.node })
	}
	return Arr.sort(
		Arr.map(chosen, (c) => ({ ...c, copies: copiesOf.get(c.key) ?? [] })),
		Order.mapInput(Order.Number, (c: { readonly node: RelNode }) => index.height(c.node))
	)
}

/**
 * Four statements, each reading its own copy of one account's first task under its own name: statements 0 and 1 the
 * account a parameter `a` names, 2 and 3 the one `b` names, so two classes of one height, read by two statements each,
 * of two share keys.
 */
export const twoClasses = () => {
	const q = new Q()
	const roots = Arr.map(indices(4), (i) =>
		q.project(firstOf(q, i < 2 ? "a" : "b"), [[`id${i}`, "id"]], conservativeMeta)
	)
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, roots }
}

/** An order of the four statements of twoClasses, drawn. */
export const memberOrderGen: Gen<ReadonlyArray<number>> = (source) => {
	const left = Arr.map(indices(4), (i) => i)
	const order: Array<number> = []
	while (left.length > 0) {
		const [at] = left.splice(source.draw(int(0, left.length - 1)), 1)
		order.push(defined(at, "a statement left to order"))
	}
	return order
}

/**
 * `depth` levels over one account's first task, each the union of two projections of the level below, the one node
 * read twice: every level reaches every level under it, so a digest of each level's whole reach writes the levels below
 * again for every level above.
 */
export const levels = (depth: number) => {
	const q = new Q()
	let level = firstOf(q, "a")
	for (let i = 1; i <= depth; i++) {
		level = q.union(
			[
				q.project(level, [["id", "id"]], conservativeMeta),
				q.take(level, asc("id"), { kind: "literal", k: BigInt(i) }, [], conservativeMeta)
			],
			[]
		)
	}
	return q.build(level).dag
}

/** A drawn depth of levels. */
export const depthGen: Gen<number> = int(8, 20)

/**
 * Two unions in one DAG, each of two projections of one account's first task: the first reads one task twice, the
 * second one copy and another, each copy over the parameter `a`, or the second's other over `b` (`same` false).
 */
export const twiceAndCopies = (same: boolean) => {
	const q = new Q()
	const once = firstOf(q, "a")
	const twice = q.union(
		[
			q.project(once, [["id", "id"]], conservativeMeta),
			q.project(once, [["id", "id"]], conservativeMeta)
		],
		[]
	)
	const copies = q.union(
		[
			q.project(firstOf(q, "a"), [["id", "id"]], conservativeMeta),
			q.project(firstOf(q, same ? "a" : "b"), [["id", "id"]], conservativeMeta)
		],
		[]
	)
	const built = q.build(q.union([twice, copies], []))
	return { dag: built.dag, twice, copies }
}

/**
 * Two folds of one region of two tasks, each its rows' count by account, keyed by the region's first occurrence or its
 * second (`first` and `second`): the occurrence a fold reads by is a name the region declares.
 */
export const foldsByOccurrence = (first: 0 | 1, second: 0 | 1) => {
	const q = new Q()
	const region = q.region([
		{ source: q.base(Task, conservativeMeta), bind: { id: "a", account: "x" }, constants: {} },
		{ source: q.base(Task, conservativeMeta), bind: { id: "b", account: "x" }, constants: {} }
	])
	if (region.kind !== "MatchRegion") {
		throw new Error("fixture: a region")
	}
	const fold = (by: 0 | 1) =>
		q.node({
			kind: "Group",
			input: region,
			bound: {
				columns: ["a", "x", "b"],
				keyed: [{ occurrence: defined(region.occurrences[by], "an occurrence").id, key: ["id"] }]
			},
			keys: ["x"],
			aggs: [],
			heading: [{ name: "x", type: T.uuid }],
			loc: undefined,
			meta: conservativeMeta
		})
	const folds = [fold(first), fold(second)] as const
	const built = q.build(q.union([...folds], []))
	return { dag: built.dag, folds }
}

/** Two occurrences folds may read by, each the first or the second of their region's. */
export const occurrencePairGen = finite((source) => {
	const at = (): 0 | 1 => (source.draw(boolean) ? 1 : 0)
	return [at(), at()] as const
})

/** Whether the second union's other copy is over the first's parameter. */
export const sameParameterGen = finite((source) => source.draw(boolean))

/**
 * Two statements, each bounding to its first task an attachment of a filter of one account's tasks, its child the
 * tasks of the account its row holds: a region correlated to the parent's region, below the parent, which the
 * attachment binds for its child (ir/dag.ts deliverySpine), the parent a sealed node of the bound's block. Each
 * statement reads a copy of its own, over the parameter `a`, or the second over `b` (`same` false).
 */
export const attachedBelowItsParent = (same: boolean) => {
	const q = new Q()
	const bound = (param: string) => {
		const region = q.region([
			{
				source: q.base(Task, conservativeMeta),
				bind: { id: "id", account: "account", amount: "amount" },
				constants: { account: q.param(param, T.uuid, "compare") }
			}
		])
		const parent = q.filter(
			region,
			q.op("int8ge", [q.col(region, "amount"), q.int(0, T.int8)], T.bool)
		)
		const child = q.regionWith(
			[
				{
					source: q.base(Task, conservativeMeta),
					bind: { id: "task", account: "of" },
					constants: {}
				}
			],
			{
				...plainRegion,
				correlated: [{ name: "of", type: T.uuid, expr: outerCol(q, region.id, "account", T.uuid) }]
			}
		)
		return q.take(
			q.attach(parent, child, "tasks", [], "array", undefined),
			asc("id"),
			{ kind: "literal", k: 1n },
			[],
			conservativeMeta
		)
	}
	const copies = [bound("a"), bound(same ? "a" : "b")] as const
	const roots = Arr.map(copies, (copy, i) => q.project(copy, [[`id${i}`, "id"]], conservativeMeta))
	const built = q.build(
		q.union(
			Arr.map(roots, (root, i) => q.project(root, [["id", `id${i}`]], conservativeMeta)),
			[]
		)
	)
	return { dag: built.dag, roots, copies }
}
