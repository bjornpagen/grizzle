import { layer } from "@effect/vitest"
import { drawn } from "@grizzle/testing/explore"
import { type Coverage, noCoverage, required } from "@grizzle/testing/features"
import { filter, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Data, Effect, Formatter, Option } from "effect"
import {
	bagRecursion,
	type CaseLowering,
	feedbackUnionAllMutant,
	forCase,
	rebuiltAs,
	type RecursionOracleFeature,
	recursiveEquivalence,
	repeatsStates,
	told,
	undercounts
} from "#test/pg/recursion/oracle/support.ts"
import {
	defaultRecursiveLimits,
	edgePairs,
	type GenGraph,
	type GraphLimits,
	type RecursiveCase,
	type RecursiveFeature,
	type RecursiveLimits,
	recursiveCaseGen,
	vertexKinds
} from "#test/support/oracle/gen/recursive.ts"

import {
	conservative,
	defaultRunOptions,
	type Lowering,
	oracleCheck,
	printOutcome,
	runOracle
} from "#test/support/oracle/runner.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The diamond and parallel-edge counterexamples of recursive deduplication: a UNION ALL feedback mutant is killed by
 * the diamond case.
 *
 * Each invalid rewrite is the conservative lowering post-processed the way an unsound optimizer would rewrite it, run
 * on PostgreSQL beside the conservative lowering and compared as raw text sets:
 *
 * - feedback UNION ALL on a diamond. Recursive UNION is not replaced with UNION ALL merely because each edge table is
 *   unique, the graph is acyclic, the traversal is depth-bounded, or each transition individually looks unique: two
 *   paths through a diamond can produce the same state. The diamond's edges are a pure set and acyclic, and still, on
 *   every generated diamond rooted at its top, the mutant repeats a state.
 * - a bag recursion on a chain or a tree with parallel edges: no diamond at all, but E keyed by an edge id permits two
 *   distinct edges between the same vertices, so a recursion that trusts each transition to be unique
 *   and drops its deduplication repeats every state below a parallel edge.
 * - erased edge identity before an aggregate: counting the edges that leave the reached vertices by their endpoints
 *   instead of their bound edge id merges the parallel edges, distinct facts, into one contribution (duplicate
 *   elimination never erases a distinct fact merely because its endpoints agree). Without
 *   parallel edges the same rewrite is indistinguishable, which the control population shows.
 *
 * - an endpoint filter moved into the seed. An endpoint filter is not automatically a seed filter: the
 *   completed closure of a chain's or a diamond's top filtered to a vertex below it holds that vertex; the seed filtered
 *   to it holds nothing, so the rewritten recursion is empty (or, seeded on a successor, walks on past it).
 * - a final inequality applied at every state. A predicate on final results is not automatically safe at every
 *   intermediate vertex: on a chain, dropping a vertex inside the recursion drops everything past it.
 *
 * Plants (main's test phase): recursion-conservative-feedback-union-all.patch.
 */

/**
 * The diamond 0 -> {1, 2} -> 3 over integer vertices 0, 1, -1, 2 (the first value classes), its edges a pure set,
 * contained in V, rooted at the top by a literal.
 */
const diamondLimits = (
	overrides: Partial<Omit<RecursiveLimits, "graph">> & { readonly graph: Partial<GraphLimits> }
): RecursiveLimits => ({
	...defaultRecursiveLimits,
	...overrides,
	graph: {
		...defaultRecursiveLimits.graph,
		shapes: ["diamond"],
		kinds: ["int4"],
		edges: "set",
		contained: true,
		second: false,
		blocked: false,
		loops: false,
		minVertices: 4,
		...overrides.graph
	},
	forms: ["reach"],
	roots: ["literal"],
	directions: ["forward"],
	stepFilters: ["none"],
	blockings: ["none"],
	consumers: ["state"],
	exists: false,
	origin: false,
	viaSecond: false,
	oneOrMore: false,
	leftLinear: false,
	rootPick: { kind: "forced", vertex: 0 },
	...withoutGraph(overrides)
})

const withoutGraph = <A extends { readonly graph: unknown }>(a: A): Omit<A, "graph"> => {
	const { graph: omitted, ...rest } = a
	return rest
}

/**
 * The hop distance of every vertex from vertex 0 (unreached vertices absent), over forward edges.
 *
 * The iteration visits the vertices pushed while it runs.
 */
const distances = (graph: GenGraph): ReadonlyMap<number, number> => {
	const out = new Map<number, number>([[0, 0]])
	const queue = [0]
	for (const v of queue) {
		const d = out.get(v)
		if (d === undefined) {
			throw new Error(`vertex ${v} queued without its distance`)
		}
		for (const [a, b] of edgePairs(graph)) {
			if (a === v && !out.has(b)) {
				out.set(b, d + 1)
				queue.push(b)
			}
		}
	}
	return out
}

/** Result predicates over closures of vertex 0 along forward edges, no step predicate, negation or second relation. */
const resultLimits = (
	consumer: "endFilter" | "endNe" | "originFilter",
	shapes: GraphLimits["shapes"],
	forms: RecursiveLimits["forms"]
): RecursiveLimits => ({
	...defaultRecursiveLimits,
	graph: {
		...defaultRecursiveLimits.graph,
		shapes,
		kinds: vertexKinds,
		contained: true,
		second: false,
		blocked: false,
		loops: false,
		minVertices: 3
	},
	forms,
	roots: ["literal"],
	rootPick: { kind: "forced", vertex: 0 },
	directions: ["forward"],
	stepFilters: ["none"],
	blockings: ["none"],
	consumers: [consumer],
	oneOrMore: false,
	leftLinear: false,
	viaSecond: false
})

/** The vertex index a case's result predicate names. */
const endIndex = (c: RecursiveCase): number => c.parts.endPick % (c.graph.n + 1)

class NotKilled extends Data.TaggedError("NotKilled")<{ readonly message: string }> {}

const run = (c: RecursiveCase, left: Lowering, right: Lowering) =>
	Effect.gen(function* () {
		const s = yield* Substrate
		const schema = yield* s.schema({ create: false, label: "counterexample" })
		return yield* runOracle(c, left, right, {
			...defaultRunOptions,
			schema: { kind: "named", name: schema }
		})
	})

/**
 * A kill population: every case the suite explores tells `mutant` apart from the conservative lowering in the given
 * shape, and is the kind of case the population is about (`about`: a message when it is not), each case's generator
 * features noted through its case, the population reaching what its `coverage` requires.
 */
interface Kills {
	readonly suite: string
	readonly runs: number
	readonly mutant: CaseLowering<RecursiveCase>
	readonly shape: (o: Parameters<typeof repeatsStates>[0]) => boolean
	readonly coverage: Coverage<RecursionOracleFeature>
	/**
	 * The cases the population is about, and what a case outside them lacks: every case, for a population whose
	 * generator plants its precondition.
	 */
	readonly about: { readonly holds: (c: RecursiveCase) => boolean; readonly otherwise: string }
}

/** The `about` of a population whose every case is the kind it is about. */
const everyCase: Kills["about"] = { holds: () => true, otherwise: "" }

/**
 * How many draws a population's precondition gets before its case is discarded: each draw is a whole case sketch,
 * cheap beside the run, and every precondition here holds for a fair share of the generator's cases.
 */
const attempts = 100

const killsEvery = (generator: Gen<RecursiveCase>, kills: Kills) =>
	oracleCheck(
		drawn(generator),
		{
			suite: kills.suite,
			oracle: {
				kind: "second-implementation",
				name: "the conservative lowering's raw text sets, beside each invalid rewrite"
			},
			literal: Formatter.format,
			coverage: kills.coverage,
			kept: [],
			runs: kills.runs,
			shrink: completeShrink,
			perturb: "none"
		},
		(c, notes) =>
			Effect.gen(function* () {
				notes.noteAll(c.features)
				if (!kills.about.holds(c)) {
					return yield* new NotKilled({
						message: `outside the population: ${kills.about.otherwise}`
					})
				}
				const outcome = yield* run(c, conservative, forCase(kills.mutant, c))
				if (!kills.shape(outcome)) {
					return yield* new NotKilled({
						message: `not killed as expected:\n${printOutcome(outcome)}`
					})
				}
			})
	)

const parallelLimits = (parallel: "always" | "never") =>
	({
		...defaultRecursiveLimits,
		graph: {
			...defaultRecursiveLimits.graph,
			parallel,
			edges: "keyed",
			contained: true,
			second: false
		},
		forms: ["reach", "walks"],
		roots: ["all"],
		consumers: ["edgeCount"],
		oneOrMore: false,
		stepFilters: ["none"],
		blockings: ["none"]
	}) satisfies RecursiveLimits

layer(Substrate.layer)("recursive deduplication counterexamples", (it) => {
	it.effect(
		"every generated diamond rooted at its top kills feedback UNION ALL, whatever its vertex type, edge model, seed or state",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const limits = diamondLimits({
						graph: {
							shapes: ["diamond"],
							kinds: vertexKinds,
							edges: "any",
							contained: true,
							second: false,
							blocked: false,
							loops: false,
							minVertices: 4
						},
						forms: ["reach", "walks", "pairs"],
						roots: ["literal", "input", "all", "arms"],
						origin: "any",
						exists: "any",
						oneOrMore: "any",
						maxBound: 4
					})
					/** Walks need at least two hops to meet at the bottom of a diamond. */
					const generator = filter(
						recursiveCaseGen(limits),
						(c) => c.parts.form !== "walks" || c.parts.bound >= 2,
						attempts
					)
					return yield* killsEvery(generator, {
						suite: "recursion/kills-diamond",
						runs: 300,
						mutant: feedbackUnionAllMutant,
						shape: repeatsStates,
						coverage: required<RecursionOracleFeature>(
							[...Arr.map(vertexKinds, (k): RecursiveFeature => `vertex:${k}`), "parallel edges"],
							{ cases: 300, sense: notesOnly }
						),
						about: {
							holds: (c) => c.features.includes("diamond") && c.terminatesAsBag,
							otherwise: "no terminating diamond"
						}
					})
				})
			)
	)

	it.effect(
		"every generated chain or tree with parallel edges kills a bag recursion from its root",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const limits = diamondLimits({
						graph: {
							shapes: ["chain", "tree"],
							kinds: vertexKinds,
							minVertices: 2,
							parallel: "always",
							contained: true,
							second: false,
							blocked: false,
							loops: false
						},
						forms: ["reach", "walks"],
						oneOrMore: "any",
						exists: "any",
						origin: "any",
						maxBound: 4
					})
					/** The repeated edge must lie within the walk's bound from the root. */
					const generator = filter(
						recursiveCaseGen(limits),
						(c) => {
							const depth = (v: number): number =>
								Option.match(
									Arr.findFirst(c.graph.edges, (e) => e.to === v),
									{
										onNone: () => 0,
										onSome: (into) => 1 + depth(into.from)
									}
								)
							const repeated = Arr.findFirst(
								c.graph.edges,
								(e, i) =>
									!Option.contains(
										Arr.findFirstIndex(c.graph.edges, (f) => f.from === e.from && f.to === e.to),
										i
									)
							)
							if (Option.isNone(repeated)) {
								return false
							}
							const repeatedEdge = repeated.value
							/**
							 * Seeded with hops 0 at the root or hops 1 at its successors, a walk crosses an edge that leaves a vertex
							 * at depth d at hops d + 1 either way.
							 */
							const hopsToIt = depth(repeatedEdge.from) + 1
							return c.parts.form !== "walks" || hopsToIt <= c.parts.bound
						},
						attempts
					)
					return yield* killsEvery(generator, {
						suite: "recursion/kills-parallel",
						runs: 200,
						mutant: bagRecursion,
						shape: repeatsStates,
						coverage: noCoverage,
						about: {
							holds: (c) => !c.features.includes("diamond") && c.terminatesAsBag,
							otherwise: "a diamond, or no terminating bag"
						}
					})
				})
			)
	)

	it.effect(
		"every generated graph with parallel edges kills the erased edge identity, and without them it is invisible",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					yield* killsEvery(recursiveCaseGen(parallelLimits("always")), {
						suite: "recursion/kills-edge-identity",
						runs: 200,
						mutant: rebuiltAs("edgeIdentityErased"),
						shape: (o) => undercounts(o, "edges") && !o.comparison.equal,
						coverage: noCoverage,
						about: {
							holds: (c) => c.features.includes("parallel edges"),
							otherwise: "no parallel edges"
						}
					})
					/** The control: the same rewrite over keyed edges with no parallel pair agrees on every case. */
					const control = yield* recursiveEquivalence(
						recursiveCaseGen(parallelLimits("never")),
						rebuiltAs("edgeIdentityErased"),
						conservative,
						{
							suite: "recursion/parallel-edges-control",
							oracle: {
								kind: "second-implementation",
								name: "the conservative lowering's raw text sets, beside each invalid rewrite"
							},
							literal: Formatter.format,
							coverage: noCoverage,
							kept: [],
							runs: 200,
							shrink: completeShrink,
							/** Facts repeated under fresh edge ids are parallel edges, which this population excludes. */
							perturb: "planner"
						}
					)
					return control
				})
			)
	)

	it.effect(
		"every generated chain, tree or diamond filtered to a vertex its root reaches kills the endpoint filter in the seed",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const limits = resultLimits(
						"endFilter",
						["chain", "tree", "diamond"],
						["reach", "walks", "pairs"]
					)
					/** Seeded on a successor of the root, the rewritten pair closure differs only if it can walk on. */
					const generator = filter(
						recursiveCaseGen(limits),
						(c) => {
							const v = endIndex(c)
							const d = distances(c.graph).get(v)
							if (d === undefined || d === 0) {
								return false
							}
							if (c.parts.form === "walks") {
								return d <= c.parts.bound
							}
							return (
								c.parts.form !== "pairs" || d > 1 || Arr.some(edgePairs(c.graph), ([a]) => a === v)
							)
						},
						attempts
					)
					return yield* killsEvery(generator, {
						suite: "recursion/kills-end-filter",
						runs: 200,
						mutant: rebuiltAs("endFilterIntoSeed"),
						shape: told,
						coverage: required<RecursionOracleFeature>(
							[
								"shape:chain",
								"shape:tree",
								"shape:diamond",
								"form:reach",
								"form:walks",
								"form:pairs",
								"result filter:param",
								"result filter:literal"
							],
							{ cases: 200, sense: notesOnly }
						),
						about: everyCase
					})
				})
			)
	)

	it.effect(
		"every generated chain without a vertex before its end kills the inequality applied at every state",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const limits = resultLimits("endNe", ["chain"], ["reach", "pairs"])
					/** Vertex v of the chain lies before its end; a pair closure from 0 never reaches dst = 0 at all. */
					const generator = filter(
						recursiveCaseGen(limits),
						(c) => {
							const v = endIndex(c)
							return v <= c.graph.n - 2 && (c.parts.form !== "pairs" || v >= 1)
						},
						attempts
					)
					return yield* killsEvery(generator, {
						suite: "recursion/kills-end-ne",
						runs: 200,
						mutant: rebuiltAs("neFilterIntoStep"),
						shape: told,
						coverage: required<RecursionOracleFeature>(["form:reach", "form:pairs"], {
							cases: 200,
							sense: notesOnly
						}),
						about: everyCase
					})
				})
			)
	)
})
