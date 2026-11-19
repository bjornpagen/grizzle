/** What the properties of join-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { Array as Arr } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { conservativeMeta, type ValidDag, type VarDecl } from "#compiler/ir/rel.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { CallSite } from "#test/support/kernel/calls.ts"

const int4 = plainType("int4")

/** The functions the gate counts: every closure the analysis computes, and every minimal-key search. */
export const sites = Object.freeze({
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" },
	minimalKeys: { file: "packages/engine/src/logical/closure.ts", name: "minimalKeys" }
} satisfies Readonly<Record<string, CallSite>>)

/** k relations R0.. of columns a and b, each its own key, matched in one region delivering every variable. */
export const productOf = (k: number): ValidDag => {
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

export type Point = "from k = 4" | "from k = 6"
