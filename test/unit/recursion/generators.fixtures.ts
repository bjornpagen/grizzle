/** What the properties of generators.test.ts read: its spaces, models and helpers. */

import type { Need } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { indices } from "#compiler/core/array.ts"
import { defined } from "#test/support/assert.ts"
import {
	defaultRecursiveLimits,
	edgePairs,
	type GenGraph,
	type RecursiveLimits
} from "#test/support/oracle/gen/recursive.ts"

/** A graph's edges as pairs, without its self-loops. */
export const pairsOf = (graph: GenGraph) => Arr.filter(edgePairs(graph), ([a, b]) => a !== b)

/**
 * The bag search's cases: every graph, form and direction, without the second relation, blocking or a step filter, and
 * one consumer, so a recursion's termination is its edges' alone.
 */
export const limits: RecursiveLimits = {
	...defaultRecursiveLimits,
	graph: { ...defaultRecursiveLimits.graph, second: false, blocked: false },
	viaSecond: false,
	stepFilters: ["none"],
	blockings: ["none"],
	consumers: ["state"]
}

/** Whether the edges hold a cycle: a depth-first search that meets a vertex on its current path. */
export const cyclic = (pairs: ReadonlyArray<readonly [number, number]>, n: number): boolean => {
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

/** A recursion's form and direction, and whether its derivations stay finite without deduplication. */
export type BagFeature =
	`${"reach" | "walks" | "pairs"} ${"forward" | "reverse" | "both"} ${"terminates" | "loops"}`

/** What the search built once before its cases (plain), now once per worker: every case on it reads them. */
export const plainNeed = {
	key: "test/unit/recursion/generators.fixtures.ts plainNeed",
	open: Effect.sync(() => {
		const plain = { loops: false, parallel: "never" as const, edges: "set" as const }
		return Effect.succeed(plain)
	})
} as const satisfies Need<unknown>
