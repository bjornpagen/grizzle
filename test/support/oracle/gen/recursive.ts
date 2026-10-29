import { array, boolean, constant, type Gen, int, map, weighted } from "@grizzle/testing/gen"
import { Array as Arr, Option, Order, Record as Rec } from "effect"
import { makeIdSupply, ParamId } from "#compiler/core/ids.ts"
import { recursionUnrollMax } from "#compiler/core/policy.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { OpId, type ScalarExpr, type TypedLiteral } from "#compiler/ir/expr.ts"
import {
	conservativeMeta,
	type Heading,
	type HeadingColumn,
	type KeySet,
	type Occurrence,
	type RelNode,
	type Rooted,
	type VarDecl
} from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import {
	bool,
	compareParamType,
	int4,
	type Spelling,
	type SpellingMode,
	scalarOfSpec,
	spellingChoiceCount,
	valueClasses
} from "#test/support/oracle/gen/domain.ts"
import type { GenFacts, LiteralRow } from "#test/support/oracle/gen/facts.ts"
import { type CompareOp, compareOpId } from "#test/support/oracle/gen/ops.ts"
import {
	column,
	type GenParam,
	type GenQuery,
	normalQuery,
	ParamNames
} from "#test/support/oracle/gen/query.ts"

import {
	closedIdType,
	type GenClosed,
	type GenRelation,
	type GenSchema,
	relationHeading
} from "#test/support/oracle/gen/schema.ts"
import { at, elementAt, nonEmptyList, indices } from "#test/support/oracle/pick.ts"
import { pickGen } from "#test/support/pick.ts"

export const graphShapes = ["chain", "tree", "diamond", "selfLoop", "denseCycle", "random"] as const
type GraphShape = (typeof graphShapes)[number]

/** The vertex identity types, in shrink order. An enum is the closedId of the case's roster K0. */
export const vertexKinds = ["int4", "text", "int8", "uuid", "int2", "float8", "enum"] as const
type VertexKind = (typeof vertexKinds)[number]

const rosterHandles: ReadonlyArray<string> = ["H0", "H1", "H2", "H3", "H4", "H5", "H6", "H7"]

const vertexRoster: GenClosed = {
	name: "K0",
	handles: rosterHandles,
	payload: [],
	rows: Arr.map(rosterHandles, (handle) => [{ kind: "enum", handle } satisfies TypedLiteral])
}

const vertexTypeOf = (kind: VertexKind): ScalarType =>
	kind === "enum" ? closedIdType(vertexRoster) : scalarOfSpec({ carrier: kind })

type EdgePair = readonly [number, number]

interface GraphSketch {
	readonly shape: number
	readonly vertexKind: number
	/** The vertex count is 2 + size, capped by the configuration and the vertex type's domain. */
	readonly size: number
	readonly offset: number
	readonly keyed: boolean
	readonly contained: boolean
	/** tree: the parent of vertex i is parents[i] mod i. */
	readonly parents: ReadonlyArray<number>
	/** random and denseCycle: additional edges. */
	readonly extra: ReadonlyArray<EdgePair>
	readonly loops: ReadonlyArray<number>
	/** Edges (by index into the edge list) repeated under another id; only a keyed E holds them. */
	readonly parallel: ReadonlyArray<number>
	/** Vertices left out of V, as a bit mask; only without containments. */
	readonly missing: number
	readonly second: boolean
	readonly secondEdges: ReadonlyArray<EdgePair>
	readonly blocked: ReadonlyArray<number>
}

interface GenEdge {
	readonly id: number
	readonly from: number
	readonly to: number
}

/**
 * Graph-shaped recursive cases for the oracle.
 *
 * Every recursive lowering must be checked over chains, trees, diamonds, self-loops, dense cycles, skewed degrees,
 * parallel edges and multiple roots, and for join-versus-recursive-CTE equivalence, bound intermediate IDs, parallel
 * edges, self-loops and directions, recursive lengths including zero and nonempty cycles, and origin preservation for
 * batched roots. This file generates those cases as generators of plain sketches, resolved by pure
 * functions into ordinary oracle cases (gen/case.ts QueryCase): a schema, its facts, and one checked recursive query in
 * the LogicalQuery IR, which the conservative lowering, the reference evaluator and the optimized lowering all accept.
 *
 * The schema is a graph recognized from keys and containments, never declared as one:
 *
 * - V(id), a vertex relation whose primary key is its id;
 * - E, the edges: a pure set E(from, to), whose primary key forbids parallel edges, or E(id, from, to) keyed by a
 *   separate edge id, which permits distinct edges between the same vertices;
 * - F(from, to), an optional second edge relation, for alternatives across relation kinds;
 * - B(id), an optional fixed external relation of blocked vertices, for negation in a recursive step;
 * - optionally contained(E.from, V.id) and contained(E.to, V.id) (and the same for F); without them an edge may name
 *   a vertex that V does not hold, so an explicit V match changes the answer.
 *
 * The vertex identity is drawn from int4, text, bigint, uuid, smallint, double precision (whose NaN is one value and
 * whose -0 is 0) and an enum, every one a hashable carrier, as recursive state requires. Vertex i is the
 * i-th value class of that type from a rotating offset (gen/domain.ts), spelled once per case.
 *
 * The recursive query is one of three families, each admitted positive linear feedback:
 *
 * - reach: the endpoint closure, state (origin?, node), seeded with the roots for zero-or-more steps or with their
 *   successors for one-or-more steps, terminating by duplicate elimination over a finite carrier;
 * - walks: bounded computed state (origin?, node, hops), hops a smallint, integer or bigint counter seeded with a typed
 *   literal and advanced by `+ 1` while `hops < bound`, so several hop counts per vertex are distinct
 *   states;
 * - pairs: the transitive closure of (src, dst) pairs, right-linear (feedback ⋈ edge) or left-linear (edge ⋈ feedback),
 *   its origin the end the step keeps: bound roots seed src of a right-linear closure and dst of a left-linear one.
 *
 * Its parts vary independently: the roots (a scalar parameter, a literal, a relation parameter of roots that may repeat
 * or name no vertex, every vertex, or two base arms), whether the state carries the originating root (origin), the
 * direction (forward, reverse, or both as two transition arms factored into one typed transition relation read by one
 * feedback scan), the edge relations (E, or E and F as arms), an explicit V match on each new vertex, a negated fixed
 * relation B or an earlier completed stratum in the step, and a step predicate. Its consumer is the state itself, a
 * projection that drops state fields and so needs deduplication, a minimum-length filter then projection, an aggregate
 * over the completed recursion, a count of the edges leaving the reached vertices whose bound tuple holds the edge id,
 * so parallel edges contribute separately, two recursive sources bound differently and joined (hygiene), an acyclic
 * second recursive stage seeded from the first, an attachment of the recursion to its roots by origin (the seeded
 * recursive attachment of shapes/attach-recursive), the vertices a closure does not reach, or a predicate on the
 * completed recursion's state: its end vertex equal to a parameter or a literal, its end vertex unequal to a literal,
 * or its origin equal to one (an endpoint filter is not a seed filter, a final predicate is not safe at every
 * intermediate vertex, and only the origin filter may move into the seed). resolveRecursiveCase with a
 * RecursionMutation builds the same case with that predicate moved inside the recursion.
 *
 * fixedLengthCaseGen pairs two lowerings of one answer in one DAG: a fixed-length connected match of k edges through
 * joins and the same set through a bounded recursive relation filtered to hops = k, for the
 * check that join and recursive-CTE lowerings agree. The lengths straddle the optimizer's unroll limit: the relation
 * bounded at k has a proved depth of k - 1 (its seed is the first hop), so k up to recursionUnrollMax + 1 is unrolled
 * into joins and the length beyond stays a recursive CTE.
 *
 * Every sketch resolves (each choice is reduced modulo what is in scope, and a choice with nothing to pick from
 * degrades to a simpler valid form), so shrinking any number toward zero keeps the case valid. A DAG that fails
 * validation is a defect of this generator and throws.
 *
 * A resolved graph: vertices by index, the facts' structure, and what the case exercises.
 */
export interface GenGraph {
	readonly shape: GraphShape
	readonly kind: VertexKind
	readonly vertexType: ScalarType
	readonly n: number
	readonly offset: number
	readonly keyed: boolean
	readonly contained: boolean
	/** The vertices V holds. */
	readonly present: ReadonlyArray<number>
	readonly edges: ReadonlyArray<GenEdge>
	readonly second: ReadonlyArray<EdgePair> | undefined
	readonly blocked: ReadonlyArray<number>
}

export interface GraphLimits {
	readonly shapes: ReadonlyArray<GraphShape>
	readonly kinds: ReadonlyArray<VertexKind>
	/** The vertex count lies in [minVertices, maxVertices], capped by the vertex type's domain. */
	readonly minVertices: number
	readonly maxVertices: number
	/** Self-loops beyond the selfLoop shape's own. */
	readonly loops: boolean
	readonly edges: "any" | "set" | "keyed"
	/** "always" makes E keyed and repeats at least one edge, so parallel edges are present in every case. */
	readonly parallel: "any" | "always" | "never"
	readonly contained: "any" | boolean
	readonly second: boolean
	readonly blocked: boolean
}

export const defaultGraphLimits: GraphLimits = {
	shapes: graphShapes,
	kinds: vertexKinds,
	minVertices: 2,
	maxVertices: 7,
	loops: true,
	edges: "any",
	parallel: "any",
	contained: "any",
	second: true,
	blocked: true
}

const pairGen: Gen<EdgePair> = (source) => [source.draw(int(0, 15)), source.draw(int(0, 15))]

export const graphSketchGen: Gen<GraphSketch> = (source) => ({
	shape: source.draw(int(0, 15)),
	vertexKind: source.draw(int(0, 13)),
	size: source.draw(int(0, 9)),
	offset: source.draw(int(0, 15)),
	keyed: source.draw(boolean),
	contained: source.draw(boolean),
	parents: source.draw(array(int(0, 15), { min: 10, max: 10 })),
	extra: source.draw(array(pairGen, { min: 0, max: 12 })),
	loops: source.draw(array(int(0, 15), { min: 0, max: 2 })),
	parallel: source.draw(array(int(0, 31), { min: 0, max: 3 })),
	missing: source.draw(int(0, 255)),
	second: source.draw(boolean),
	secondEdges: source.draw(array(pairGen, { min: 0, max: 5 })),
	blocked: source.draw(array(int(0, 15), { min: 0, max: 2 }))
})

/** A sketch with every choice at its first value: the smallest graph of a family, which a hand-built case spreads. */
export const firstGraphSketch: GraphSketch = {
	shape: 0,
	vertexKind: 0,
	size: 0,
	offset: 0,
	keyed: false,
	contained: false,
	parents: Array.from({ length: 10 }, () => 0),
	extra: [],
	loops: [],
	parallel: [],
	missing: 0,
	second: false,
	secondEdges: [],
	blocked: []
}

/**
 * The value of vertex i: the i-th value class of the type, from the rotating offset, under the case's spelling. An
 * index past the domain wraps; an index at or past n names a value outside the graph (a root that is no vertex).
 */
const vertexValue = (
	graph: Pick<GenGraph, "vertexType" | "offset">,
	i: number,
	spelling: Spelling
): TypedLiteral => {
	const classes = valueClasses(graph.vertexType, false)
	const k = (i + graph.offset) % classes.length
	const cls = elementAt(classes, k, "a vertex type's classes")
	const sp =
		spelling.mode !== "perCase" || spelling.choices.length === 0 ? 0 : at(spelling.choices, k)
	return at(cls, sp)
}

const domainSize = (type: ScalarType): number => valueClasses(type, false).length

const uniquePairs = (pairs: ReadonlyArray<EdgePair>): Array<EdgePair> => {
	const out: Array<EdgePair> = []
	for (const p of pairs) {
		if (!Arr.some(out, (q) => q[0] === p[0] && q[1] === p[1])) {
			out.push(p)
		}
	}
	return out
}

/** The edge pairs of a shape over n vertices, before self-loops and parallel repeats. */
const shapePairs = (shape: GraphShape, n: number, sketch: GraphSketch): Array<EdgePair> => {
	const pairs: Array<EdgePair> = []
	switch (shape) {
		case "chain":
		case "selfLoop":
			for (let i = 0; i + 1 < n; i++) {
				pairs.push([i, i + 1])
			}
			break
		case "tree":
			for (let i = 1; i < n; i++) {
				pairs.push([at(sketch.parents, i) % i, i])
			}
			break
		case "diamond": {
			/** Stacked diamonds 0 -> {1, 2} -> 3 -> {4, 5} -> 6 ..., the vertices left over chained after the last. */
			let top = 0
			while (top + 3 < n) {
				pairs.push([top, top + 1], [top, top + 2], [top + 1, top + 3], [top + 2, top + 3])
				top += 3
			}
			for (let i = top; i + 1 < n; i++) {
				pairs.push([i, i + 1])
			}
			break
		}
		case "denseCycle":
			for (let i = 0; i < n; i++) {
				pairs.push([i, (i + 1) % n])
			}
			for (const [a, b] of Arr.filter(sketch.extra, ([x, y]) => x % n !== y % n)) {
				pairs.push([a % n, b % n])
			}
			break
		case "random":
			for (const [a, b] of sketch.extra) {
				pairs.push([a % n, b % n])
			}
			break
	}
	return uniquePairs(pairs)
}

export const resolveGraph = (sketch: GraphSketch, limits: GraphLimits): GenGraph => {
	const shape = at(limits.shapes, sketch.shape)
	const kind = at(limits.kinds, sketch.vertexKind)
	const vertexType = vertexTypeOf(kind)
	const cap = Math.min(limits.maxVertices, domainSize(vertexType))
	const n = Math.max(2, Math.min(cap, Math.max(limits.minVertices, 2 + sketch.size)))
	const keyed =
		limits.parallel === "always" || limits.edges === "keyed"
			? true
			: limits.edges === "set"
				? false
				: sketch.keyed
	const contained = limits.contained === "any" ? sketch.contained : limits.contained
	let pairs = shapePairs(shape, n, sketch)
	const loops = limits.loops ? Arr.map(sketch.loops, (l) => l % n) : []
	if (shape === "selfLoop" && loops.length === 0) {
		loops.push(n - 1)
	}
	pairs = uniquePairs([...pairs, ...Arr.map(loops, (l): EdgePair => [l, l])])
	if (pairs.length === 0) {
		pairs = [[0, 1]]
	}
	const edges: Array<GenEdge> = Arr.map(pairs, ([from, to], i) => ({ id: i + 1, from, to }))
	if (keyed && limits.parallel !== "never") {
		const repeats =
			limits.parallel === "always" && sketch.parallel.length === 0 ? [0] : sketch.parallel
		for (const r of repeats) {
			const e = at(pairs, r)
			edges.push({ id: edges.length + 1, from: e[0], to: e[1] })
		}
	}
	const present: Array<number> = []
	for (let i = 0; i < n; i++) {
		if (contained || ((sketch.missing >> i) & 1) === 0) {
			present.push(i)
		}
	}
	const second =
		limits.second && sketch.second
			? uniquePairs(Arr.map(sketch.secondEdges, ([a, b]): EdgePair => [a % n, b % n]))
			: undefined
	const blocked = limits.blocked
		? Arr.sort([...new Set(Arr.map(sketch.blocked, (b) => b % n))], Order.Number)
		: []
	return {
		shape,
		kind,
		vertexType,
		n,
		offset: sketch.offset,
		keyed,
		contained,
		present,
		edges,
		second,
		blocked
	}
}

const columns = (names: ReadonlyArray<string>, type: ScalarType) =>
	Arr.map(names, (name) => ({ name, type }))

const vertexRelation = (graph: GenGraph): GenRelation => ({
	name: "V",
	columns: columns(["id"], graph.vertexType),
	primaryKey: ["id"],
	keys: [],
	mutable: false
})

const edgeRelation = (graph: GenGraph): GenRelation =>
	graph.keyed
		? {
				name: "E",
				columns: [{ name: "id", type: int4 }, ...columns(["from", "to"], graph.vertexType)],
				primaryKey: ["id"],
				keys: [],
				mutable: false
			}
		: {
				name: "E",
				columns: columns(["from", "to"], graph.vertexType),
				primaryKey: ["from", "to"],
				keys: [],
				mutable: false
			}

const secondRelation = (graph: GenGraph): GenRelation => ({
	name: "F",
	columns: columns(["from", "to"], graph.vertexType),
	primaryKey: ["from", "to"],
	keys: [],
	mutable: false
})

const blockedRelation = (graph: GenGraph): GenRelation => ({
	name: "B",
	columns: columns(["id"], graph.vertexType),
	primaryKey: ["id"],
	keys: [],
	mutable: false
})

const graphSchema = (graph: GenGraph): GenSchema => {
	const relations: Array<GenRelation> = [vertexRelation(graph), edgeRelation(graph)]
	if (graph.second !== undefined) {
		relations.push(secondRelation(graph))
	}
	relations.push(blockedRelation(graph))
	const containments = graph.contained
		? Arr.flatMap(graph.second === undefined ? ["E"] : ["E", "F"], (r) =>
				Arr.map(["from", "to"], (f) => ({
					from: { relation: r, fields: [f] },
					to: { relation: "V", fields: ["id"] }
				}))
			)
		: []
	return {
		name: "Graph",
		relations,
		closed: graph.kind === "enum" ? [vertexRoster] : [],
		containments
	}
}

const graphFacts = (graph: GenGraph, spelling: Spelling): GenFacts => {
	const v = (i: number) => vertexValue(graph, i, spelling)
	const facts: Record<string, ReadonlyArray<LiteralRow>> = {
		V: Arr.map(graph.present, (i) => [v(i)]),
		E: Arr.map(graph.edges, (e) =>
			graph.keyed
				? [{ kind: "int", value: BigInt(e.id) } satisfies TypedLiteral, v(e.from), v(e.to)]
				: [v(e.from), v(e.to)]
		),
		B: Arr.map(graph.blocked, (i) => [v(i)])
	}
	if (graph.second !== undefined) {
		facts["F"] = Arr.map(graph.second, ([a, b]) => [v(a), v(b)])
	}
	return facts
}

const adjacency = (
	pairs: ReadonlyArray<EdgePair>,
	n: number
): ReadonlyArray<ReadonlyArray<number>> => {
	const out: Array<Array<number>> = Array.from({ length: n }, () => [])
	for (const [a, b] of pairs) {
		const successors = elementAt(out, a, "the adjacency lists")
		if (!successors.includes(b)) {
			successors.push(b)
		}
	}
	return out
}

export const isAcyclic = (pairs: ReadonlyArray<EdgePair>, n: number): boolean => {
	const adj = adjacency(pairs, n)
	const state = Array.from({ length: n }, () => 0)
	const visit = (u: number): boolean => {
		state[u] = 1
		for (const w of elementAt(adj, u, "the adjacency lists")) {
			if (state[w] === 1) {
				return false
			}
			if (state[w] === 0 && !visit(w)) {
				return false
			}
		}
		state[u] = 2
		return true
	}
	for (let u = 0; u < n; u++) {
		if (state[u] === 0 && !visit(u)) {
			return false
		}
	}
	return true
}

/**
 * Whether two distinct paths lead from one vertex to another: a vertex with two distinct predecessors both reachable
 * from a common vertex (the diamond).
 */
const hasDiamond = (pairs: ReadonlyArray<EdgePair>, n: number): boolean => {
	const adj = adjacency(pairs, n)
	const reach = (s: number): Set<number> => {
		const seen = new Set<number>([s])
		const queue = [s]
		for (const u of queue) {
			for (const w of Arr.filter(
				[...new Set(elementAt(adj, u, "the adjacency lists"))],
				(x) => !seen.has(x)
			)) {
				seen.add(w)
				queue.push(w)
			}
		}
		return seen
	}
	const reaches = Arr.map(indices(n), (s) => reach(s))
	return Arr.some(indices(n), (w) => {
		const preds = [
			...new Set(
				Arr.map(
					Arr.filter(pairs, ([a, b]) => b === w && a !== w),
					([a]) => a
				)
			)
		]
		return Arr.some(reaches, (r) => Arr.filter(preds, (p) => r.has(p)).length >= 2)
	})
}

export const edgePairs = (graph: GenGraph): ReadonlyArray<EdgePair> =>
	uniquePairs(Arr.map(graph.edges, (e): EdgePair => [e.from, e.to]))

const parallelEdgeCount = (graph: GenGraph): number => graph.edges.length - edgePairs(graph).length

const graphFeatures = (graph: GenGraph): ReadonlyArray<RecursiveFeature> => {
	const pairs = edgePairs(graph)
	const out: Array<RecursiveFeature> = [
		`shape:${graph.shape}`,
		`vertex:${graph.kind}`,
		graph.keyed ? "keyed edges" : "set edges"
	]
	if (Arr.some(pairs, ([a, b]) => a === b)) {
		out.push("self-loop")
	}
	if (parallelEdgeCount(graph) > 0) {
		out.push("parallel edges")
	}
	if (!isAcyclic(pairs, graph.n)) {
		out.push("cycle")
	}
	if (hasDiamond(pairs, graph.n)) {
		out.push("diamond")
	}
	if (graph.contained) {
		out.push("containment")
	} else if (graph.present.length < graph.n) {
		out.push("dangling edges")
	}
	if (graph.second !== undefined) {
		out.push("second edge relation")
	}
	if (graph.blocked.length > 0) {
		out.push("blocked vertices")
	}
	return out
}

const printGraph = (graph: GenGraph): string => {
	const pairs = Arr.map(graph.edges, (e) =>
		graph.keyed ? `#${e.id} ${e.from}->${e.to}` : `${e.from}->${e.to}`
	)
	const lines = [
		`graph ${graph.shape} over ${graph.n} ${graph.kind} vertices (offset ${graph.offset}), V holds [${Arr.join(Arr.map(graph.present, String), ", ")}]`,
		`  E ${graph.keyed ? "keyed" : "set"}${graph.contained ? " contained" : ""}: ${Arr.join(pairs, ", ")}`
	]
	if (graph.second !== undefined) {
		lines.push(
			`  F: ${Arr.join(
				Arr.map(graph.second, ([a, b]) => `${a}->${b}`),
				", "
			)}`
		)
	}
	if (graph.blocked.length > 0) {
		lines.push(`  B: [${Arr.join(Arr.map(graph.blocked, String), ", ")}]`)
	}
	return Arr.join(lines, "\n")
}

const recursionForms = ["reach", "walks", "pairs"] as const
export type RecursionForm = (typeof recursionForms)[number]

const rootModes = ["param", "literal", "input", "all", "arms"] as const
type RootMode = (typeof rootModes)[number]

const directions = ["forward", "reverse", "both"] as const
type Direction = (typeof directions)[number]

const stepFilters = ["none", "notLiteral", "increasing"] as const
type StepFilter = (typeof stepFilters)[number]

const blockings = ["none", "relation", "stratum"] as const
type Blocking = (typeof blockings)[number]

const consumers = [
	"state",
	"endpoints",
	"minLength",
	"count",
	"edgeCount",
	"join2",
	"stage2",
	"attach",
	"unreached",
	"endFilter",
	"endNe",
	"originFilter"
] as const
export type Consumer = (typeof consumers)[number]

const hopKinds = ["int4", "int2", "int8"] as const
type HopKind = (typeof hopKinds)[number]

interface RecursionSketch {
	readonly form: number
	readonly roots: number
	/** Vertex indices for the roots: the first for a parameter, the second for a literal, all of them as input rows. */
	readonly rootPicks: ReadonlyArray<number>
	readonly origin: boolean
	readonly oneOrMore: boolean
	readonly direction: number
	readonly viaSecond: boolean
	readonly exists: boolean
	readonly blocking: number
	readonly stepFilter: number
	readonly filterPick: number
	readonly hopKind: number
	readonly bound: number
	readonly lower: number
	readonly leftLinear: boolean
	readonly consumer: number
	/**
	 * The vertex a result predicate names (endFilter, endNe, originFilter), reduced modulo the vertex count plus one,
	 * so it is now and then a value that is no vertex; and whether endFilter and originFilter name it as a parameter.
	 */
	readonly endPick: number
	readonly endParam: boolean
	/** The picks the minted parameters' names take under RecursiveLimits.paramNames "dictionary", in minting order. */
	readonly paramNames: ReadonlyArray<number>
}

export interface RecursiveLimits {
	readonly graph: GraphLimits
	readonly forms: ReadonlyArray<RecursionForm>
	readonly roots: ReadonlyArray<RootMode>
	readonly directions: ReadonlyArray<Direction>
	readonly stepFilters: ReadonlyArray<StepFilter>
	readonly blockings: ReadonlyArray<Blocking>
	readonly consumers: ReadonlyArray<Consumer>
	readonly exists: "any" | boolean
	readonly oneOrMore: "any" | boolean
	readonly leftLinear: "any" | boolean
	readonly origin: "any" | boolean
	readonly viaSecond: boolean
	/** Each root pick as the sketch draws it, or every one forced to one vertex index (the top of a diamond, say). */
	readonly rootPick:
		| { readonly kind: "drawn" }
		| { readonly kind: "forced"; readonly vertex: number }
	readonly maxBound: number
	readonly spelling: SpellingMode
	/** How the minted parameters are named (gen/query.ts QueryConfig.paramNames). */
	readonly paramNames: "numbered" | "dictionary"
}

export const defaultRecursiveLimits: RecursiveLimits = {
	graph: defaultGraphLimits,
	forms: recursionForms,
	roots: rootModes,
	directions,
	stepFilters,
	blockings,
	consumers,
	exists: "any",
	oneOrMore: "any",
	leftLinear: "any",
	origin: "any",
	viaSecond: true,
	rootPick: { kind: "drawn" },
	maxBound: 4,
	spelling: "perCase",
	paramNames: "numbered"
}

/**
 * A pick that is the first choice more often than uniformly: a negation or a step predicate restricts a traversal,
 * and most cases should still reach far.
 */
const mostlyFirst: Gen<number> = weighted([
	[3, constant(0)],
	[2, int(0, 11)]
])

const recursionSketchGen: Gen<RecursionSketch> = (source) => ({
	form: source.draw(int(0, 11)),
	roots: source.draw(int(0, 14)),
	rootPicks: source.draw(array(int(0, 15), { min: 1, max: 4 })),
	origin: source.draw(boolean),
	oneOrMore: source.draw(boolean),
	direction: source.draw(int(0, 11)),
	viaSecond: source.draw(boolean),
	exists: source.draw(boolean),
	blocking: source.draw(mostlyFirst),
	stepFilter: source.draw(mostlyFirst),
	filterPick: source.draw(int(0, 15)),
	hopKind: source.draw(int(0, 5)),
	bound: source.draw(int(0, 7)),
	lower: source.draw(int(0, 7)),
	leftLinear: source.draw(boolean),
	consumer: source.draw(int(0, 23)),
	endPick: source.draw(int(0, 15)),
	endParam: source.draw(boolean),
	paramNames: source.draw(array(pickGen, { min: 4, max: 4 }))
})

/** A recursion sketch with every choice at its first value, which a hand-built case spreads. */
export const firstRecursionSketch: RecursionSketch = {
	form: 0,
	roots: 0,
	rootPicks: [0],
	origin: false,
	oneOrMore: false,
	direction: 0,
	viaSecond: false,
	exists: false,
	blocking: 0,
	stepFilter: 0,
	filterPick: 0,
	hopKind: 0,
	bound: 0,
	lower: 0,
	leftLinear: false,
	consumer: 0,
	endPick: 0,
	endParam: false,
	paramNames: [0]
}

interface Built {
	readonly node: RelNode
	readonly heading: Heading
}

const columnOf = (b: Built, name: string): HeadingColumn => {
	const c = Arr.findFirst(b.heading, (h) => h.name === name)
	if (Option.isNone(c)) {
		throw new Error(
			`no column ${name} in (${Arr.join(
				Arr.map(b.heading, (h) => h.name),
				", "
			)})`
		)
	}
	return c.value
}

/**
 * One occurrence of a region: its source, and for each source column the variable it binds or the expression it is
 * fixed to; every other column is an existential witness.
 */
interface OccurrenceSpec {
	readonly source: Built
	readonly bind: Readonly<Record<string, VarDecl | { readonly constant: ScalarExpr }>>
}

/**
 * What one recursion contributes to the case: whether its derivations stay finite without feedback deduplication,
 * which decides whether a UNION ALL mutant of it terminates.
 */
interface RecursionNote {
	readonly name: string
	readonly bounded: boolean
	readonly acyclic: boolean
}

/**
 * The transition relation of one recursion: a direct occurrence of E, or a typed union of transition arms with
 * heading (a, b), factored so the step reads the feedback once.
 */
type Transition =
	| { readonly kind: "direct"; readonly source: Built; readonly a: string; readonly b: string }
	| { readonly kind: "union"; readonly source: Built }

class GraphQueryBuilder {
	readonly b = new DagBuilder(makeIdSupply())
	readonly params: Record<string, GenParam> = {}
	readonly notes: Array<RecursionNote> = []
	readonly graph: GenGraph
	readonly schema: GenSchema
	readonly spelling: Spelling
	readonly #names: ParamNames
	#recursions = 0

	constructor(graph: GenGraph, spelling: Spelling, names: ParamNames) {
		this.graph = graph
		this.schema = graphSchema(graph)
		this.spelling = spelling
		this.#names = names
	}

	get vertexType(): ScalarType {
		return this.graph.vertexType
	}

	vertex(i: number): TypedLiteral {
		return vertexValue(this.graph, i, this.spelling)
	}

	col(b: Built, name: string): ScalarExpr {
		const c = columnOf(b, name)
		return this.b.expr({
			kind: "column",
			column: { node: b.node.id, name: c.name },
			args: [],
			type: c.type,
			nonNull: "storage"
		})
	}

	lit(value: TypedLiteral, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "literal",
			value,
			args: [],
			type,
			nonNull: "literal"
		})
	}

	int(value: number, type: ScalarType): ScalarExpr {
		return this.lit({ kind: "int", value: BigInt(value) }, type)
	}

	op(op: OpId, args: ReadonlyArray<ScalarExpr>, type: ScalarType): ScalarExpr {
		return this.b.expr({
			kind: "op",
			op,
			args,
			type,
			nonNull: "strict",
			volatility: "immutable",
			failure: "total"
		})
	}

	compare(op: CompareOp, left: ScalarExpr, right: ScalarExpr, operand: ScalarType): ScalarExpr {
		return this.op(compareOpId(operand, op), [left, right], bool)
	}

	/** A scalar parameter bound as its base type, under a minted name. */
	scalarParam(operandType: ScalarType, value: TypedLiteral): ScalarExpr {
		return this.namedScalarParam(operandType, value, this.#names.mint("p"))
	}

	/** A scalar parameter bound as its base type, named `param` however often it is read. */
	namedScalarParam(operandType: ScalarType, value: TypedLiteral, param: ParamId): ScalarExpr {
		const type = compareParamType(operandType)
		this.params[param] = { kind: "scalar", type, value }
		return this.b.expr({
			kind: "param",
			param,
			role: "compare",
			args: [],
			type,
			nonNull: "codec"
		})
	}

	relation(name: string): Built {
		const relation = Arr.findFirst(this.schema.relations, (r) => r.name === name)
		if (Option.isNone(relation)) {
			throw new Error(`no relation ${name}`)
		}
		const heading = relationHeading(relation.value)
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Base",
			relation: relation.value.name,
			occurrence: this.b.ids.occurrence(),
			primaryKey: nonEmptyList(relation.value.primaryKey, "a primary key"),
			keys: Arr.map(relation.value.keys, (k) => nonEmptyList(k, "a candidate key")),
			relationKind: "relation",
			heading
		})
		return { node: id, heading }
	}

	variable(name: string, type: ScalarType): VarDecl {
		return { id: this.b.ids.var(), name, type }
	}

	/** An unbound column is an existential witness. */
	region(vars: ReadonlyArray<VarDecl>, specs: ReadonlyArray<OccurrenceSpec>): Built {
		const occurrences: Array<Occurrence> = []
		for (const spec of specs) {
			const id = this.b.ids.occurrence()
			const bound = Arr.flatMap(spec.source.heading, (c) => {
				const place = Rec.has(spec.bind, c.name) ? spec.bind[c.name] : undefined
				return place === undefined ? [] : [{ column: c.name, at: place }]
			})
			const bindings = Arr.flatMap(bound, ({ column: columnName, at: place }) =>
				"constant" in place ? [] : [{ column: columnName, var: place }]
			)
			const constants = Arr.flatMap(bound, ({ column: columnName, at: place }) =>
				"constant" in place ? [{ column: columnName, expr: place.constant }] : []
			)
			occurrences.push({ id, source: spec.source.node, bindings, constants })
		}
		const heading = Arr.map(vars, (v) => column(v.name, v.type))
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "MatchRegion",
			scope: this.b.ids.scope(),
			vars: [...vars],
			occurrences,
			equalities: [],
			correlated: [],
			heading
		})
		return { node: id, heading }
	}

	filter(input: Built, pred: (input: Built) => ScalarExpr | undefined): Built {
		const p = pred(input)
		if (p === undefined) {
			return input
		}
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "Filter",
				input: input.node,
				pred: p,
				heading: input.heading
			}),
			heading: input.heading
		}
	}

	project(
		input: Built,
		out: ReadonlyArray<readonly [string, (input: Built) => ScalarExpr, ScalarType]>
	): Built {
		const heading = Arr.map(out, ([name, , type]) => column(name, type))
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "ProjectSet",
			input: input.node,
			out: Arr.map(out, ([name, expr]) => ({ name, expr: expr(input) })),
			heading
		})
		return { node: id, heading }
	}

	/** Projects the named columns of `input` under new names. */
	rename(input: Built, pairs: ReadonlyArray<readonly [string, string]>): Built {
		return this.project(
			input,
			Arr.map(
				pairs,
				([to, from]) => [to, (i: Built) => this.col(i, from), columnOf(input, from).type] as const
			)
		)
	}

	anti(left: Built, right: Built, on: ReadonlyArray<readonly [string, string]>): Built {
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "AntiJoin",
			left: left.node,
			right: right.node,
			on: Arr.map(on, ([l, r]) => ({ left: l, right: r })),
			heading: left.heading
		})
		return { node: id, heading: left.heading }
	}

	union(arms: ReadonlyArray<Built>): Built {
		const [first, ...rest] = arms
		if (first === undefined) {
			throw new Error("a union of no arms")
		}
		if (rest.length === 0) {
			return first
		}
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Union",
			groups: [{ heading: first.heading, arms: [first.node, ...Arr.map(rest, (a) => a.node)] }],
			discriminant: [],
			heading: first.heading
		})
		return { node: id, heading: first.heading }
	}

	difference(left: Built, right: Built): Built {
		return {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "Difference",
				left: left.node,
				right: right.node,
				heading: left.heading
			}),
			heading: left.heading
		}
	}

	/** count over the distinct complete input tuples, grouped by `keys`. */
	group(input: Built, keys: KeySet, countName: string): Built {
		return this.groupOver(
			input,
			keys,
			Arr.map(input.heading, (c) => c.name),
			countName
		)
	}

	/**
	 * count over the distinct bound tuples `bound`, grouped by `keys` (only the bound tuple
	 * contributes).
	 */
	groupOver(input: Built, keys: KeySet, bound: KeySet, countName: string): Built {
		const heading = [
			...Arr.map(keys, (k) => column(k, columnOf(input, k).type)),
			column(countName, scalarOfSpec({ carrier: "int8" }))
		]
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Group",
			input: input.node,
			bound: [...bound],
			keys: [...keys],
			aggs: [{ name: countName, fn: "count", op: OpId("count"), args: [], filter: undefined }],
			heading
		})
		return { node: id, heading }
	}

	attach(
		parent: Built,
		child: Built,
		correlation: ReadonlyArray<readonly [string, string]>,
		name: string
	): Built {
		const id = this.b.node({
			loc: undefined,
			meta: conservativeMeta,
			kind: "Attach",
			parent: parent.node,
			child: child.node,
			name,
			correlation: Arr.map(correlation, ([p, c]) => ({ parent: p, child: c })),
			delivered: "array",
			heading: parent.heading,
			order: undefined
		})
		return { node: id, heading: parent.heading }
	}

	/** A recursive relation over `state`: its base, then its step reading the SelfRef handle. */
	recursive(
		state: Heading,
		origin: KeySet,
		estimate: bigint,
		kind: "finiteCarrier" | "boundedState",
		base: () => Built,
		step: (self: Built) => Built
	): Built {
		const rec = this.b.reserve()
		const self: Built = {
			node: this.b.node({
				loc: undefined,
				meta: conservativeMeta,
				kind: "SelfRef",
				recursive: rec,
				heading: state
			}),
			heading: state
		}
		const baseBuilt = base()
		const stepBuilt = step(self)
		const recursive = this.b.define(rec, {
			loc: undefined,
			meta: conservativeMeta,
			kind: "Recursive",
			name: `graph${++this.#recursions}`,
			base: baseBuilt.node,
			step: stepBuilt.node,
			self: self.node,
			termination: { kind, stateEstimate: estimate, premises: [] },
			origin: [...origin],
			heading: state
		})
		return { node: recursive, heading: state }
	}

	/** The vertices of V, as (name). */
	vertices(name: string): Built {
		const x = this.variable(name, this.vertexType)
		return this.region([x], [{ source: this.relation("V"), bind: { id: x } }])
	}

	/**
	 * The roots, as a relation (root): from V filtered to a parameter or a literal, a relation parameter, every
	 * vertex, or two base arms (several base arms remain a set union).
	 */
	roots(mode: RootMode, picks: ReadonlyArray<number>): Built {
		const t = this.vertexType
		const fromV = (value: (input: Built) => ScalarExpr): Built => {
			const x = this.variable("root", t)
			const region = this.region([x], [{ source: this.relation("V"), bind: { id: x } }])
			return this.filter(region, (r) => this.compare("eq", this.col(r, "root"), value(r), t))
		}
		const first = at(picks, 0)
		const second = at(picks, 1)
		switch (mode) {
			case "param":
				return fromV(() => this.scalarParam(t, this.vertex(first)))
			case "literal":
				return fromV(() => this.lit(this.vertex(second), t))
			case "all":
				return this.vertices("root")
			case "arms":
				return this.union([
					fromV(() => this.scalarParam(t, this.vertex(first))),
					fromV(() => this.lit(this.vertex(second), t))
				])
			case "input": {
				/**
				 * A relation parameter of roots: repeats are one fact, and a pick of index n names the
				 * value just past the graph, which is no vertex whenever the type's domain is larger than the graph.
				 */
				const heading = [column("root", t)]
				const param = this.#names.mint("r")
				this.params[param] = {
					kind: "relation",
					heading,
					rows: Arr.map(picks, (p) => [
						vertexValue(this.graph, p % (this.graph.n + 1), this.spelling)
					])
				}
				return {
					node: this.b.node({
						loc: undefined,
						meta: conservativeMeta,
						kind: "InputSet",
						input: { kind: "declared", param },
						heading
					}),
					heading
				}
			}
		}
	}

	/** The transition relation for a direction over E, or E and F as arms. */
	transition(direction: Direction, viaSecond: boolean): Transition {
		const relations = viaSecond && this.graph.second !== undefined ? ["E", "F"] : ["E"]
		if (relations.length === 1 && direction !== "both") {
			const source = this.relation("E")
			return direction === "forward"
				? { kind: "direct", source, a: "from", b: "to" }
				: { kind: "direct", source, a: "to", b: "from" }
		}
		const t = this.vertexType
		const arms: Array<Built> = []
		for (const r of relations) {
			const orientations: ReadonlyArray<readonly [string, string]> =
				direction === "forward"
					? [["from", "to"]]
					: direction === "reverse"
						? [["to", "from"]]
						: [
								["from", "to"],
								["to", "from"]
							]
			for (const [a, b] of orientations) {
				const rel = this.relation(r)
				arms.push(
					this.project(rel, [
						["a", (i) => this.col(i, a), t],
						["b", (i) => this.col(i, b), t]
					])
				)
			}
		}
		return { kind: "union", source: this.union(arms) }
	}

	/** The occurrence of a transition binding its source end to `a` and its target end to `b`. */
	transitionOccurrence(t: Transition, a: VarDecl, b: VarDecl): OccurrenceSpec {
		return t.kind === "direct"
			? { source: t.source, bind: { [t.a]: a, [t.b]: b } }
			: { source: t.source, bind: { a, b } }
	}

	/** The edge pairs a transition walks, for termination notes. */
	transitionPairs(direction: Direction, viaSecond: boolean): ReadonlyArray<EdgePair> {
		const base = [
			...edgePairs(this.graph),
			...(viaSecond && this.graph.second !== undefined ? this.graph.second : [])
		]
		const reversed = Arr.map(base, ([a, b]): EdgePair => [b, a])
		return direction === "forward"
			? base
			: direction === "reverse"
				? reversed
				: [...base, ...reversed]
	}
}

interface RecursiveQueryParts {
	readonly form: RecursionForm
	readonly roots: RootMode
	readonly origin: boolean
	readonly oneOrMore: boolean
	readonly direction: Direction
	readonly viaSecond: boolean
	readonly exists: boolean
	readonly blocking: Blocking
	readonly stepFilter: StepFilter
	readonly hopKind: HopKind
	readonly bound: number
	readonly lower: number
	readonly leftLinear: boolean
	readonly consumer: Consumer
	readonly endPick: number
	readonly endParam: boolean
}

const resolveParts = (s: RecursionSketch, limits: RecursiveLimits): RecursiveQueryParts => {
	const form = at(limits.forms, s.form)
	return {
		form,
		roots: at(limits.roots, s.roots),
		origin: limits.origin === "any" ? s.origin : limits.origin,
		oneOrMore: limits.oneOrMore === "any" ? s.oneOrMore : limits.oneOrMore,
		direction: at(limits.directions, s.direction),
		viaSecond: limits.viaSecond && s.viaSecond,
		exists: limits.exists === "any" ? s.exists : limits.exists,
		blocking: at(limits.blockings, s.blocking),
		stepFilter: at(limits.stepFilters, s.stepFilter),
		hopKind: at(hopKinds, s.hopKind),
		bound: 1 + (s.bound % limits.maxBound),
		lower: s.lower,
		leftLinear: limits.leftLinear === "any" ? s.leftLinear : limits.leftLinear,
		consumer: at(limits.consumers, s.consumer),
		endPick: s.endPick,
		endParam: s.endParam
	}
}

const hopType = (kind: HopKind): ScalarType => scalarOfSpec({ carrier: kind })

/**
 * The roots relation of a recursion: built from the case's root mode, or one the caller already built (an attachment's
 * parent).
 */
type RecursionRoots = { readonly kind: "built" } | { readonly kind: "given"; readonly node: Built }

/**
 * Where a recursion mutant places a result predicate inside the recursion: nowhere, on the seed's state, or on every
 * state, seed and step alike.
 */
type InsidePredicate =
	| { readonly kind: "none" }
	| { readonly kind: "seed"; readonly pred: (seed: Built) => ScalarExpr }
	| { readonly kind: "everyState"; readonly pred: (state: Built) => ScalarExpr }

const builtRoots: RecursionRoots = { kind: "built" }
const nothingInside: InsidePredicate = { kind: "none" }

/** One recursion of the case, built from its parts with a choice of roots. */
const buildRecursion = (
	q: GraphQueryBuilder,
	parts: RecursiveQueryParts,
	picks: ReadonlyArray<number>,
	filterPick: number,
	options: {
		readonly origin: boolean
		readonly roots: RootMode
		readonly rootsNode: RecursionRoots
		readonly inside: InsidePredicate
	}
): Built => {
	const rootsOf = (): Built =>
		options.rootsNode.kind === "given" ? options.rootsNode.node : q.roots(options.roots, picks)
	const inside = options.inside
	const seedOut = (seed: Built): Built =>
		inside.kind === "none" ? seed : q.filter(seed, inside.pred)
	const stepOut = (step: Built): Built =>
		inside.kind === "everyState" ? q.filter(step, inside.pred) : step
	const t = q.vertexType
	const g = q.graph
	const transition = q.transition(parts.direction, parts.viaSecond)
	const pairs = q.transitionPairs(parts.direction, parts.viaSecond)
	const origin = options.origin
	/**
	 * The step's region less its negated input on `next`: none, the fixed relation B, or an earlier completed stratum,
	 * the closure of a literal vertex over the reversed edges. The negated input is built here, before the recursion.
	 */
	const block = ((): ((region: Built, next: string) => Built) => {
		switch (parts.blocking) {
			case "none":
				return (region) => region
			case "relation": {
				const source = q.relation("B")
				return (region, next) => q.anti(region, source, [[next, "id"]])
			}
			case "stratum": {
				const source = stratum(q, filterPick)
				return (region, next) => q.anti(region, source, [[next, "node"]])
			}
		}
	})()
	const stepFilter = (region: Built, current: string, next: string): ScalarExpr | undefined => {
		switch (parts.stepFilter) {
			case "none":
				return undefined
			case "notLiteral":
				return q.compare("ne", q.col(region, next), q.lit(q.vertex(filterPick), t), t)
			case "increasing":
				return q.compare("gt", q.col(region, next), q.col(region, current), t)
		}
	}
	const acyclic = parts.stepFilter === "increasing" || isAcyclic(pairs, g.n)

	if (parts.form === "pairs") {
		/**
		 * Transitive closure of pairs: base the transition's pairs from the roots, unless every vertex
		 * roots it; the step extends a pair by one transition on the right or on the left. The origin is the end the
		 * step keeps, so it carries the root: a right-linear closure binds the roots to src and walks
		 * forward from them, a left-linear one binds them to dst, its base the transitions s -> root, and walks back.
		 */
		const state = [column("src", t), column("dst", t)]
		const estimate = BigInt(domainSize(t)) ** 2n
		q.notes.push({ name: "pairs", bounded: false, acyclic })
		return q.recursive(
			state,
			[parts.leftLinear ? "dst" : "src"],
			estimate,
			"finiteCarrier",
			() => {
				const s = q.variable("src", t)
				const d = q.variable("dst", t)
				if (options.roots === "all") {
					return seedOut(
						q.project(q.region([s, d], [q.transitionOccurrence(transition, s, d)]), [
							["src", (i) => q.col(i, "src"), t],
							["dst", (i) => q.col(i, "dst"), t]
						])
					)
				}
				const roots = rootsOf()
				const root = parts.leftLinear ? d : s
				return seedOut(
					q.project(
						q.region(
							[s, d],
							[{ source: roots, bind: { root } }, q.transitionOccurrence(transition, s, d)]
						),
						[
							["src", (i) => q.col(i, "src"), t],
							["dst", (i) => q.col(i, "dst"), t]
						]
					)
				)
			},
			(self) => {
				const s = q.variable("src", t)
				const m = q.variable("mid", t)
				const d = q.variable("dst", t)
				const occurrences = parts.leftLinear
					? [q.transitionOccurrence(transition, s, m), { source: self, bind: { src: m, dst: d } }]
					: [{ source: self, bind: { src: s, dst: m } }, q.transitionOccurrence(transition, m, d)]
				const next = parts.leftLinear ? "src" : "dst"
				const vertexOcc = parts.exists
					? [{ source: q.relation("V"), bind: { id: parts.leftLinear ? s : d } }]
					: []
				let region = q.region([s, m, d], [...occurrences, ...vertexOcc])
				region = block(
					q.filter(region, (r) => stepFilter(r, "mid", next)),
					next
				)
				return stepOut(
					q.project(region, [
						["src", (i) => q.col(i, "src"), t],
						["dst", (i) => q.col(i, "dst"), t]
					])
				)
			}
		)
	}

	const walks = parts.form === "walks"
	const ht = hopType(parts.hopKind)
	const state: Heading = [
		...(origin ? [column("origin", t)] : []),
		column("node", t),
		...(walks ? [column("hops", ht)] : [])
	]
	const domain = BigInt(domainSize(t))
	const estimate = (origin ? domain * domain : domain) * (walks ? BigInt(parts.bound + 1) : 1n)
	q.notes.push({ name: parts.form, bounded: walks, acyclic })
	const out = (seedOrigin: string, node: string, hops: (i: Built) => ScalarExpr) =>
		[
			...(origin ? [["origin", (i: Built) => q.col(i, seedOrigin), t] as const] : []),
			["node", (i: Built) => q.col(i, node), t] as const,
			...(walks ? [["hops", hops, ht] as const] : [])
		] as const
	return q.recursive(
		state,
		origin ? ["origin"] : [],
		estimate,
		walks ? "boundedState" : "finiteCarrier",
		() => {
			/**
			 * The seed: the roots themselves for zero-or-more steps, or their successors for one-or-more steps,
			 * with an explicit V match when existence is asked for.
			 */
			const roots = rootsOf()
			const r = q.variable("root", t)
			if (!parts.oneOrMore) {
				const occ: Array<OccurrenceSpec> = [{ source: roots, bind: { root: r } }]
				if (parts.exists && options.roots === "input") {
					occ.push({ source: q.relation("V"), bind: { id: r } })
				}
				return seedOut(
					q.project(
						q.region([r], occ),
						out("root", "root", () => q.int(0, ht))
					)
				)
			}
			const x = q.variable("next", t)
			const occ: Array<OccurrenceSpec> = [
				{ source: roots, bind: { root: r } },
				q.transitionOccurrence(transition, r, x)
			]
			if (parts.exists) {
				occ.push({ source: q.relation("V"), bind: { id: x } })
			}
			return seedOut(
				q.project(
					q.region([r, x], occ),
					out("root", "next", () => q.int(1, ht))
				)
			)
		},
		(self) => {
			const o = q.variable("origin", t)
			const c = q.variable("node", t)
			const h = q.variable("hops", ht)
			const x = q.variable("next", t)
			const selfBind: Record<string, VarDecl> = { node: c }
			if (origin) {
				selfBind["origin"] = o
			}
			if (walks) {
				selfBind["hops"] = h
			}
			const occ: Array<OccurrenceSpec> = [
				{ source: self, bind: selfBind },
				q.transitionOccurrence(transition, c, x)
			]
			if (parts.exists) {
				occ.push({ source: q.relation("V"), bind: { id: x } })
			}
			const vars = [...(origin ? [o] : []), c, ...(walks ? [h] : []), x]
			let region = q.region(vars, occ)
			if (walks) {
				/** The bound is answer semantics: checked on the current state before it is advanced. */
				const lt = OpId(`${parts.hopKind}lt`)
				region = q.filter(region, (i) => q.op(lt, [q.col(i, "hops"), q.int(parts.bound, ht)], bool))
			}
			region = block(
				q.filter(region, (i) => stepFilter(i, "node", "next")),
				"next"
			)
			const pl = OpId(`${parts.hopKind}pl`)
			return stepOut(
				q.project(
					region,
					out("origin", "next", (i) => q.op(pl, [q.col(i, "hops"), q.int(1, ht)], ht))
				)
			)
		}
	)
}

/** The completed stratum a step may negate: the vertices that reach a literal vertex, as (node). */
const stratum = (q: GraphQueryBuilder, pick: number): Built => {
	const t = q.vertexType
	const target = q.vertex(pick + 1)
	q.notes.push({
		name: "stratum",
		bounded: false,
		acyclic: isAcyclic(edgePairs(q.graph), q.graph.n)
	})
	return q.recursive(
		[column("node", t)],
		[],
		BigInt(domainSize(t)),
		"finiteCarrier",
		() => {
			const x = q.variable("node", t)
			const region = q.region([x], [{ source: q.relation("V"), bind: { id: x } }])
			return q.filter(region, (r) => q.compare("eq", q.col(r, "node"), q.lit(target, t), t))
		},
		(self) => {
			const c = q.variable("node", t)
			const p = q.variable("prev", t)
			const region = q.region(
				[c, p],
				[
					{ source: self, bind: { node: c } },
					{ source: q.relation("E"), bind: { from: p, to: c } }
				]
			)
			return q.rename(region, [["node", "prev"]])
		}
	)
}

/** The end column of a recursion's state: the vertex its traversal reached. */
const endColumn = (parts: RecursiveQueryParts): string =>
	parts.form === "pairs" ? (parts.leftLinear ? "src" : "dst") : "node"

const originColumn = (parts: RecursiveQueryParts): string | undefined =>
	parts.form === "pairs" ? (parts.leftLinear ? "dst" : "src") : undefined

/**
 * A recursion mutant: the case's own query with a result predicate placed inside the recursion, the way an optimizer
 * might push it. Each applies to one consumer and leaves every other case as it is.
 *
 * - endFilterIntoSeed (endFilter): the filter on the completed recursion's end vertex applied to the seed instead. An
 *   endpoint filter is not a seed filter, so this is unsound: a chain or a diamond tells it apart.
 * - neFilterIntoStep (endNe): the predicate end <> v applied at every state, seed and step, instead of to the result.
 *   A final predicate is not safe at every intermediate vertex: a chain through v tells it apart.
 * - originFilterIntoSeed (originFilter): the filter on the origin applied to the seed. Every state keeps its seed's
 *   origin, so this is a valid pushdown of a bound root, and it agrees on every case.
 */
const recursionMutations = [
	"endFilterIntoSeed",
	"neFilterIntoStep",
	"originFilterIntoSeed"
] as const
export type RecursionMutation = (typeof recursionMutations)[number]
/** The case a sketch names ("unmutated"), or a mutant of it. */
export type RecursionMove = "unmutated" | RecursionMutation

/** The root of the query: the recursion under its consumer. */
const buildConsumer = (
	q: GraphQueryBuilder,
	parts: RecursiveQueryParts,
	sketch: RecursionSketch,
	limits: RecursiveLimits,
	mutation: RecursionMove
): RelNode => {
	const t = q.vertexType
	const forced = limits.rootPick
	const picks =
		forced.kind === "drawn" ? sketch.rootPicks : Arr.map(sketch.rootPicks, () => forced.vertex)
	/** The case's recursion with its origin, roots and inside predicate chosen; main is the case's own. */
	const recursion = (
		origin: boolean,
		roots: RootMode,
		rootsNode: RecursionRoots,
		inside: InsidePredicate
	) => buildRecursion(q, parts, picks, sketch.filterPick, { origin, roots, rootsNode, inside })
	const main = () => recursion(parts.origin, parts.roots, builtRoots, nothingInside)
	const end = endColumn(parts)
	/** The vertex a result predicate names, as a literal or one scalar parameter however often it is read. */
	const endVertex = q.vertex(parts.endPick % (q.graph.n + 1))
	const endValue = (): ScalarExpr =>
		parts.endParam ? q.namedScalarParam(t, endVertex, ParamId("pe")) : q.lit(endVertex, t)
	switch (parts.consumer) {
		case "state":
			return main().node
		case "endpoints": {
			/** A projection that drops state fields: distinct routes and origins collapse here. */
			const rec = main()
			return q.rename(rec, [["node", end]]).node
		}
		case "minLength": {
			/** The lower bound is a result predicate, the upper bound the recursion's. */
			const rec = main()
			if (parts.form !== "walks") {
				return q.rename(rec, [["node", end]]).node
			}
			const ht = hopType(parts.hopKind)
			const lower = parts.lower % (parts.bound + 1)
			const filtered = q.filter(rec, (i) =>
				q.op(OpId(`${parts.hopKind}ge`), [q.col(i, "hops"), q.int(lower, ht)], bool)
			)
			return q.rename(filtered, [
				...(parts.origin ? [["origin", "origin"] as const] : []),
				["node", "node"]
			]).node
		}
		case "count": {
			/** Aggregation over a completed recursion is ordinary composition. */
			const rec = main()
			const key = parts.form === "pairs" ? originColumn(parts) : parts.origin ? "origin" : undefined
			return q.group(rec, key === undefined ? [] : [key], "states").node
		}
		case "edgeCount": {
			/**
			 * The edges leaving the reached vertices, counted per origin. A keyed edge relation binds the edge id, so
			 * parallel edges are distinct contributions; endpoints alone would merge them.
			 */
			const rec = main()
			const key = parts.form === "pairs" ? originColumn(parts) : parts.origin ? "origin" : undefined
			const o = q.variable("origin", t)
			const c = q.variable("node", t)
			const e = q.variable("edge", int4)
			const x = q.variable("next", t)
			const recBind: Record<string, VarDecl> = { [end]: c }
			if (key !== undefined) {
				recBind[key] = o
			}
			const edgeBind: Record<string, VarDecl> = q.graph.keyed
				? { id: e, from: c, to: x }
				: { from: c, to: x }
			const vars = [...(key === undefined ? [] : [o]), c, ...(q.graph.keyed ? [e] : []), x]
			const region = q.region(vars, [
				{ source: rec, bind: recBind },
				{ source: q.relation("E"), bind: edgeBind }
			])
			const keys = key === undefined ? [] : ["origin"]
			return q.groupOver(
				region,
				keys,
				[...keys, ...(q.graph.keyed ? ["edge"] : ["node", "next"])],
				"edges"
			).node
		}
		case "join2": {
			/**
			 * Two imports of one recursive definition bound differently, matched on the vertex they reach: neither
			 * captures the other's parameter.
			 */
			const first = recursion(
				false,
				parts.roots === "all" ? "param" : parts.roots,
				builtRoots,
				nothingInside
			)
			const secondPicks = Arr.map(picks, (p) => p + 1)
			const second = buildRecursion(q, parts, secondPicks, sketch.filterPick, {
				origin: false,
				roots: parts.roots === "param" || parts.roots === "all" ? "param" : "literal",
				rootsNode: builtRoots,
				inside: nothingInside
			})
			const x = q.variable("node", t)
			return q.region(
				[x],
				[
					{ source: first, bind: { [end]: x } },
					{ source: second, bind: { [end]: x } }
				]
			).node
		}
		case "stage2": {
			/**
			 * An acyclic sequence of recursive stages: the second closes the first's endpoints over F, or
			 * over the reversed E when the case has no F.
			 */
			const rec = main()
			const second = q.graph.second
			const stagePairs = second ?? Arr.map(edgePairs(q.graph), ([a, b]): EdgePair => [b, a])
			q.notes.push({ name: "stage2", bounded: false, acyclic: isAcyclic(stagePairs, q.graph.n) })
			return q.recursive(
				[column("node", t)],
				[],
				BigInt(domainSize(t)),
				"finiteCarrier",
				() => {
					const x = q.variable("node", t)
					return q.region([x], [{ source: rec, bind: { [end]: x } }])
				},
				(self) => {
					const c = q.variable("node", t)
					const y = q.variable("next", t)
					const edge = second === undefined ? { from: y, to: c } : { from: c, to: y }
					const region = q.region(
						[c, y],
						[
							{ source: self, bind: { node: c } },
							{ source: q.relation(second === undefined ? "E" : "F"), bind: edge }
						]
					)
					return q.rename(region, [["node", "next"]])
				}
			).node
		}
		case "attach": {
			/**
			 * The recursion attached to its roots, its state carrying the originating root: the
			 * attachment seeds the recursion from the parent-key recordset.
			 */
			const roots = parts.roots === "all" || parts.roots === "input" ? parts.roots : "input"
			const parent = q.roots(roots, picks)
			const rec = recursion(true, roots, { kind: "given", node: parent }, nothingInside)
			return q.attach(parent, rec, [["root", originColumn(parts) ?? "origin"]], "reached").node
		}
		case "unreached": {
			/** The vertices the closure does not reach: a completed stratum negated outside the recursion. */
			const rec = main()
			return q.difference(q.vertices("node"), q.rename(rec, [["node", end]])).node
		}
		case "endFilter": {
			/**
			 * The completed recursion filtered on the vertex it reached (node, or dst or src of a pair closure): an
			 * endpoint filter, which is not a seed filter.
			 */
			const pred = (b: Built) => q.compare("eq", q.col(b, end), endValue(), t)
			if (mutation === "endFilterIntoSeed") {
				return recursion(parts.origin, parts.roots, builtRoots, { kind: "seed", pred }).node
			}
			return q.filter(main(), pred).node
		}
		case "endNe": {
			/** The completed recursion without one vertex: a final predicate, not safe at every intermediate vertex. */
			const pred = (b: Built) => q.compare("ne", q.col(b, end), q.lit(endVertex, t), t)
			if (mutation === "neFilterIntoStep") {
				return recursion(parts.origin, parts.roots, builtRoots, { kind: "everyState", pred }).node
			}
			return q.filter(main(), pred).node
		}
		case "originFilter": {
			/**
			 * The completed recursion filtered on its origin (origin, or src of a right-linear and dst of a left-linear
			 * pair closure): every state keeps its seed's origin, so this one is a valid seed filter.
			 */
			const origin = originColumn(parts) ?? "origin"
			const pred = (b: Built) => q.compare("eq", q.col(b, origin), endValue(), t)
			if (mutation === "originFilterIntoSeed") {
				return recursion(true, parts.roots, builtRoots, { kind: "seed", pred }).node
			}
			return q.filter(recursion(true, parts.roots, builtRoots, nothingInside), pred).node
		}
	}
}

/**
 * What a recursive case reached, as its resolver lists it: the graph's shape and structure, the recursion's form,
 * roots, direction, consumer and options, and a fixed-length case's length.
 */
export type RecursiveFeature =
	| `shape:${GraphShape}`
	| `vertex:${VertexKind}`
	| "keyed edges"
	| "set edges"
	| "self-loop"
	| "parallel edges"
	| "cycle"
	| "diamond"
	| "containment"
	| "dangling edges"
	| "second edge relation"
	| "blocked vertices"
	| `form:${RecursionForm}`
	| `roots:${RootMode}`
	| `direction:${Direction}`
	| `consumer:${Consumer}`
	| "one-or-more"
	| "zero-or-more"
	| "origin"
	| "multiple roots carrying origin"
	| "result filter:param"
	| "result filter:literal"
	| "alternative relations"
	| "existence match"
	| `negation:${Exclude<Blocking, "none">}`
	| `step filter:${Exclude<StepFilter, "none">}`
	| `hops:${HopKind}`
	| "left-linear"
	| "right-linear"
	| "relation roots over text"
	| `length:${number}`

export interface RecursiveCase extends QueryCase {
	readonly graph: GenGraph
	readonly parts: RecursiveQueryParts
	readonly features: ReadonlyArray<RecursiveFeature>
	/**
	 * Every recursion of the query keeps finitely many derivations without feedback deduplication (bounded hops or an
	 * acyclic traversal), so a UNION ALL mutant of it terminates.
	 */
	readonly terminatesAsBag: boolean
	readonly label: string
	/**
	 * What the case was resolved from, so a recursion mutant can rebuild it with a predicate moved; a fixed-length case
	 * is built by hand from its own sketch.
	 */
	readonly source:
		| {
				readonly kind: "resolved"
				readonly sketch: RecursiveCaseSketch
				readonly limits: RecursiveLimits
		  }
		| { readonly kind: "fixedLength" }
}

interface RecursiveCaseSketch {
	readonly graph: GraphSketch
	readonly recursion: RecursionSketch
	readonly spelling: ReadonlyArray<number>
}

const spellingGen: Gen<ReadonlyArray<number>> = array(int(0, 2), {
	min: spellingChoiceCount,
	max: spellingChoiceCount
})

export const recursiveCaseSketchGen: Gen<RecursiveCaseSketch> = (source) => ({
	graph: source.draw(graphSketchGen),
	recursion: source.draw(recursionSketchGen),
	spelling: source.draw(spellingGen)
})

const finishQuery = (q: GraphQueryBuilder, roots: Rooted): GenQuery => {
	const dag = normalQuery(q.b.build(roots))
	const read = new Set<string>(Arr.flatMap(dag.roots, (root) => root.meta.paramDeps))
	const params: Record<string, GenParam> = {}
	for (const [id, p] of Rec.toEntries(q.params)) {
		if (read.has(id)) {
			params[id] = p
		}
	}
	return { dag, params }
}

const partsFeatures = (parts: RecursiveQueryParts): ReadonlyArray<RecursiveFeature> => {
	const out: Array<RecursiveFeature> = [
		`form:${parts.form}`,
		`roots:${parts.roots}`,
		`direction:${parts.direction}`,
		`consumer:${parts.consumer}`,
		parts.oneOrMore ? "one-or-more" : "zero-or-more"
	]
	const carriesOrigin =
		parts.origin ||
		parts.consumer === "attach" ||
		parts.consumer === "originFilter" ||
		parts.form === "pairs"
	if (carriesOrigin) {
		out.push("origin")
	}
	if (
		(parts.roots === "input" || parts.roots === "all" || parts.roots === "arms") &&
		carriesOrigin
	) {
		out.push("multiple roots carrying origin")
	}
	if (parts.consumer === "endFilter" || parts.consumer === "originFilter") {
		out.push(parts.endParam ? "result filter:param" : "result filter:literal")
	}
	if (parts.viaSecond) {
		out.push("alternative relations")
	}
	if (parts.exists) {
		out.push("existence match")
	}
	if (parts.blocking !== "none") {
		out.push(`negation:${parts.blocking}`)
	}
	if (parts.stepFilter !== "none") {
		out.push(`step filter:${parts.stepFilter}`)
	}
	if (parts.form === "walks") {
		out.push(`hops:${parts.hopKind}`)
	}
	if (parts.form === "pairs") {
		out.push(parts.leftLinear ? "left-linear" : "right-linear")
	}
	return out
}

/**
 * The case a sketch names; with a mutation, the same case with that result predicate moved inside the recursion. A
 * mutant names the same parameters with the same values, so its query runs against the case's facts and bindings.
 *
 * A relation of text roots: a relation parameter, or an attachment's parent-key recordset (its text
 * column names pg_c_utf8, as the stored columns the step reads do).
 */
export const resolveRecursiveCase = (
	sketch: RecursiveCaseSketch,
	limits: RecursiveLimits,
	mutation: RecursionMove
): RecursiveCase => {
	const spelling: Spelling = { mode: limits.spelling, choices: sketch.spelling, edge: false }
	const graph = resolveGraph(sketch.graph, limits.graph)
	const parts = resolveParts(sketch.recursion, limits)
	const q = new GraphQueryBuilder(
		graph,
		spelling,
		new ParamNames(limits.paramNames, sketch.recursion.paramNames)
	)
	const root = buildConsumer(q, parts, sketch.recursion, limits, mutation)
	const query = finishQuery(q, [root])
	const features: Array<RecursiveFeature> = [...graphFeatures(graph), ...partsFeatures(parts)]
	if (graph.kind === "text" && (parts.roots === "input" || parts.consumer === "attach")) {
		features.push("relation roots over text")
	}
	const terminatesAsBag = Arr.every(q.notes, (n) => n.bounded || n.acyclic)
	const label = `${printGraph(graph)}\nrecursion ${JSON.stringify(parts)}`
	return {
		schema: q.schema,
		facts: graphFacts(graph, spelling),
		query,
		spelling,
		graph,
		parts,
		features,
		terminatesAsBag,
		label: mutation === "unmutated" ? label : `${label}\nmutation ${mutation}`,
		source: { kind: "resolved", sketch, limits }
	}
}

export const recursiveCaseGen = (limits: RecursiveLimits): Gen<RecursiveCase> =>
	map(recursiveCaseSketchGen, (s) => resolveRecursiveCase(s, limits, "unmutated"))

interface FixedLengthCase extends RecursiveCase {
	/**
	 * The same answer through a bounded recursive relation filtered to hops = length; the case's own root is the
	 * connected match through joins.
	 */
	readonly recursiveRoot: RelNode
	readonly length: number
}

interface FixedLengthSketch {
	readonly graph: GraphSketch
	readonly length: number
	readonly allRoots: boolean
	readonly rootPick: number
	readonly exists: boolean
	readonly reverse: boolean
	readonly hopKind: number
	readonly spelling: ReadonlyArray<number>
}

const fixedLengthSketchGen: Gen<FixedLengthSketch> = (source) => ({
	graph: source.draw(graphSketchGen),
	length: source.draw(int(1, recursionUnrollMax + 2)),
	allRoots: source.draw(boolean),
	rootPick: source.draw(int(0, 15)),
	exists: source.draw(boolean),
	reverse: source.draw(boolean),
	hopKind: source.draw(int(0, 5)),
	spelling: source.draw(spellingGen)
})

const resolveFixedLengthCase = (
	sketch: FixedLengthSketch,
	graphLimits: GraphLimits
): FixedLengthCase => {
	const spelling: Spelling = { mode: "perCase", choices: sketch.spelling, edge: false }
	const graph = resolveGraph(sketch.graph, graphLimits)
	/** Its one parameter is named p1 by hand, both forms reading it; it mints no other. */
	const q = new GraphQueryBuilder(graph, spelling, new ParamNames("numbered", []))
	const t = q.vertexType
	const k = sketch.length
	const hopKind = at(hopKinds, sketch.hopKind)
	const ht = hopType(hopKind)
	const [from, to] = sketch.reverse ? (["to", "from"] as const) : (["from", "to"] as const)
	const root = q.vertex(sketch.rootPick)
	const paramId = ParamId("p1")
	const startFilter = (b: Built, columnName: string): Built =>
		sketch.allRoots
			? b
			: q.filter(b, (i) =>
					q.compare("eq", q.col(i, columnName), q.namedScalarParam(t, root, paramId), t)
				)
	const head = (start: string, end: string) =>
		[...(sketch.allRoots ? [["origin", start] as const] : []), ["node", end] as const] as const

	/**
	 * The connected match: start, k - 1 bound intermediate vertices, end, each step one E fact, each vertex matched in
	 * V when existence is asked for. Distinct middles collapse at the final projection.
	 */
	const names = Arr.map(indices(k + 1), (i) => (i === 0 ? "start" : i === k ? "end" : `mid${i}`))
	const vars = Arr.map(names, (n) => q.variable(n, t))
	const occ: Array<OccurrenceSpec> = []
	for (let i = 0; i < k; i++) {
		if (sketch.exists) {
			occ.push({
				source: q.relation("V"),
				bind: { id: elementAt(vars, i, "the walk's variables") }
			})
		}
		occ.push({
			source: q.relation("E"),
			bind: {
				[from]: elementAt(vars, i, "the walk's variables"),
				[to]: elementAt(vars, i + 1, "the walk's variables")
			}
		})
	}
	if (sketch.exists) {
		occ.push({ source: q.relation("V"), bind: { id: elementAt(vars, k, "the walk's variables") } })
	}
	const joins = q.rename(startFilter(q.region(vars, occ), "start"), head("start", "end"))

	/** The same set through a recursive relation: one-or-more steps with the hop count as state, then hops = k. */
	const parts: RecursiveQueryParts = {
		form: "walks",
		roots: sketch.allRoots ? "all" : "param",
		origin: sketch.allRoots,
		oneOrMore: true,
		direction: sketch.reverse ? "reverse" : "forward",
		viaSecond: false,
		exists: sketch.exists,
		blocking: "none",
		stepFilter: "none",
		hopKind,
		bound: k,
		lower: k,
		leftLinear: false,
		consumer: "minLength",
		endPick: 0,
		endParam: false
	}
	const state: Heading = [
		...(sketch.allRoots ? [column("origin", t)] : []),
		column("node", t),
		column("hops", ht)
	]
	const domain = BigInt(domainSize(t))
	const rec = q.recursive(
		state,
		sketch.allRoots ? ["origin"] : [],
		(sketch.allRoots ? domain * domain : domain) * BigInt(k + 1),
		"boundedState",
		() => {
			const s = q.variable("start", t)
			const x = q.variable("next", t)
			const seed: Array<OccurrenceSpec> = []
			if (sketch.exists) {
				seed.push({ source: q.relation("V"), bind: { id: s } })
			}
			seed.push({ source: q.relation("E"), bind: { [from]: s, [to]: x } })
			if (sketch.exists) {
				seed.push({ source: q.relation("V"), bind: { id: x } })
			}
			return q.project(startFilter(q.region([s, x], seed), "start"), [
				...(sketch.allRoots ? [["origin", (i: Built) => q.col(i, "start"), t] as const] : []),
				["node", (i: Built) => q.col(i, "next"), t] as const,
				["hops", () => q.int(1, ht), ht] as const
			])
		},
		(self) => {
			const o = q.variable("origin", t)
			const c = q.variable("node", t)
			const h = q.variable("hops", ht)
			const x = q.variable("next", t)
			const bind: Record<string, VarDecl> = { node: c, hops: h }
			if (sketch.allRoots) {
				bind["origin"] = o
			}
			const step: Array<OccurrenceSpec> = [
				{ source: self, bind },
				{ source: q.relation("E"), bind: { [from]: c, [to]: x } }
			]
			if (sketch.exists) {
				step.push({ source: q.relation("V"), bind: { id: x } })
			}
			const region = q.filter(q.region([...(sketch.allRoots ? [o] : []), c, h, x], step), (i) =>
				q.op(OpId(`${hopKind}lt`), [q.col(i, "hops"), q.int(k, ht)], bool)
			)
			return q.project(region, [
				...(sketch.allRoots ? [["origin", (i: Built) => q.col(i, "origin"), t] as const] : []),
				["node", (i: Built) => q.col(i, "next"), t] as const,
				[
					"hops",
					(i: Built) => q.op(OpId(`${hopKind}pl`), [q.col(i, "hops"), q.int(1, ht)], ht),
					ht
				] as const
			])
		}
	)
	const exact = q.filter(rec, (i) =>
		q.op(OpId(`${hopKind}eq`), [q.col(i, "hops"), q.int(k, ht)], bool)
	)
	const recursive = q.rename(exact, head("origin", "node"))
	const query = finishQuery(q, [joins.node, recursive.node])
	const features: Array<RecursiveFeature> = [
		...graphFeatures(graph),
		`length:${k}`,
		sketch.allRoots ? "multiple roots carrying origin" : "roots:param"
	]
	if (sketch.exists) {
		features.push("existence match")
	}
	if (sketch.reverse) {
		features.push("direction:reverse")
	}
	return {
		schema: q.schema,
		facts: graphFacts(graph, spelling),
		query,
		spelling,
		graph,
		parts,
		features,
		terminatesAsBag: true,
		label: `${printGraph(graph)}\nfixed length ${k}${sketch.allRoots ? " from every vertex" : ` from vertex ${sketch.rootPick}`}${sketch.exists ? " with existence" : ""}${sketch.reverse ? " reversed" : ""}`,
		source: { kind: "fixedLength" },
		recursiveRoot: elementAt(query.dag.roots, 1, "the DAG's roots"),
		length: k
	}
}

export const fixedLengthCaseGen = (graphLimits: GraphLimits): Gen<FixedLengthCase> =>
	map(fixedLengthSketchGen, (s) => resolveFixedLengthCase(s, graphLimits))
