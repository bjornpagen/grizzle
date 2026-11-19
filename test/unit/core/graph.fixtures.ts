/** What the properties of graph.test.ts read: their spaces, their oracle and their situations. */

import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Order } from "effect"
import { defined } from "#test/support/assert.ts"

/** A graph of a few vertices, `0` to `size - 1`, each with its successors in order, and the roots a walk starts from. */
export interface DrawnGraph {
	readonly size: number
	readonly successors: ReadonlyArray<ReadonlyArray<number>>
	readonly roots: ReadonlyArray<number>
}

/** A vertex's successors in a drawn graph, every vertex of which has its list. */
export const successorsOf =
	(graph: DrawnGraph) =>
	(v: number): ReadonlyArray<number> =>
		defined(graph.successors[v], `vertex ${v} of a graph of ${graph.size}`)

/**
 * A graph of up to seven vertices, each with up to four successors drawn among them (a self loop and a repeated
 * successor included), and up to five roots among them, a root drawn twice included: few enough that cycles, edges
 * into a closed component and vertices no root reaches are each common.
 */
export const graphGen: Gen<DrawnGraph> = (source) => {
	const size = source.draw(int(1, 7))
	const vertex = int(0, size - 1)
	return {
		size,
		successors: Array.from({ length: size }, () => source.draw(array(vertex, { min: 0, max: 4 }))),
		roots: source.draw(array(vertex, { min: 1, max: 5 }))
	}
}

export type GraphFeature =
	| "a cycle of several vertices"
	| "a self loop"
	| "an edge into a component already closed"
	| "a root already entered"
	| "a vertex no root reaches"

/**
 * The oracle's reading of a walk, by the definitions alone: a recursive depth-first walk from each root in order and
 * through each vertex's successors in order, entering each vertex once, which numbers the vertices as it enters them
 * and as it finishes them; and each entered vertex's reach, every vertex a path of one edge or more from it meets.
 */
export interface Walked {
	readonly entered: ReadonlyMap<number, number>
	readonly finished: ReadonlyMap<number, number>
	readonly reach: ReadonlyMap<number, ReadonlySet<number>>
}

export const walked = (graph: DrawnGraph): Walked => {
	const next = successorsOf(graph)
	const entered = new Map<number, number>()
	const finished = new Map<number, number>()
	const visit = (v: number): void => {
		entered.set(v, entered.size)
		for (const w of next(v)) {
			if (!entered.has(w)) {
				visit(w)
			}
		}
		finished.set(v, finished.size)
	}
	for (const root of graph.roots) {
		if (!entered.has(root)) {
			visit(root)
		}
	}
	const reach = new Map<number, ReadonlySet<number>>()
	for (const v of entered.keys()) {
		const met = new Set<number>()
		const frontier = Arr.copy(next(v))
		for (let w = frontier.pop(); w !== undefined; w = frontier.pop()) {
			if (!met.has(w)) {
				met.add(w)
				for (const u of next(w)) {
					frontier.push(u)
				}
			}
		}
		reach.set(v, met)
	}
	return { entered, finished, reach }
}

/** Where the walk entered a vertex it entered. */
const enteredAt = (w: Walked, v: number): number =>
	defined(w.entered.get(v), `vertex ${v}, entered`)

/** Where the walk finished a vertex it entered. */
const finishedAt = (w: Walked, v: number): number =>
	defined(w.finished.get(v), `vertex ${v}, finished`)

/** Whether `a` reaches `b` by a path of one edge or more. */
const reaches = (w: Walked, a: number, b: number): boolean =>
	defined(w.reach.get(a), `the reach of vertex ${a}`).has(b)

/** Whether two entered vertices are in one component: they are one, or each reaches the other. */
const together = (w: Walked, a: number, b: number): boolean =>
	a === b || (reaches(w, a, b) && reaches(w, b, a))

/**
 * The components the definitions give: the entered vertices grouped by mutual reachability, in the order the walk
 * finishes each component's first entered vertex, each component's vertices last entered first.
 */
export const expectedComponents = (w: Walked): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> => {
	const vertices = Arr.fromIterable(w.entered.keys())
	const groups = Arr.flatMap(vertices, (v) => {
		const group = Arr.filter(vertices, (u) => together(w, u, v))
		return Arr.isReadonlyArrayNonEmpty(group) && group[0] === v ? [group] : []
	})
	const byEntry = Order.mapInput(Order.Number, (v: number) => enteredAt(w, v))
	const firstEntered = (g: Arr.NonEmptyReadonlyArray<number>): number => Arr.min(g, byEntry)
	const byFirstFinish = Order.mapInput(Order.Number, (g: Arr.NonEmptyReadonlyArray<number>) =>
		finishedAt(w, firstEntered(g))
	)
	return Arr.map(Arr.sort(groups, byFirstFinish), (g) => Arr.sort(g, Order.flip(byEntry)))
}

/** The situations a drawn graph reaches. */
export const graphFeatures = (graph: DrawnGraph, w: Walked): ReadonlyArray<GraphFeature> => {
	const components = expectedComponents(w)
	const componentOf = new Map(Arr.flatMap(components, (c, i) => Arr.map(c, (v) => [v, i] as const)))
	const edges = Arr.flatMap(Arr.fromIterable(w.entered.keys()), (v) =>
		Arr.map(successorsOf(graph)(v), (u) => [v, u] as const)
	)
	const reached: ReadonlyArray<readonly [GraphFeature, boolean]> = [
		["a cycle of several vertices", Arr.some(components, (c) => c.length > 1)],
		["a self loop", Arr.some(edges, ([v, u]) => v === u)],
		[
			"an edge into a component already closed",
			Arr.some(
				edges,
				([v, u]) => componentOf.get(u) !== componentOf.get(v) && enteredAt(w, u) < enteredAt(w, v)
			)
		],
		[
			"a root already entered",
			Arr.some(graph.roots, (r, i) =>
				Arr.some(Arr.take(graph.roots, i), (s) => s === r || reaches(w, s, r))
			)
		],
		["a vertex no root reaches", w.entered.size < graph.size]
	]
	return Arr.flatMap(reached, ([feature, holds]) => (holds ? [feature] : []))
}

/**
 * A chain's depth and whether its last vertex leads back to its first: a chain of one component per vertex, or one
 * component of every vertex, each walked to the chain's end before anything closes.
 */
export interface Chain {
	readonly depth: number
	readonly closed: boolean
}

export type ChainWalkFeature =
	| "a chain of one component per vertex"
	| "a chain closed into one component"
	| "a chain past a small stack's recursion"

/** A chain's components as the walk closes them: each vertex alone, its last first, or every vertex, last first. */
export const chainComponents = (chain: Chain): ReadonlyArray<Arr.NonEmptyReadonlyArray<number>> => {
	const backwards = Array.from({ length: chain.depth }, (_, i) => chain.depth - 1 - i)
	return chain.closed && Arr.isReadonlyArrayNonEmpty(backwards)
		? [backwards]
		: Arr.map(backwards, (v) => Arr.of(v))
}
