/** What the properties of r37.test.ts read: its spaces, models and helpers. */

import { indices } from "@bjornpagen/grizzle-text/base/array"
import { array, type Gen, int, map, oneOf } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import type { Term } from "#compiler/public/compute.ts"
import { int4 } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, schema as declareSchema, on, relation } from "#compiler/public/schema.ts"
import { publicCase } from "#test/pg/recursion/graph/support.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import type { GenContainment } from "#test/support/oracle/gen/schema.ts"

/**
 * R37: a recursive attachment seeded once from the parent keys.
 *
 * A drawn forest of 40 to 200 roots, each heading a chain of up to six edges, and a page of one to four roots (the
 * first by id), each chain of its own drawn depth, with the vertices below each attached. The attached recursion's
 * base reads the parent's id, which the checker carries in the state as the origin (check/recursion/origin.ts), so its
 * base is every edge and the pipelined statement computes the closure of every root and keeps the delivered parents'
 * (the conservative artifact). The optimized artifact seeds one recursive statement from the delivered parents' key
 * recordset: its states are exactly the page's closures, its rows read from the edge relation, probed, are edges of
 * the page's chains alone (pageEdges), never the forest's, and one Recursive Union runs once for the page, under the
 * advice the statement carries and with its tables in every pg_class state (test/support/advice.ts PgClassState).
 *
 * That the seeded statement delivers exactly the pipelined closures is the graph suite's (equivalence.test.ts, the
 * attachment population against the conservative lowering) and the recursion oracle's (consumer:attach against the
 * reference evaluator).
 */

const V = relation("V", { id: int4 }, ["id"])

const E = relation("E", { from: int4, to: int4 }, ["from", "to"])

const Root = relation("Root", { id: int4 }, ["id"])

const Pair = relation("Pair", { a: int4, b: int4 }, ["a", "b"])

const Net = declareSchema(
	"Net",
	[V, E, Root, Pair],
	[
		contained(on(E, "from"), on(V, "id")),
		contained(on(E, "to"), on(V, "id")),
		contained(on(Root, "id"), on(V, "id")),
		contained(on(Pair, "a"), on(V, "id")),
		contained(on(Pair, "b"), on(V, "id"))
	]
)

const containments: ReadonlyArray<GenContainment> = [
	{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Root", fields: ["id"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Pair", fields: ["a"] }, to: { relation: "V", fields: ["id"] } },
	{ from: { relation: "Pair", fields: ["b"] }, to: { relation: "V", fields: ["id"] } }
]

/**
 * A forest: `roots` roots, root i = 10i heading the chain r -> r+1 -> ... -> r+d of its own depth d, the first `page`
 * roots by id the page, each chain of the page its drawn depth and every other `depth` deep.
 */
interface Forest {
	readonly roots: number
	readonly depth: number
	readonly page: ReadonlyArray<number>
}

/** A forest whose page is one root as often as it is two to four, so the streams that judge coverage reach both. */
export const forestGen: Gen<Forest> = (source) => ({
	roots: source.draw(int(40, 200)),
	depth: source.draw(int(1, 6)),
	page: source.draw(
		oneOf([map(int(1, 6), (depth) => [depth]), array(int(1, 6), { min: 2, max: 4 })])
	)
})

const int4Literal = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** Each root's id and its chain's depth, the page's roots first. */
const chainsOf = (f: Forest): ReadonlyArray<readonly [root: number, depth: number]> =>
	Arr.map(indices(f.roots), (i) => [10 * i, f.page[i] ?? f.depth] as const)

/** The facts of chains `from` to `to` of `f` (`chainsOf`), from 1, both included: each one's vertices, edges and root. */
const factsOf = (f: Forest, from: number, to: number) => {
	const chains = chainsOf(f).slice(from - 1, to)
	return {
		V: Arr.flatMap(chains, ([r, d]) => Arr.map(indices(d + 1), (k) => [int4Literal(r + k)])),
		E: Arr.flatMap(chains, ([r, d]) =>
			Arr.map(indices(d), (k) => [int4Literal(r + k), int4Literal(r + k + 1)])
		),
		Root: Arr.map(chains, ([r]) => [int4Literal(r)]),
		Pair: []
	}
}

export const caseOf = (
	label: string,
	q: unknown,
	params: Readonly<Record<string, TypedLiteral>>,
	f: Forest
): QueryCase =>
	publicCase({
		schema: Net,
		name: "Net",
		relations: ["V", "E", "Root", "Pair"],
		containments,
		facts: factsOf(f, 1, f.roots),
		label,
		query: q,
		params
	})

/**
 * `c`, the case of `f`, holding the facts of its chains `from` to `to` alone (`factsOf`): one load of the case's facts a
 * chain at a time (test/support/advice.ts StateLoad), each chain's vertices and edges apart from every other's.
 */
export const chainsCase = (c: QueryCase, f: Forest, from: number, to: number): QueryCase => ({
	...c,
	facts: canonicalFacts(factsOf(f, from, to))
})

export type ForestFeature =
	| "a page of one root"
	| "a page of several roots"
	| "a page of chains of two depths"

/** The transition arm the definition uses: a rule over Net, and the feedback of a state of one vertex. */
type NetRule = Rule<typeof Net>

type NodeSelf = SelfSource<{ readonly node: typeof int4 }>

const forward = (r: NetRule, self: NodeSelf) => {
	const { node } = v(self, "self")
	const { to } = v(E, "e")
	return r.match(self, { node }).match(E, { from: node, to }).find({ node: to })
}

/** The first `n` roots by id: the page the closures are attached to. */
const page = (n: number) =>
	query(Net)
		.rule((r) => {
			const { id } = v(Root, "root")
			return r.match(Root, { id }).find({ id })
		})
		.orderBy(["id", "asc"])
		.take(n)

/**
 * The vertices one or more steps below the parent: the base reads the parent's column `from`, its id unless an
 * attachment names another.
 */
const below = (from: Term<number, unknown, unknown, "int4">) =>
	query(Net).recursive("Below", {
		row: { node: int4 },
		base: [
			(r) => {
				const { to } = v(E, "e")
				return r.match(E, { from, to }).find({ node: to })
			}
		],
		rec: [forward]
	})

/**
 * The rows the seeded attachment may read from E while it probes: E's key index is on (from, to), and under the advice
 * the statement carries every scan of E is a probe of it on `from`, the seed's at each page root and the step's at each
 * state, and every row a probe reads, returned or removed by a filter, has that `from`, a page root or a vertex below
 * one. Each such row is an edge of a page root's chain, and each of those edges leads to one vertex below its root, so
 * they number the page's closures: the sum of its chains' depths. The forest's other edges are never read.
 */
export const pageEdges = (f: Forest): number => Arr.reduce(f.page, 0, (sum, depth) => sum + depth)

export const pageBelow = (n: number) => page(n).attach("below", (p) => below(p.id), "array")
