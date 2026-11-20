/** What the properties of share-elision.test.ts read: their programs and the share planning they are held to. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import { array, boolean, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { conservativeMeta, type RelNode, type ValidDag } from "#compiler/ir/rel.ts"
import { shareKey } from "#compiler/lower/shapes/share/index.ts"
import type { ShareIndex } from "#compiler/lower/shapes/share/statements.ts"
import { succeeded } from "#test/support/assert.ts"
import { asc, Q, T, Task } from "#test/unit/lower/conservative/fixtures.ts"

/** A program's statements, each reading the one shared `pick` or a copy of its own, and each bounding its own reads. */
export interface Sketch {
	/** Per statement, whether it reads the one shared pick, or builds a copy of its own. */
	readonly shared: ReadonlyArray<boolean>
}

export const sketchGen: Gen<Sketch> = (source) => ({
	shared: source.draw(array(boolean, { min: 1, max: 6 }))
})

/**
 * The program of a sketch: `first` bounds one account's tasks to its first id, `pick` a union of two projections of
 * its imports; each statement reads the shared pick or its own copy, under its own name, and bounds what it reads to
 * its first id under that name, a sub-query of its own, of a shape no other statement's has.
 */
export const programOf = (sketch: Sketch) => {
	const q = new Q()
	const first = () =>
		q.take(
			q.project(
				q.region([
					{
						source: q.base(Task, conservativeMeta),
						bind: { id: "id", account: "account" },
						constants: { account: q.param("a", T.uuid, "compare") }
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
	const pick = () =>
		q.union(
			[
				q.project(first(), [["id", "id"]], conservativeMeta),
				q.project(first(), [["id", "id"]], conservativeMeta)
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

/** A drawn count of statements reading the one shared pick, its every copy that one node. */
export const sharedCountGen: Gen<number> = int(2, 6)

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
 * The share planning as it stood before its keys were elided (lower/shapes/share/statements.ts at db1a7e895), the
 * reference: every node a statement reads keyed by its digest, the highest key enough statements read chosen first, the
 * least key among equals, its copies every node of its key read before it was carried.
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
		index.eligible(node) ? succeeded(shareKey(dag, node)) : undefined
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
