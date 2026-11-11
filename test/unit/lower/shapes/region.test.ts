import { describe, it } from "@effect/vitest"
import { explore, type Kept, sketched } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Order } from "effect"
import { indices } from "#compiler/core/array.ts"
import { identity } from "#compiler/core/identity.ts"
import type { QueryDesc } from "#compiler/ir/desc.ts"
import { pg } from "#compiler/public/fields.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import type {
	Expr,
	FromItem,
	FromSource,
	JoinChain,
	SelectCore,
	SqlStatement
} from "#compiler/sql/ast.ts"
import { identityHooks, transformExpr, transformStatement } from "#compiler/sql/transform.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { compileTemplate, programAsts, testCompile } from "#test/support/compile.ts"
import { decodedQuery, type MatchDesc, type VarDesc } from "#test/support/fixtures/ir/desc.ts"
import { parsedSchemaName } from "#test/support/kernel/naming.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
import { caseHang } from "#test/support/limits.ts"
import { pickGen } from "#test/support/pick.ts"

/**
 * The optimized MatchRegion past PostgreSQL's collapse limit (shapes/region): a region of more than eight
 * occurrences is an explicit JOIN chain, so PostgreSQL plans it in subproblems of at most join_collapse_limit relations
 * rather than one flat FROM list at geqo_threshold.
 *
 * Over generated paths of nine to fourteen edges, one of them restricted by a parameter, written in any order: the
 * chain joins every occurrence with no CROSS JOIN, each link's ON reads both of its sides, and the chain starts at the
 * restricted occurrence, whose restriction stays in WHERE. A chain that dropped a link's condition would plan a cross
 * product; one that started elsewhere would put the selective occurrence in a late subproblem.
 */

const Edge = relation("Edge", { src: pg.bigint, dst: pg.bigint, w: pg.integer }, ["src", "dst"])
const Plan = schema("Plan", { Edge }, [])

/** The most edges a path has; the fewest is one past the collapse limit. */
const maxEdges = 14
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

const pathSketchGen: Gen<PathSketch> = (source) => {
	const size = source.draw(int(0, maxEdges - minEdges))
	return {
		size,
		restricted: source.draw(int(0, minEdges + size - 1)),
		keys: source.draw(array(pickGen, { min: maxEdges, max: maxEdges }))
	}
}

/** The order the keys sort the edges into: a permutation that shrinks toward the written order. */
const pathOf = ({ size, restricted, keys }: PathSketch): Path => {
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

const pathDesc = (path: Path): QueryDesc =>
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
const aliasesOf = (item: FromItem): ReadonlyArray<string> =>
	item.kind === "joins"
		? [aliasOf(item.first), ...Arr.map(item.steps, (step) => aliasOf(step.source))]
		: [aliasOf(item)]

/** The alias a FROM source defines. */
const aliasOf = (item: FromSource): string => {
	switch (item.kind) {
		case "cte":
			return item.alias ?? item.name
		case "derived":
		case "enclosing":
		case "function":
		case "arrays":
		case "table":
		case "probe":
		case "met":
		case "metRows":
		case "values":
		case "context":
			return item.alias
	}
}

/** The relations an expression's column references name. */
const tablesRead = (e: Expr): ReadonlySet<string> => {
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

const conjuncts = (e: Expr | undefined): ReadonlyArray<Expr> =>
	e === undefined ? [] : e.kind === "and" ? Arr.flatMap(e.args, conjuncts) : [e]

/** The core whose FROM is the join chain, with the chain. */
const chainOf = (
	statement: SqlStatement
): Option.Option<{ readonly core: SelectCore; readonly chain: JoinChain }> => {
	const found: Array<{ readonly core: SelectCore; readonly chain: JoinChain }> = []
	transformStatement(statement, {
		...identityHooks,
		core: (c) => {
			const [first, ...rest] = c.from
			if (first?.kind === "joins" && rest.length === 0) {
				found.push({ core: c, chain: first })
			}
			return c
		}
	})
	return Arr.head(found)
}

/** Where a path's restricted occurrence was written, and whether it was the longest path. */
type RegionFeature = "restricted first written" | "restricted written later" | "longest path"

/**
 * Planted: the restricted occurrence written first, which the drawn orders put first one time in nine to fourteen. Its
 * middle edge is restricted, written ahead of the rest in their order.
 */
const keptPaths: ReadonlyArray<Kept<PathSketch, RegionFeature>> = [
	{
		note: "the restricted occurrence written first",
		sketch: {
			size: 0,
			restricted: 4,
			keys: Arr.map(indices(maxEdges), (i) => (i === 4 ? 0 : 1))
		},
		draws: "",
		reaches: ["restricted first written"]
	}
]

describe("a region past the collapse limit is an explicit JOIN chain", () => {
	it.effect(
		"joins every occurrence on a condition that reads both sides, starting at the restricted one",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: { kind: "unstated" },
						suite: "unit/lower/region-chain",
						literal: Formatter.format,
						kept: keptPaths,
						draw: sketched(pathSketchGen, pathOf),
						runs: 60,
						shrink: completeShrink,
						coverage: required<RegionFeature>(
							["restricted first written", "restricted written later", "longest path"],
							{ cases: 60, sense: notesOnly }
						),
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(path, c) =>
						Effect.sync(() => {
							const compiled = succeeded(
								compileTemplate(pathDesc(path), Plan, {
									...testCompile,
									installation: identity.schema(parsedSchemaName("plan"))
								})
							)
							const [statement] = programAsts(compiled.programs.optimized)
							assert.equal(featureCount(shapeOf(statement), "cross join"), 0)
							assert.equal(featureCount(shapeOf(statement), "join"), path.edges - 1)
							const found = Option.getOrThrowWith(
								chainOf(statement),
								() => new Error("a core reads the chain")
							)
							transformStatement(statement, {
								...identityHooks,
								joins: (chain) => {
									const left = new Set([aliasOf(chain.first)])
									for (const step of chain.steps) {
										const right = aliasOf(step.source)
										if (step.kind === "on") {
											const read = tablesRead(step.on)
											assert.ok(
												Arr.some([...read], (a) => left.has(a)) && read.has(right),
												"an ON reads both sides"
											)
										}
										left.add(right)
									}
									return chain
								}
							})
							const [start] = aliasesOf(found.chain)
							assert.ok(start !== undefined, "the chain has a first occurrence")
							const restriction = Arr.some(
								conjuncts(found.core.where),
								(e) =>
									e.kind === "binary" &&
									e.op === "=" &&
									((e.right.kind === "param" && tablesRead(e.left).has(start)) ||
										(e.left.kind === "param" && tablesRead(e.right).has(start)))
							)
							assert.ok(
								restriction,
								`the chain starts at ${start}, which the parameter restricts in WHERE`
							)
							c.note(
								path.order[0] === path.restricted
									? "restricted first written"
									: "restricted written later"
							)
							if (path.edges === maxEdges) {
								c.note("longest path")
							}
						})
				)
			)
	)
})
