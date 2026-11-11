import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { closed, relation, role, schema, wholeEntriesOf } from "#compiler/public/schema.ts"

/**
 * The schema the recursion agreement (test/support/agreement/recursion.ts) draws its recursive queries over, which
 * its generated program imports by name: a graph's edges, keyed by both ends, and its nodes, each with an integer rank
 * and a closed kind, the fields of another type a faulted arm delivers at a row's uuid field; and a reader of it.
 */
const Kind = closed("Kind", ["Leaf", "Inner"])
export const Edge = relation("Edge", { from: uuid, to: uuid }, ["from", "to"])
export const Node = relation("Node", { id: uuid, rank: pg.integer, kind: closedId(Kind) }, ["id"])
export const Graph = schema("Graph", [Kind, Edge, Node], [])
export const Reader = role(Graph, "reader", wholeEntriesOf(Graph))
