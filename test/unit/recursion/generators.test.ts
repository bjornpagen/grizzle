import { describe, it } from "@effect/vitest"
import { drawn, explore, sketched } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { assert, containsEqual, defined, like, matchers } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	defaultRecursiveLimits,
	edgePairs,
	type GenGraph,
	graphSketchGen,
	isAcyclic,
	type RecursiveLimits,
	recursiveCaseSketchGen,
	resolveGraph,
	resolveRecursiveCase
} from "#test/support/oracle/gen/recursive.ts"

/**
 * The graph-shaped recursive generators themselves. Host only:
 * these checks need no database.
 *
 * - each graph shape is the shape it names, and the parallel-edge, cycle and diamond features are true of the facts;
 * - terminatesAsBag holds exactly when every recursion's derivations stay finite without deduplication.
 */

const pairsOf = (graph: GenGraph) => Arr.filter(edgePairs(graph), ([a, b]) => a !== b)

describe("graph-shaped recursive generators", () => {
	it.effect("build each graph shape as named", (ctx) =>
		Effect.gen(function* () {
			const plain = { loops: false, parallel: "never" as const, edges: "set" as const }
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "recursion/generators-shapes",
						draw: drawn(graphSketchGen),
						literal: Formatter.format,
						coverage: noCoverage,
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch) =>
						Effect.sync(() => {
							const chain = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								...plain,
								shapes: ["chain"]
							})
							assert.deepEqual(
								edgePairs(chain),
								Arr.map(indices(chain.n - 1), (i) => [i, i + 1])
							)
							const tree = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								...plain,
								shapes: ["tree"]
							})
							assert.equal(pairsOf(tree).length, tree.n - 1)
							assert.equal(new Set(Arr.map(pairsOf(tree), ([, b]) => b)).size, tree.n - 1)
							assert.equal(isAcyclic(edgePairs(tree), tree.n), true)
							const diamond = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								...plain,
								shapes: ["diamond"],
								minVertices: 4
							})
							like(
								edgePairs(diamond),
								matchers.arrayContaining([
									[0, 1],
									[0, 2],
									[1, 3],
									[2, 3]
								])
							)
							assert.equal(isAcyclic(edgePairs(diamond), diamond.n), true)
							const loop = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								...plain,
								shapes: ["selfLoop"]
							})
							assert.equal(
								Arr.some(edgePairs(loop), ([a, b]) => a === b),
								true
							)
							const dense = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								...plain,
								shapes: ["denseCycle"]
							})
							for (let i = 0; i < dense.n; i++) {
								containsEqual(edgePairs(dense), [i, (i + 1) % dense.n])
							}
							assert.equal(isAcyclic(edgePairs(dense), dense.n), false)
							const parallel = resolveGraph(sketch, {
								...defaultRecursiveLimits.graph,
								parallel: "always"
							})
							assert.equal(parallel.keyed, true)
							assert.ok(parallel.edges.length > edgePairs(parallel).length)
							assert.equal(
								new Set(Arr.map(parallel.edges, (e) => e.id)).size,
								parallel.edges.length
							)
						})
				)
			)
		})
	)

	it.effect("mark the cases whose recursions terminate without feedback deduplication", (ctx) =>
		Effect.gen(function* () {
			const limits = {
				...defaultRecursiveLimits,
				graph: { ...defaultRecursiveLimits.graph, second: false, blocked: false },
				viaSecond: false,
				stepFilters: ["none"],
				blockings: ["none"],
				consumers: ["state"]
			} satisfies RecursiveLimits
			const cyclic = (pairs: ReadonlyArray<readonly [number, number]>, n: number): boolean => {
				const next = Arr.map(indices(n), (v) =>
					Arr.map(
						Arr.filter(pairs, ([a]) => a === v),
						([, b]) => b
					)
				)
				/** 0 unvisited, 1 on the current path, 2 done. */
				const state: Array<number> = Array.from({ length: n }, () => 0)
				const visit = (v: number): boolean => {
					state[v] = 1
					for (const w of defined(next[v])) {
						if (state[w] === 1) {
							return true
						}
						if (state[w] === 0 && visit(w)) {
							return true
						}
					}
					state[v] = 2
					return false
				}
				return Arr.some([...indices(n)], (v) => state[v] === 0 && visit(v))
			}
			type BagFeature =
				`${"reach" | "walks" | "pairs"} ${"forward" | "reverse" | "both"} ${"terminates" | "loops"}`
			yield* searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "recursion/generators-bag-termination",
						draw: sketched(recursiveCaseSketchGen, (sketch) =>
							resolveRecursiveCase(sketch, limits, "unmutated")
						),
						literal: Formatter.format,
						coverage: required<BagFeature>(
							[
								"reach forward terminates",
								"reach forward loops",
								"reach reverse loops",
								"reach both loops",
								"walks both terminates",
								"pairs forward terminates",
								"pairs forward loops"
							],
							{ cases: 300, sense: notesOnly }
						),
						kept: [],
						runs: 300,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(c, n) =>
						Effect.sync(() => {
							const forward = edgePairs(c.graph)
							const traversed =
								c.parts.direction === "forward"
									? forward
									: c.parts.direction === "reverse"
										? Arr.map(forward, ([a, b]) => [b, a] as const)
										: [...forward, ...Arr.map(forward, ([a, b]) => [b, a] as const)]
							const terminates = c.parts.form === "walks" || !cyclic(traversed, c.graph.n)
							n.note(`${c.parts.form} ${c.parts.direction} ${terminates ? "terminates" : "loops"}`)
							assert.equal(c.terminatesAsBag, terminates, c.label)
						})
				)
			)
		})
	)
})
