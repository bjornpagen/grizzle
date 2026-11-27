/** What the properties of join-cost.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import type { NonEmptyReadonlyArray } from "@bjornpagen/grizzle-text/base/nonempty"
import { Array as Arr } from "effect"
import { makeIdSupply } from "#compiler/core/ids.ts"
import { DagBuilder } from "#compiler/ir/builder.ts"
import { conservativeMeta, type ValidDag, type VarDecl } from "#compiler/ir/rel.ts"
import { plainType } from "#compiler/scalar/native.ts"
import type { CountedFunction } from "#test/support/kernel/calls.ts"

const int4 = plainType("int4")

/** The functions the gate counts: every closure the analysis computes, and every minimal-key search. */
export const sites = Object.freeze({
	closure: { file: "packages/engine/src/logical/closure.ts", name: "closure" },
	minimalKeys: { file: "packages/engine/src/logical/closure.ts", name: "minimalKeys" }
} satisfies Readonly<Record<string, CountedFunction>>)

/**
 * k relations R0.. of columns a and b, each its own key (`keyed`), or a alone the key of each, b its payload, matched
 * in one region delivering every variable.
 */
export const productOf = (k: number, keyed: "both keys" | "a key and a payload"): ValidDag => {
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
				keys: keyed === "both keys" ? [["b"]] : [],
				relationKind: "relation",
				generated: [],
				unit: [],
				determined: [],
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

/**
 * k relations S0.. of s columns x, y0.., each column alone its key, and a relation R keyed by its column id and by its k
 * columns a0.. together, matched in one region joining each R.a<i> to S<i>.x and delivering every variable but id, in
 * heading order a0, y0_0, .., a1, ..: each a<i> and the y<i>_<j> are a class of s columns that determine one another and
 * are never equal, and R's id, which the region hides, ties the k classes into one factor of the region's keys, every
 * choice of one column per class a minimal key, s^k of them.
 */
export const classesOf = (k: number, s: number): ValidDag => {
	const b = new DagBuilder(makeIdSupply())
	const base = (
		relation: string,
		columns: ReadonlyArray<string>,
		primaryKey: string,
		keys: ReadonlyArray<NonEmptyReadonlyArray<string>>
	) =>
		b.node({
			kind: "Base",
			relation,
			occurrence: b.ids.occurrence(),
			primaryKey: [primaryKey],
			keys,
			relationKind: "relation",
			generated: [],
			unit: [],
			determined: [],
			heading: Arr.map(columns, (name) => ({ name, type: int4 })),
			loc: undefined,
			meta: conservativeMeta
		})
	const variable = (name: string): VarDecl => ({ id: b.ids.var(), name, type: int4 })
	const classes = Arr.map(indices(k), (i) => ({
		a: variable(`a${i}`),
		ys: Arr.map(indices(s - 1), (j) => variable(`y${i}_${j}`))
	}))
	const shared: NonEmptyReadonlyArray<string> = [
		"a0",
		...Arr.map(indices(k - 1), (i) => `a${i + 1}`)
	]
	const r = {
		id: b.ids.occurrence(),
		source: base("R", ["id", ...shared], "id", [shared]),
		bindings: Arr.map(classes, (c, i) => ({ column: `a${i}`, var: c.a })),
		constants: []
	}
	const ss = Arr.map(classes, (c, i) => {
		const ys = Arr.map(indices(s - 1), (j) => `y${j}`)
		return {
			id: b.ids.occurrence(),
			source: base(
				`S${i}`,
				["x", ...ys],
				"x",
				Arr.map(ys, (y) => [y] as const)
			),
			bindings: [
				{ column: "x", var: c.a },
				...Arr.map(c.ys, (v, j) => ({ column: `y${j}`, var: v }))
			],
			constants: []
		}
	})
	const vars = Arr.flatMap(classes, (c) => [c.a, ...c.ys])
	return b.build([
		b.node({
			kind: "MatchRegion",
			scope: b.ids.scope(),
			vars,
			occurrences: [r, ...ss],
			equalities: [],
			correlated: [],
			heading: Arr.map(vars, (v) => ({ name: v.name, type: v.type })),
			loc: undefined,
			meta: conservativeMeta
		})
	])
}

export type Point = "from k = 4" | "from k = 6"

export type ClassPoint = "classes of two columns" | "classes of three columns"

/** Every row a closure fires: a node's closures' visits (closure.ts closure) and the factor search's firings. */
export const firings = Object.freeze({
	step: { file: "packages/engine/src/logical/closure.ts", name: "step" },
	fire: { file: "packages/engine/src/logical/closure.ts", name: "fire" }
} satisfies Readonly<Record<string, CountedFunction>>)
