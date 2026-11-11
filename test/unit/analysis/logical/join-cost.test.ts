/**
 * The logical analysis of k relations matched in one region, each of two columns a and b, each its own declared key,
 * no variable shared: 2^k minimal keys, which one proof states over k independent factors (logical/props.ts finish).
 * Its work is counted, never timed (test/support/kernel/calls.ts), so no verdict depends on the machine.
 *
 * Property: the closures it computes and the minimal-key searches it runs grow no faster than linearly in k, where
 * listing every minimal key grew with 2^k: counted at k = 2h, 4h and 6h, each count increments no more over the second
 * step than over the first (test/support/growth.ts incrementsDoNotGrow). The counts are process-wide, so the gate runs
 * alone in its file.
 *
 * Box: h at 2 and 3, exhausted. Oracle: universal, the increments of a count that grows no faster than linearly.
 * Assumption: no count changes shape above some k.
 *
 * Plants (~/.cache/grizzle-release/BR03/plants): join-cost-key-search-per-pair (a key search run for each factor once
 * per factor, k² of them).
 *
 * Features: from k = 4, from k = 6.
 */ import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { indices } from "#compiler/core/array.ts"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { conservativeMeta, type ValidDag, type VarDecl } from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"

import { plainType } from "#compiler/scalar/native.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { type CallSite, callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"

const int4 = plainType("int4")

/** The functions the gate counts: every closure the analysis computes, and every minimal-key search. */
const sites = {
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" },
	minimalKeys: { file: "packages/engine/src/logical/closure.ts", name: "minimalKeys" }
} satisfies Readonly<Record<string, CallSite>>

/** k relations R0.. of columns a and b, each its own key, matched in one region delivering every variable. */
const productOf = (k: number): ValidDag => {
	const b = new DagBuilder(makeIdSupply())
	const vars: Array<VarDecl> = []
	const occurrences = Arr.map(indices(k), (i) => {
		const bound = Arr.map(["a", "b"], (column) => {
			const v: VarDecl = { id: b.ids.var(), name: `${column}${i}`, type: int4 }
			vars.push(v)
			return { column, var: v }
		})
		return {
			id: b.ids.occurrence(),
			source: b.node({
				kind: "Base",
				relation: `R${i}`,
				occurrence: b.ids.occurrence(),
				primaryKey: ["a"],
				keys: [["b"]],
				relationKind: "relation",
				heading: [
					{ name: "a", type: int4 },
					{ name: "b", type: int4 }
				],
				loc: undefined,
				meta: conservativeMeta
			}),
			bindings: bound,
			constants: []
		}
	})
	return b.build([
		b.node({
			kind: "MatchRegion",
			scope: b.ids.scope(),
			vars,
			occurrences,
			equalities: [],
			correlated: [],
			heading: Arr.map(vars, (v) => ({ name: v.name, type: v.type })),
			loc: undefined,
			meta: conservativeMeta
		})
	])
}

type Point = "from k = 4" | "from k = 6"

describe("the analysis of k joined relations of two keys each", () => {
	it.effect("computes linearly many closures and key searches in k, never 2^k", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/logical/join-cost",
					box: "k relations at 2h, 4h and 6h, h at 2 and 3",
					generator: int(2, 3),
					literal: Formatter.format,
					limit: 2,
					coverage: requiredInSpace<Point>(["from k = 4", "from k = 6"]),
					caseHang,
					oracle: {
						kind: "universal",
						name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
					}
				},
				(half, c) =>
					Effect.gen(function* () {
						c.note(half === 2 ? "from k = 4" : "from k = 6")
						const counted = new Map<number, Readonly<Record<keyof typeof sites, number>>>()
						for (const k of [2 * half, 4 * half, 6 * half]) {
							const [, counts] = yield* callCounts(
								Effect.sync(() => succeeded(analyzeLogical(productOf(k), checkerEvidence))),
								sites
							)
							counted.set(k, counts)
						}
						for (const site of ["closure", "minimalKeys"] as const) {
							incrementsDoNotGrow(
								(k) => defined(counted.get(k), `the counts at k = ${k}`)[site],
								half,
								`${site} calls`
							)
						}
					})
			)
		)
	)
})
