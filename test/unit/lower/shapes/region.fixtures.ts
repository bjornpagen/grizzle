/** What the properties of region.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order } from "effect"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type { Expr, FromItem, FromSource, SelectCore, SqlStatement } from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"
import { decodedQuery, type MatchDesc, type VarDesc } from "#test/support/fixtures/ir/desc.ts"
import { pickGen } from "#test/support/pick.ts"

const Edge = relation("Edge", { src: pg.bigint, dst: pg.bigint, w: pg.integer }, ["src", "dst"])

export const Plan = schema("Plan", [Edge], [])

/** The most edges a path has; the fewest is one past join_collapse_limit's eight, a region no longer special. */
export const maxEdges = 14

const minEdges = 9

/**
 * A path of edges e_0 ... e_{n-1}, e_i from node i to node i + 1, edge `restricted` fixed on its weight by a parameter,
 * the matches written in `order`.
 */
interface Path {
	readonly edges: number
	readonly restricted: number
	readonly order: ReadonlyArray<number>
}

/** A path's sketch: its edges past the fewest, the restricted edge among them, and a sort key per edge. */
interface PathSketch {
	readonly size: number
	readonly restricted: number
	readonly keys: ReadonlyArray<number>
}

export const pathSketchGen: Gen<PathSketch> = (source) => {
	const size = source.draw(int(0, maxEdges - minEdges))
	return {
		size,
		restricted: source.draw(int(0, minEdges + size - 1)),
		keys: source.draw(array(pickGen, { min: maxEdges, max: maxEdges }))
	}
}

/** The order the keys sort the edges into: a permutation that shrinks toward the written order. */
export const pathOf = ({ size, restricted, keys }: PathSketch): Path => {
	const edges = minEdges + size
	const order = Arr.sort(
		indices(edges),
		Order.combine(
			Order.mapInput(Order.Number, (i: number) => keys[i] ?? 0),
			Order.Number
		)
	)
	return { edges, restricted, order }
}

const node = (k: number) => ({ kind: "var" as const, var: `n${k}` })

export const pathDesc = (path: Path): QueryDesc =>
	decodedQuery({
		kind: "rules",
		arms: [
			{
				vars: Arr.map(indices(path.edges + 1), (k): VarDesc => ({
					id: `n${k}`,
					origin: { relation: "Edge", field: k === 0 ? "src" : "dst" }
				})),
				matches: Arr.map(path.order, (i): MatchDesc => ({
					source: { kind: "relation", name: "Edge" },
					bindings: {
						src: node(i),
						dst: node(i + 1),
						...(i === path.restricted
							? {
									w: {
										kind: "param" as const,
										name: "w",
										type: { kind: "pg", type: "integer" } as const
									}
								}
							: {})
					}
				})),
				where: [],
				head: { start: node(0), end: node(path.edges) },
				interiors: [],
				attach: []
			}
		]
	})

/** The aliases a FROM item defines, leftmost first. */
export const aliasesOf = (item: FromItem): ReadonlyArray<string> =>
	item.kind === "joins"
		? [aliasOf(item.first), ...Arr.map(item.steps, (step) => aliasOf(step.source))]
		: [aliasOf(item)]

/** The alias a FROM source defines. */
export const aliasOf = (item: FromSource): string => {
	switch (item.kind) {
		case "cte":
			return item.alias ?? item.name
		case "derived":
		case "enclosing":
		case "transition":
		case "function":
		case "arrays":
		case "table":
		case "read":
		case "probe":
		case "met":
		case "metRows":
		case "values":
		case "context":
			return item.alias
	}
}

/** The relations an expression's column references name. */
export const tablesRead = (e: Expr): ReadonlySet<string> => {
	const out = new Set<string>()
	transformExpr(e, {
		...identityHooks,
		expr: (x) => {
			if (x.kind === "column" && x.table !== undefined) {
				out.add(x.table)
			}
			return x
		}
	})
	return out
}

export const conjuncts = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? Arr.flatMap(e.args, conjuncts) : [e]

/** The core whose FROM lists `width` items, one for each occurrence of the region, with their aliases in order. */
export const regionCoreOf = (
	statement: SqlStatement,
	width: number
): Option.Option<{ readonly core: SelectCore; readonly aliases: ReadonlyArray<string> }> => {
	const found: Array<{ readonly core: SelectCore; readonly aliases: ReadonlyArray<string> }> = []
	transformStatement(statement, {
		...identityHooks,
		core: (c) => {
			const aliases = Arr.flatMap(c.from, aliasesOf)
			if (aliases.length === width) {
				found.push({ core: c, aliases })
			}
			return c
		}
	})
	return Arr.head(found)
}

/** Where a path's restricted occurrence was written, and whether it was the longest path. */
export type RegionFeature = "restricted first written" | "restricted written later" | "longest path"
