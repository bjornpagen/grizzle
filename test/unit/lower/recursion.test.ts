/**
 * The form the optimized recursive lowering gives a recursion (lower/shapes/recursion/index.ts), against the rule its
 * header states: whatever depth a counter bounds the recursion to, it is one recursive CTE, its feedback under UNION and
 * no DISTINCT anywhere, the complete final state needing none; a recursion realized without its UNION is refused
 * (MalformedDescription).
 *
 * Oracle: the module's stated form, checked on the lowered statement's AST (a specification). Feature: a bounded walk.
 *
 * Plants, each failing the search: the recursive CTE's terms joined by UNION ALL (recursion-union-all); a plain
 * realization lowered (recursion-plain-admitted).
 */
import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import { emptyEnv, LowerContext } from "#compiler/lower/conservative/context.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import { recursionLowerer } from "#compiler/lower/shapes/recursion/index.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import type {
	Cte,
	Expr,
	OperandBody,
	OperandSelect,
	Select,
	SelectCore
} from "#compiler/sql/ast.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { lowerAligned, programAsts } from "#test/support/compile.ts"
import { ownedSchemaFixture } from "#test/support/evidence.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { conservativeShapeFacts } from "#test/unit/lower/shapes/support.ts"
import { present } from "#test/unit/lower/support.ts"

const Vertex = relation("Vertex", { id: uuid, rank: pg.smallint }, ["id"])
const Edge = relation("Edge", { from: uuid, to: uuid }, ["from", "to"])
const Graph = schema(
	"Graph",
	[Vertex, Edge],
	[contained(on(Edge, "from"), on(Vertex, "id")), contained(on(Edge, "to"), on(Vertex, "id"))]
)

const admit = (q: unknown): LogicalQuery => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	return succeeded(checkQuery(checking(Graph), desc, checkOptions("query")))
}

const recursiveNode = (q: LogicalQuery): NodeOf<"Recursive"> => {
	const found = Arr.filter(
		topoOrder(q.dag),
		(n): n is NodeOf<"Recursive"> => n.kind === "Recursive"
	)
	assert.equal(found.length, 1)
	return present(found[0], "a recursion")
}

/** The graph schema's own catalog, every key named as ownership installs it. */
const graphCatalog = ownedSchemaFixture(Graph).catalog

const names = productionNames("Graph", { kind: "declared" }, localVectorSchema, emptyCodebook)

const optimize = (q: LogicalQuery): OptimizedProgram =>
	succeeded(
		lowerAligned(q, "query", {
			names,
			context: "snapshot",
			catalog: graphCatalog
		})
	)

/** Every query nested in a statement: the statement, its CTE bodies, derived tables and subquery expressions. */
const queries = (s: Select): ReadonlyArray<OperandSelect> => {
	const out: Array<OperandSelect> = []
	const visitSelect = (q: OperandSelect): void => {
		out.push(q)
		for (const cte of q.with?.ctes ?? []) {
			if (cte.query.kind === "select") {
				visitSelect(cte.query)
			}
		}
		visitBody(q.body)
	}
	const visitBody = (b: OperandBody): void => {
		if (b.kind === "select") {
			visitSelect(b)
			return
		}
		if (b.kind === "setOp") {
			for (const arm of b.arms) {
				visitBody(arm)
			}
			return
		}
		for (const f of b.from) {
			visitFrom(f)
		}
		for (const t of b.targets) {
			visitExpr(t.expr)
		}
		if (b.where !== undefined) {
			visitExpr(b.where)
		}
	}
	const visitFrom = (f: NonNullable<SelectCore["from"]>[number]): void => {
		if (f.kind === "derived") {
			visitSelect(f.query)
		} else if (f.kind === "joins") {
			visitFrom(f.first)
			for (const step of f.steps) {
				visitFrom(step.source)
			}
		}
	}
	const visitExpr = (e: Expr): void => {
		if (e.kind === "exists" || e.kind === "subquery" || e.kind === "array") {
			visitSelect(e.query)
		} else if (e.kind === "and" || e.kind === "or") {
			for (const a of e.args) {
				visitExpr(a)
			}
		} else if (e.kind === "not") {
			visitExpr(e.expr)
		}
	}
	visitSelect(s)
	return out
}

const mainAst = (p: OptimizedProgram): Select => programAsts(p)[0]

const recursiveCtes = (s: Select): ReadonlyArray<Cte> =>
	Arr.flatMap(queries(s), (q) => (q.with?.recursive === true ? q.with.ctes : []))

/** The walk from a parameter root, one hop at a time from hops 0 while hops is below `below`. */
const walkBelow = (below: number) =>
	query(Graph).recursive("Walks", {
		row: { node: uuid, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Vertex, "vertex")
				return r
					.match(Vertex, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ node: id, hops: Compute.literal(pg.integer, 0) })
			}
		],
		rec: [
			(r, self) => {
				const { node, hops } = v(self, "self")
				const { to } = v(Edge, "edge")
				return r
					.match(self, { node, hops })
					.match(Edge, { from: node, to })
					.where(r.lt(hops, below))
					.find({ node: to, hops: Compute.add(hops, Compute.literal(pg.integer, 1)) })
			}
		]
	})

describe("the form a recursion lowers to (packages/engine/src/lower/shapes/recursion/index.ts)", () => {
	it.effect(
		"keeps the UNION recursive CTE at every bounded depth, and refuses a plain realization",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						box: "a walk from a parameter root bounded below every depth from none to six hops",
						oracle: {
							kind: "specification",
							name: "one recursive CTE under UNION, no DISTINCT, whatever the depth; a plain realization refused"
						},
						suite: "unit/lower/recursion/form",
						/** Walks bounded at every depth from none to several hops. */
						generator: int(0, 6),
						literal: Formatter.format,
						coverage: requiredInSpace<"bounded walk">(["bounded walk"]),
						caseHang,
						concurrency: 1
					},
					(below, c) =>
						Effect.sync(() => {
							const q = admit(walkBelow(below))
							const rec = recursiveNode(q)
							const ast = mainAst(optimize(q))
							const ctes = recursiveCtes(ast)
							const [cte] = ctes
							assert.equal(ctes.length, 1)
							const body = present(cte, "the recursive CTE").query
							assert.ok(
								body.kind === "select" && body.body.kind === "setOp" && body.body.op === "UNION"
							)
							assert.equal(
								Arr.some(queries(ast), (x) => x.body.kind === "core" && x.body.distinct !== false),
								false
							)
							c.note("bounded walk")
							/** A recursion realized without its UNION. */
							const facts = conservativeShapeFacts({
								realization: (node) => (node.id === rec.id ? "plain" : "distinct")
							})
							const cx = new LowerContext(
								q.dag,
								{
									names,
									params: q.params,
									subject: { kind: "query" }
								},
								optimizedDispatch(facts, new ShapeState<RelationInput>("small", emptyCtePlan))
							)
							refused(
								catchRefusal(() => recursionLowerer(facts)(rec, cx, emptyEnv)),
								"MalformedDescription"
							)
						})
				)
			)
	)
})
