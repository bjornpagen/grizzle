/**
 * The logical analysis of k relations matched in one region, each of two columns a and b, each its own declared key,
 * no variable shared: 2^k minimal keys, which one proof states over k independent factors (logical/props.ts finish).
 * Its work is counted, never timed (test/support/kernel/calls.ts), so no verdict depends on the machine: the closures
 * it computes and the minimal-key searches it runs grow linearly from k relations to 2k, where listing every minimal
 * key grew with 2^k. The counts are process-wide, so the gate runs alone in its file.
 *
 * The box is exhausted: k at 4, 5 and 6, each against twice it.
 */
import { describe, it } from "@effect/vitest"
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
import { plainType } from "#compiler/scalar/compute/types.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { type CallSite, callCounts } from "#test/support/kernel/calls.ts"
import { caseHang } from "#test/support/limits.ts"

const int4 = plainType("int4")

/** The functions the gate counts: every closure the analysis computes, and every minimal-key search. */
const sites = {
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" },
	minimalKeys: { file: "packages/engine/src/logical/closure.ts", name: "minimalKeys" }
} satisfies Readonly<Record<string, CallSite>>

/** The bound on growth from k relations to 2k: linear, with room for the parts that do not grow. */
const linear = 2.5

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

type Point = "k=4" | "k=5" | "k=6"

describe("the analysis of k joined relations of two keys each", () => {
	it.effect("computes linearly many closures and key searches in k, never 2^k", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/analysis/logical/join-cost",
					box: "k relations from 4 to 6, each against twice as many",
					generator: int(4, 6),
					literal: Formatter.format,
					limit: 3,
					coverage: requiredInSpace<Point>(["k=4", "k=5", "k=6"]),
					caseHang,
					oracle: {
						kind: "specification",
						name: "the closures and key searches at 2k relations at most linear times those at k"
					}
				},
				(k, c) =>
					Effect.gen(function* () {
						c.note(k === 4 ? "k=4" : k === 5 ? "k=5" : "k=6")
						const [, small] = yield* callCounts(
							Effect.sync(() => succeeded(analyzeLogical(productOf(k), checkerEvidence))),
							sites
						)
						const [, large] = yield* callCounts(
							Effect.sync(() => succeeded(analyzeLogical(productOf(2 * k), checkerEvidence))),
							sites
						)
						for (const site of ["closure", "minimalKeys"] as const) {
							assert.ok(
								large[site] <= linear * small[site],
								`${site}: ${small[site]} calls at k = ${k}, ${large[site]} at ${2 * k}`
							)
						}
					})
			)
		)
	)
})
