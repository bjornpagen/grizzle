import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect } from "effect"
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

/**
 * Admitted recursions run on PostgreSQL 19.
 *
 * Each query below is built with the query builder, admitted by the checker (packages/engine/src/check/recursion), lowered
 * by the conservative lowering and run on PostgreSQL, and its rows are compared as raw text multisets with the
 * reference evaluator's rows over the same facts (test/support/oracle/runner.ts), with no repeated row on either side.
 * The graph has a diamond, a cycle, a self-loop and a dead end, so equal states arrive along several routes and in
 * several iterations. The queries are the Walks example, a closure walking both
 * directions through two factored transition arms read by one feedback scan, negation of a fixed
 * external relation in the step, a countdown, a second recursive stage seeded from a completed first one,
 * and the transitive closure of pairs with an arm that fixes a state column.
 */

const V = relation("V", { id: uuid }, ["id"])
const E = relation("E", { from: uuid, to: uuid, cost: pg.integer }, ["from", "to"])
const B = relation("B", { id: uuid }, ["id"])
const Net = schema("Net", { V, E, B }, [
	contained(on(E, "from"), on(V, "id")),
	contained(on(E, "to"), on(V, "id"))
])

const vertex = (i: number): Uuid => `00000000-0000-4000-8000-00000000000${i}`
const vertexId = (i: number): TypedLiteral => ({ kind: "uuid", value: vertex(i) })
const int8 = (n: number): TypedLiteral => ({ kind: "int", value: BigInt(n) })

/** 0 -> 1 -> 3, 0 -> 2 -> 3 (a diamond), 3 -> 4 -> 0 (a cycle), 4 -> 5 -> 5 (a self-loop), and 6 a dead end. */
const edges: ReadonlyArray<readonly [number, number]> = [
	[0, 1],
	[0, 2],
	[1, 3],
	[2, 3],
	[3, 4],
	[4, 0],
	[4, 5],
	[5, 5],
	[3, 6]
]

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

const facts = {
	V: Arr.map([0, 1, 2, 3, 4, 5, 6], (i) => [vertexId(i)]),
	/** In the checked heading's canonical column order: cost, from, to. */
	E: Arr.map(edges, ([a, b], i) => [int8(i + 1), vertexId(a), vertexId(b)]),
	B: [[vertexId(2)]]
}

/** The oracle case of an admitted query, its scalar parameters bound to `values`. */
const caseOf = (
	label: string,
	q: unknown,
	values: Readonly<Record<string, TypedLiteral>>
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
		facts: canonicalFacts(facts),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false },
		label
	}
}

const int = (n: number) => Compute.literal(pg.integer, n)

const Walks = query(Net).recursive("Walks", {
	row: { node: uuid, hops: pg.integer },
	base: [
		(r) => {
			const { id } = v(V, "v")
			return r
				.match(V, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ node: id, hops: int(0) })
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
				.where(r.lt(hops, 4))
				.find({ node: to, hops: Compute.add(hops, int(1)) })
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

const Countdown = query(Net).recursive("Countdown", {
	row: { node: uuid, left: pg.integer },
	base: [
		(r) => {
			const { id } = v(V, "v")
			return r
				.match(V, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ node: id, left: int(3) })
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
				.find({ node: to, left: Compute.sub(left, int(1)) })
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

const cases: Arr.NonEmptyReadonlyArray<LabelledCase> = [
	caseOf("Walks", Walks, { start: vertexId(0) }),
	caseOf("Both", Both, { start: vertexId(3) }),
	caseOf("Open", Open, { start: vertexId(0), avoid: vertexId(6) }),
	caseOf("Countdown", Countdown, { start: vertexId(0) }),
	caseOf("Upstream", Upstream, { start: vertexId(0), target: vertexId(3) }),
	caseOf("Pairs", Pairs, { start: vertexId(0) }),
	caseOf("Below", Below, {}),
	caseOf("Rooted", Rooted, {}),
	caseOf("Around", Around, {})
]

/** An admitted query agreeing with the reference evaluator, by its label. */
type AgreedFeature = `agreed: ${string}`

layer(Substrate.layer)("admitted recursions on PostgreSQL 19", (it) => {
	it.effect(
		"agree with the reference evaluator as raw text multisets, with no repeated row",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const name = yield* s.schema({ create: false, label: "admission" })
					return yield* exhaust(
						{
							suite: "recursion/admission",
							generator: element(cases),
							literal: (c: LabelledCase) => c.label,
							limit: cases.length,
							coverage: requiredInSpace<AgreedFeature>(
								Arr.map(cases, (c): AgreedFeature => `agreed: ${c.label}`)
							),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const outcome = yield* runLabelledOracle(c, conservative, reference, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								assert.ok(
									Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0),
									printOutcome(outcome)
								)
								k.note(`agreed: ${c.label}`)
							})
					)
				})
			)
	)
})
