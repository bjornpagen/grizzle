import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import {
	conservative,
	defaultRunOptions,
	type LabelledCase,
	printOutcome,
	reference,
	runLabelledOracle
} from "#test/support/oracle/runner.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/**
 * Admitted recursions run on PostgreSQL 19.
 *
 * Each recursion below is built with the query builder, admitted by the checker (packages/engine/src/check/recursion),
 * lowered by the conservative lowering and run on PostgreSQL, and its rows are compared as raw text sets with the
 * reference evaluator's rows over the same facts (test/support/oracle/runner.ts), with no repeated row on either side.
 * A case draws a hop bound and countdown seed, a graph over up to six vertices, each ordered pair of them an edge or
 * not, so self-loops, diamonds and cycles arrive along several routes and in several
 * iterations, the vertices the external relation blocks, and the vertices the parameters name, now and then one past
 * the graph, and runs every recursion over them. The recursions are the Walks example, a closure walking both directions through two factored transition
 * arms read by one feedback scan, negation of a fixed external relation in the step, a countdown, a second recursive
 * stage seeded from a completed first one, the transitive closure of pairs with an arm that fixes a state column, and
 * three attached recursions, which carry their parent's id in their state.
 *
 * Plants (main's test phase): recursion-conservative-feedback-union-all.patch.
 */

const V = relation("V", { id: uuid }, ["id"])
const E = relation("E", { from: uuid, to: uuid, cost: pg.integer }, ["from", "to"])
const B = relation("B", { id: uuid }, ["id"])
const Net = schema(
	"Net",
	[V, E, B],
	[contained(on(E, "from"), on(V, "id")), contained(on(E, "to"), on(V, "id"))]
)

const vertex = (i: number): Uuid => `00000000-0000-4000-8000-00000000000${i}`
const vertexId = (i: number): TypedLiteral => ({ kind: "uuid", value: vertex(i) })
const int8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** A graph over the vertices 0 … n - 1: its edges, and the vertices B blocks. */
interface Graph {
	readonly vertices: number
	readonly edges: ReadonlyArray<readonly [number, number]>
	readonly blocked: ReadonlyArray<number>
}

/** Up to six vertices, each ordered pair of them an edge or not, each vertex blocked or not. */
const graphGen: Gen<Graph> = (source) => {
	const vertices = source.draw(int(1, 6))
	const each = upTo(vertices, (i) => i)
	return {
		vertices,
		edges: source.draw(subarray(Arr.flatMap(each, (a) => Arr.map(each, (b) => [a, b] as const)))),
		blocked: source.draw(subarray(each))
	}
}

const genSchema = (): GenSchema => {
	const checked = checking(Net)
	return {
		name: "Net",
		relations: Arr.map(["V", "E", "B"], (name) => {
			const info = checked.relations.get(name)
			if (info === undefined) {
				throw new Error(`no relation ${name}`)
			}
			return {
				name,
				columns: Arr.map(info.heading, (c) => ({ name: c.name, type: c.type })),
				primaryKey: info.primaryKey,
				keys: [],
				mutable: false
			}
		}),
		closed: [],
		containments: [
			{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
			{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } }
		]
	}
}

/** A graph's facts, each relation's rows in its checked heading's canonical column order (E: cost, from, to). */
const factsOf = (graph: Graph) => ({
	V: upTo(graph.vertices, (i) => [vertexId(i)]),
	E: Arr.map(graph.edges, ([a, b], i) => [int8(i + 1), vertexId(a), vertexId(b)]),
	B: Arr.map(graph.blocked, (i) => [vertexId(i)])
})

/** The oracle case of an admitted query, its scalar parameters bound to `values`. */
const caseOf = (
	label: string,
	q: unknown,
	values: Readonly<Record<string, TypedLiteral>>,
	graph: Graph
): LabelledCase => {
	const desc = queryValueDesc(q)
	if (desc === undefined) {
		throw new Error("not a query value")
	}
	const checked = checkQuery(checking(Net), desc, checkOptions("query"))
	if (!checked.ok) {
		throw new Error(`${label}: ${checked.error.message}`)
	}
	const dag = normalQuery(checked.value.dag)
	const params: Record<string, GenParam> = {}
	for (const p of checked.value.params) {
		const value = values[p.name]
		if (value === undefined || p.kind === "relation") {
			throw new Error(`${label}: no value for ${p.name}`)
		}
		params[p.id] = { kind: "scalar", type: p.type, value }
	}
	return {
		schema: genSchema(),
		facts: canonicalFacts(factsOf(graph)),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false },
		label
	}
}

const lit = (n: number) => Compute.literal(pg.integer, n)

/** Walks: each vertex and hop count reachable from the start in fewer than `bound` hops. */
const walksBelow = (bound: number) =>
	query(Net).recursive("Walks", {
		row: { node: uuid, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(V, "v")
				return r
					.match(V, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ node: id, hops: lit(0) })
			}
		],
		rec: [
			(r, self) => {
				const { node, hops } = v(self, "self")
				const { to } = v(E, "e")
				return r
					.match(self, { node, hops })
					.match(E, { from: node, to })
					.match(V, { id: to })
					.where(r.lt(hops, bound))
					.find({ node: to, hops: Compute.add(hops, lit(1)) })
			}
		]
	})

/** The arms several definitions share: a rule over Net, and the feedback of a definition whose state is one vertex. */
type NetRule = Rule<typeof Net>
type NodeSelf = SelfSource<{ readonly node: typeof uuid }>

const forward = (r: NetRule, self: NodeSelf) => {
	const { node } = v(self, "self")
	const { to } = v(E, "e")
	return r.match(self, { node }).match(E, { from: node, to }).find({ node: to })
}

const backward = (r: NetRule, self: NodeSelf) => {
	const { node } = v(self, "self")
	const { from } = v(E, "e")
	return r.match(self, { node }).match(E, { from, to: node }).find({ node: from })
}

const rootArm = (r: NetRule) => {
	const { id } = v(V, "v")
	return r
		.match(V, { id })
		.where(r.eq(id, r.param("start", uuid)))
		.find({ node: id })
}

const Both = query(Net).recursive("Both", {
	row: { node: uuid },
	base: [rootArm],
	rec: [forward, backward]
})

const Open = query(Net).recursive("Open", {
	row: { node: uuid },
	base: [rootArm],
	rec: [
		(r, self) => {
			const { node } = v(self, "self")
			const { to } = v(E, "e")
			return r
				.match(self, { node })
				.match(E, { from: node, to })
				.where(r.not(B, { id: to }))
				.find({ node: to })
		},
		(r, self) => {
			const { node } = v(self, "self")
			const { to } = v(E, "e")
			return r
				.match(self, { node })
				.match(E, { from: node, to })
				.where(r.ne(to, r.param("avoid", uuid)))
				.find({ node: to })
		}
	]
})

/** A countdown from `seed` along the edges while it is above zero. */
const countdownFrom = (seed: number) =>
	query(Net).recursive("Countdown", {
		row: { node: uuid, left: pg.integer },
		base: [
			(r) => {
				const { id } = v(V, "v")
				return r
					.match(V, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ node: id, left: lit(seed) })
			}
		],
		rec: [
			(r, self) => {
				const { node, left } = v(self, "self")
				const { to } = v(E, "e")
				return r
					.match(self, { node, left })
					.match(E, { from: node, to })
					.where(r.gt(left, 0))
					.find({ node: to, left: Compute.sub(left, lit(1)) })
			}
		]
	})

const Reach = query(Net).recursive("Reach", {
	row: { node: uuid },
	base: [rootArm],
	rec: [forward]
})

const Upstream = query(Net).recursive("Upstream", {
	row: { node: uuid },
	base: [
		(r) => {
			const source = Reach.bind({ start: r.param("start", uuid) })
			const { node } = v(source, "source")
			const { from } = v(E, "e")
			return r
				.match(source, { node })
				.match(E, { from, to: node })
				.where(r.eq(node, r.param("target", uuid)))
				.find({ node: from })
		}
	],
	rec: [backward]
})

const Pairs = query(Net).recursive("Pairs", {
	row: { a: uuid, b: uuid },
	base: [
		(r) => {
			const { from, to } = v(E, "e")
			return r.match(E, { from, to }).find({ a: from, b: to })
		}
	],
	rec: [
		(r, self) => {
			const { a, b } = v(self, "self")
			const { to } = v(E, "e")
			return r.match(self, { a, b }).match(E, { from: b, to }).find({ a, b: to })
		},
		(r, self) => {
			const { b } = v(self, "self")
			const { from } = v(E, "e")
			return r
				.match(self, { a: r.param("start", uuid), b })
				.match(E, { from, to: b })
				.find({ a: from, b })
		}
	]
})

/**
 * Every vertex with the vertices one or more steps below it, attached: the recursive child reads the parent's id in
 * its base and carries it in its state as its origin.
 */
const Below = query(Net)
	.rule((r) => {
		const { id } = v(V, "v")
		return r.match(V, { id }).find({ id })
	})
	.attach(
		"below",
		(p) =>
			query(Net).recursive("Below", {
				row: { node: uuid },
				base: [
					(r) => {
						const { to } = v(E, "e")
						return r.match(E, { from: p.id, to }).find({ node: to })
					}
				],
				rec: [forward]
			}),
		"array"
	)

/**
 * The same with the parent's id delivered under a declared row key, the correlation column the checker names after
 * it: the recursive arm's `root: p.id` reads the root carried in the state, never the outer parent, so no parent's
 * traversal merges with another's.
 */
const Rooted = query(Net)
	.rule((r) => {
		const { id } = v(V, "v")
		return r.match(V, { id }).find({ id })
	})
	.attach(
		"below",
		(p) =>
			query(Net).recursive("Rooted", {
				row: { node: uuid, root: uuid },
				base: [
					(r) => {
						const { to } = v(E, "e")
						return r.match(E, { from: p.id, to }).find({ node: to, root: p.id })
					}
				],
				rec: [
					(r, self) => {
						const { node } = v(self, "self")
						const { to } = v(E, "e")
						return r
							.match(self, { node })
							.match(E, { from: node, to })
							.find({ node: to, root: p.id })
					}
				]
			}),
		"array"
	)

/** The same with two factored transition arms: the origin is carried by the one feedback scan. */
const Around = query(Net)
	.rule((r) => {
		const { id } = v(V, "v")
		return r.match(V, { id }).find({ id })
	})
	.attach(
		"around",
		(p) =>
			query(Net).recursive("Around", {
				row: { node: uuid },
				base: [
					(r) => {
						const { to } = v(E, "e")
						return r.match(E, { from: p.id, to }).find({ node: to })
					}
				],
				rec: [forward, backward]
			}),
		"array"
	)

/** The recursions every case runs. */
const recursions = [
	"Walks",
	"Both",
	"Open",
	"Countdown",
	"Upstream",
	"Pairs",
	"Below",
	"Rooted",
	"Around"
] as const
type Recursion = (typeof recursions)[number]

/**
 * A drawn case: a hop bound and countdown seed, a graph, and the vertices the start, avoid and target parameters name,
 * each up to one past the graph's last vertex, which names no vertex.
 */
interface Sketch {
	readonly bound: number
	readonly graph: Graph
	readonly start: number
	readonly avoid: number
	readonly target: number
}

const sketchGen: Gen<Sketch> = (source) => {
	const graph = source.draw(graphGen)
	const named = int(0, graph.vertices)
	return {
		bound: source.draw(int(0, 4)),
		graph,
		start: source.draw(named),
		avoid: source.draw(named),
		target: source.draw(named)
	}
}

/** A recursion's oracle case over a sketch: built and admitted, its parameters bound to the vertices the sketch names. */
const caseOfSketch = (recursion: Recursion, k: Sketch): LabelledCase => {
	const start = vertexId(k.start)
	switch (recursion) {
		case "Walks":
			return caseOf(recursion, walksBelow(k.bound), { start }, k.graph)
		case "Both":
			return caseOf(recursion, Both, { start }, k.graph)
		case "Open":
			return caseOf(recursion, Open, { start, avoid: vertexId(k.avoid) }, k.graph)
		case "Countdown":
			return caseOf(recursion, countdownFrom(k.bound), { start }, k.graph)
		case "Upstream":
			return caseOf(recursion, Upstream, { start, target: vertexId(k.target) }, k.graph)
		case "Pairs":
			return caseOf(recursion, Pairs, { start }, k.graph)
		case "Below":
			return caseOf(recursion, Below, {}, k.graph)
		case "Rooted":
			return caseOf(recursion, Rooted, {}, k.graph)
		case "Around":
			return caseOf(recursion, Around, {}, k.graph)
	}
}

/** A recursion agreeing with the reference evaluator, with rows or with none. */
type AgreedFeature = `${Recursion} agreed with rows` | `${Recursion} agreed with none`

layer(Substrate.layer)("admitted recursions on PostgreSQL 19", (it) => {
	it.effect("agree with the reference evaluator as raw text sets, with no repeated row", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const name = yield* s.schema({ create: false, label: "admission" })
				return yield* explore(
					{
						suite: "recursion/admission",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "the reference evaluator over the same facts, raw text sets with no repeated row"
						},
						coverage: required<AgreedFeature>(
							Arr.map(recursions, (r): AgreedFeature => `${r} agreed with rows`),
							{ cases: 24, sense: notesOnly }
						),
						kept: [],
						runs: 12,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(k, c) =>
						Effect.forEach(
							recursions,
							(recursion) =>
								Effect.gen(function* () {
									const outcome = yield* runLabelledOracle(
										caseOfSketch(recursion, k),
										conservative,
										reference,
										{
											...defaultRunOptions,
											schema: { kind: "named", name: name }
										}
									)
									assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
									c.note(
										Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)
											? `${recursion} agreed with rows`
											: `${recursion} agreed with none`
									)
								}),
							{ discard: true }
						)
				)
			})
		)
	)
})
