/** What the properties of recursion.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { finite, int } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import type { NodeOf } from "#compiler/ir/rel.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/pipeline.ts"
import { Num, Type } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
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
import { costChosen } from "#compiler/sql/emit.ts"
import { succeeded } from "#test/support/assert.ts"
import { lowerAligned, programAsts } from "#test/support/compile.ts"
import { ownedSchemaFixture } from "#test/support/evidence.ts"
import { Id } from "#test/support/ids.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { present } from "#test/unit/lower/support.ts"

const Vertex = relation("Vertex", { id: Id, rank: pg.smallint }, ["id"])

const Edge = relation("Edge", { from: Id, to: Id }, ["from", "to"])

const Graph = schema(
	"Graph",
	[Vertex, Edge],
	[contained(on(Edge, "from"), on(Vertex, "id")), contained(on(Edge, "to"), on(Vertex, "id"))]
)

export const admit = (q: unknown): LogicalQuery => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	return succeeded(checkQuery(checking(Graph), desc, checkOptions("query")))
}

export const recursiveNode = (q: LogicalQuery): NodeOf<"Recursive"> => {
	const found = Arr.filter(
		topoOrder(q.dag),
		(n): n is NodeOf<"Recursive"> => n.kind === "Recursive"
	)
	assert.equal(found.length, 1)
	return present(found[0], "a recursion")
}

/** The graph schema's own catalog, every key named as ownership installs it. */
const graphCatalog = ownedSchemaFixture(Graph).catalog

export const names = productionNames(
	"Graph",
	{ kind: "declared" },
	localVectorSchema,
	emptyCodebook
)

export const optimize = (q: LogicalQuery): OptimizedProgram =>
	succeeded(
		lowerAligned(q, "query", {
			binding: costChosen(),
			names,
			context: "snapshot",
			catalog: graphCatalog
		})
	)

/** Every query nested in a statement: the statement, its CTE bodies, derived tables and subquery expressions. */
export const queries = (s: Select): ReadonlyArray<OperandSelect> => {
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

export const mainAst = (p: OptimizedProgram): Select => programAsts(p)[0]

export const recursiveCtes = (s: Select): ReadonlyArray<Cte> =>
	Arr.flatMap(queries(s), (q) => (q.with?.recursive === true ? q.with.ctes : []))

/** The walk from a parameter root, one hop at a time from hops 0 while hops is below `below`. */
export const walkBelow = (below: number) =>
	query(Graph).recursive("Walks", {
		row: { node: Id, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Vertex, "vertex")
				return r
					.match(Vertex, { id })
					.where(r.eq(id, r.param("start", Id)))
					.find({ node: id, hops: Type.literal(pg.integer, 0) })
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
					.find({ node: to, hops: Num.add(hops, Type.literal(pg.integer, 1)) })
			}
		]
	})

/** Walks bounded at every depth from none to several hops. */
export const walkBounds = finite(int(0, 6))
