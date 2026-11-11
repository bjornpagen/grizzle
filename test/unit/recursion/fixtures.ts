import { Array as Arr } from "effect"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { edgesOf, type NodeOf, type RelNode } from "#compiler/ir/rel.ts"
import { lowerConservative } from "#compiler/lower/conservative/index.ts"
import { type ConservativeProgram, conservativeInput } from "#compiler/lower/conservative/types.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert } from "#test/support/assert.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"

/**
 * The graph schema of the recursion tests, recognized from its keys and containments, and the helpers that read what
 * the checker admitted and lower it.
 */

/**
 * A vertex relation with a column of every kind a state may copy, an edge relation keyed by its endpoints, and a fixed
 * external relation of blocked vertices for negation in a step.
 */
const Level = closed("Level", ["Low", "Mid", "High"])
const Vertex = relation(
	"Vertex",
	{
		id: uuid,
		label: str.regex("^v[0-9]+$"),
		active: pg.boolean,
		level: closedId(Level),
		rank: pg.smallint,
		price: pg.money,
		weight: pg.numeric(10, 2)
	},
	["id"]
)
const Edge = relation("Edge", { from: uuid, to: uuid, cost: pg.integer }, ["from", "to"])
const Blocked = relation("Blocked", { id: uuid }, ["id"])
export const Graph = schema(
	"Graph",
	[Level, Vertex, Edge, Blocked],
	[contained(on(Edge, "from"), on(Vertex, "id")), contained(on(Edge, "to"), on(Vertex, "id"))]
)

export const descOf = (q: unknown) => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	return desc
}

export const nodes = (q: LogicalQuery): ReadonlyArray<RelNode> => topoOrder(q.dag)

const recursives = (q: LogicalQuery): ReadonlyArray<NodeOf<"Recursive">> =>
	Arr.filter(nodes(q), (n): n is NodeOf<"Recursive"> => n.kind === "Recursive")

export const theRecursive = (q: LogicalQuery): NodeOf<"Recursive"> => {
	const found = recursives(q)
	assert.equal(found.length, 1)
	const [only] = found
	assert.ok(only !== undefined, "one Recursive node")
	return only
}

/**
 * How many places read a node as a data input: an occurrence of a region, or an input of any other node; a Recursive
 * reads its base and its step (its SelfRef is the feedback its step reads).
 */
export const reads = (q: LogicalQuery, node: RelNode): number =>
	Arr.reduce(
		nodes(q),
		0,
		(count, n) =>
			count +
			Arr.filter(n.kind === "Recursive" ? [n.base, n.step] : edgesOf(n), (x) => x === node).length
	)

export const lower = (q: LogicalQuery): ConservativeProgram => {
	const r = lowerConservative(conservativeInput(q), {
		names: productionNames("Graph", { kind: "declared" }, localVectorSchema, emptyCodebook),
		params: q.params,
		subject: { kind: "query" }
	})
	if (!r.ok) {
		throw new Error(`expected a program, got ${r.error.message}`)
	}
	return r.value
}
