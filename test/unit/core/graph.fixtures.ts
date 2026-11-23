/** What the properties of graph.test.ts read: their spaces, their oracle and their situations. */

import { defined } from "@bjornpagen/testing/assert"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"

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

/**
 * A directed acyclic graph of a few vertices, `0` to `size - 1`, each with its inputs, every one of a higher number, in
 * order, and the roots a path starts from, any of them, a root another vertex reads included.
 */
export interface DrawnDag {
	readonly size: number
	readonly inputs: ReadonlyArray<ReadonlyArray<number>>
	readonly roots: ReadonlyArray<number>
}

/**
 * A DAG of up to seven vertices, each with up to three inputs drawn among the vertices numbered above it (a repeated
 * input included), and one to three roots among them: few enough that a vertex of several readers, a root read by
 * another vertex and a vertex the paths to which meet at no vertex are each common.
 */
export const dagGen: Gen<DrawnDag> = (source) => {
	const size = source.draw(int(1, 7))
	return {
		size,
		inputs: Array.from({ length: size }, (_, v) =>
			v === size - 1 ? [] : source.draw(array(int(v + 1, size - 1), { min: 0, max: 3 }))
		),
		roots: source.draw(array(int(0, size - 1), { min: 1, max: 3 }))
	}
}

/** A vertex's inputs in a drawn DAG, every vertex of which has its list. */
export const inputsOf =
	(dag: DrawnDag) =>
	(v: number): ReadonlyArray<number> =>
		defined(dag.inputs[v], `vertex ${v} of a DAG of ${dag.size}`)

/** Each vertex `order` holds and its readers among them, one for each input position that names it. */
export const readersIn = (
	dag: DrawnDag,
	order: ReadonlyArray<number>
): ((v: number) => ReadonlyArray<number>) => {
	const readers = new Map<number, Array<number>>()
	for (const v of order) {
		for (const input of inputsOf(dag)(v)) {
			readers.getOrInsertComputed(input, () => []).push(v)
		}
	}
	return (v) => readers.get(v) ?? []
}

export type DominatorFeature =
	| "a vertex of several readers"
	| "a root another vertex reads"
	| "a vertex no vertex dominates but a root"
	| "a chain of two dominators"

/**
 * The vertices a search from the roots meets without passing `without`, by the definition: every root but `without`,
 * and every input of a vertex met but `without`.
 */
const reachedWithout = (dag: DrawnDag, without: number | undefined): ReadonlySet<number> => {
	const met = new Set<number>()
	const pending = Arr.filter(dag.roots, (r) => r !== without)
	for (let v = pending.pop(); v !== undefined; v = pending.pop()) {
		if (met.has(v)) {
			continue
		}
		met.add(v)
		for (const input of inputsOf(dag)(v)) {
			if (input !== without) {
				pending.push(input)
			}
		}
	}
	return met
}

/**
 * Each vertex the roots reach and its immediate dominator, by the definitions read directly: `d` dominates `v` when no
 * path from a root meets `v` without passing `d`, so a search from the roots that never enters `d` misses `v`; a root
 * is met directly, by no vertex dominated; the immediate dominator is the strict dominator whose own strict dominators
 * are the others.
 */
export const expectedDominators = (dag: DrawnDag): ReadonlyMap<number, number | undefined> => {
	const reached = reachedWithout(dag, undefined)
	const strict = new Map<number, ReadonlySet<number>>(
		Arr.map([...reached], (v) => [
			v,
			new Set(Arr.filter([...reached], (d) => d !== v && !reachedWithout(dag, d).has(v)))
		])
	)
	const strictOf = (v: number): ReadonlySet<number> =>
		defined(strict.get(v), `vertex ${v}, reached`)
	return new Map(
		Arr.map([...reached], (v) => {
			const ds = strictOf(v)
			const nearest = Arr.findFirst([...ds], (d) => strictOf(d).size === ds.size - 1)
			return [v, Option.getOrUndefined(nearest)] as const
		})
	)
}

/** The situations a DAG and its dominators reach. */
export const dominatorFeatures = (
	dag: DrawnDag,
	readers: (v: number) => ReadonlyArray<number>,
	dominators: ReadonlyMap<number, number | undefined>
): ReadonlyArray<DominatorFeature> => {
	const reached = [...dominators.keys()]
	const features: Array<DominatorFeature> = []
	if (Arr.some(reached, (v) => new Set(readers(v)).size > 1)) {
		features.push("a vertex of several readers")
	}
	if (Arr.some(dag.roots, (r) => readers(r).length > 0)) {
		features.push("a root another vertex reads")
	}
	if (Arr.some(reached, (v) => !dag.roots.includes(v) && dominators.get(v) === undefined)) {
		features.push("a vertex no vertex dominates but a root")
	}
	if (
		Arr.some(reached, (v) => {
			const d = dominators.get(v)
			return d !== undefined && dominators.get(d) !== undefined
		})
	) {
		features.push("a chain of two dominators")
	}
	return features
}
