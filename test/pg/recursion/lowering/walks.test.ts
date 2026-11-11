import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { noCoverage, required } from "@grizzle/testing/features"
import { array, boolean, type Gen, int, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter } from "effect"
import { groupingSteps } from "#bench/harness/explain.ts"
import { checkQuery } from "#compiler/check/index.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { Compute, type Predicate, type Term } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { explainMain, lowerCase, optimizedLowering } from "#test/pg/recursion/lowering/support.ts"
import { assert } from "#test/support/assert.ts"
import { programAsts } from "#test/support/compile.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
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
 * The Walks example through the optimized lowering on PostgreSQL 19 (V6).
 *
 * Walks is admitted with explicit casts and lowered by the optimized pipeline to WITH RECURSIVE ... UNION, at every
 * depth its counter bounds it to; that it agrees with the reference and the conservative lowering is also the graph
 * suite's (graph/equivalence). Its plan has one Recursive Union and, its seed and step being plain SELECTs and its
 * consumer the complete state, no Unique or Aggregate node at all (the recursive UNION's hash is the only
 * deduplication). A consumer that drops the hop count deduplicates once, outside the recursion.
 *
 * Counters past Walks's own each lower to the recursive CTE and agree with the reference and the conservative
 * lowering: one or two seeds, and one or two arms, each forward or backward along a follow, counting up or down by one
 * or two while a bound in the direction it counts holds, strict or not, its operands either way round, or a between.
 *
 * Every case draws its graph: up to six people, each ordered pair of them a follow or not, so diamonds, cycles,
 * self-loops and dead ends arrive by several routes, and the person a walk starts from, now and then one past them.
 *
 * Plants (main's test phase): recursion-walk-plans-distinct-consumer.patch,
 * recursion-optimized-feedback-union-all.patch.
 */

/** The graph fixture's Network. */
const Person = relation("Person", { id: uuid, name: str.regex("^.*$", "su") }, ["id"])
const Follows = relation("Follows", { from: uuid, to: uuid }, ["from", "to"])
const Network = schema("Network", { Person, Follows }, [
	contained(on(Follows, "from"), on(Person, "id")),
	contained(on(Follows, "to"), on(Person, "id"))
])

/** The (person, hops) states reachable from the start in fewer than `limit` hops, which proves depth `limit`. */
const walksBelow = (name: string, limit: number) =>
	query(Network).recursive(name, {
		row: { person: uuid, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Person, "person")
				return r
					.match(Person, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ person: id, hops: Compute.literal(pg.integer, 0) })
			}
		],
		rec: [
			(r, self) => {
				const { person, hops } = v(self, "self")
				const { to } = v(Follows, "follows")
				return r
					.match(self, { person, hops })
					.match(Follows, { from: person, to })
					.match(Person, { id: to })
					.where(r.lt(hops, limit))
					.find({
						person: to,
						hops: Compute.add(hops, Compute.literal(pg.integer, 1))
					})
			}
		]
	})

/** The people a walk reaches, its hop count dropped. */
const reachableBy = (walks: ReturnType<typeof walksBelow>) =>
	query(Network).rule((r) => {
		const source = walks.bind({ start: r.param("person", uuid) })
		const { person } = v(source, "source")
		return r.match(source, { person }).find({ person })
	})

const vertex = (i: number): Uuid => `00000000-0000-4000-8000-00000000000${i}`
const vertexId = (i: number): TypedLiteral => ({ kind: "uuid", value: vertex(i) })

/** A graph over the people 0 … n - 1, each ordered pair of them a follow or not. */
interface Graph {
	readonly people: number
	readonly follows: ReadonlyArray<readonly [number, number]>
}

const graphGen: Gen<Graph> = (source) => {
	const people = source.draw(int(1, 6))
	const each = upTo(people, (i) => i)
	return {
		people,
		follows: source.draw(subarray(Arr.flatMap(each, (a) => Arr.map(each, (b) => [a, b] as const))))
	}
}

const checked = checking(Network)

const headingOf = (name: string) => {
	const info = checked.relations.get(name)
	if (info === undefined) {
		throw new Error(`no relation ${name}`)
	}
	return info
}

const genSchema: GenSchema = {
	name: "Network",
	relations: Arr.map(["Person", "Follows"], (name) => {
		const info = headingOf(name)
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
		{ from: { relation: "Follows", fields: ["from"] }, to: { relation: "Person", fields: ["id"] } },
		{ from: { relation: "Follows", fields: ["to"] }, to: { relation: "Person", fields: ["id"] } }
	]
}

/** A fact in its relation's checked column order. */
const row = (
	relationName: string,
	values: Readonly<Record<string, TypedLiteral>>
): ReadonlyArray<TypedLiteral> =>
	Arr.map(headingOf(relationName).heading, (c) => {
		const value = values[c.name]
		if (value === undefined) {
			throw new Error(`no value for ${relationName}.${c.name}`)
		}
		return value
	})

const factsOf = (graph: Graph) => ({
	Person: upTo(graph.people, (i) =>
		row("Person", { id: vertexId(i), name: { kind: "text", value: `p${i}` } })
	),
	Follows: Arr.map(graph.follows, ([a, b]) =>
		row("Follows", { from: vertexId(a), to: vertexId(b) })
	)
})

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
	const r = checkQuery(checking(Network), desc, checkOptions("query"))
	if (!r.ok) {
		throw new Error(`${label}: ${r.error.message}`)
	}
	const dag = normalQuery(r.value.dag)
	const params: Record<string, GenParam> = {}
	for (const p of r.value.params) {
		const value = values[p.name]
		if (value === undefined || p.kind === "relation") {
			throw new Error(`${label}: no value for ${p.name}`)
		}
		params[p.id] = { kind: "scalar", type: p.type, value }
	}
	return {
		schema: genSchema,
		facts: canonicalFacts(factsOf(graph)),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false },
		label
	}
}

const optimized = optimizedLowering("optimized")

/** A walk: its bound, its graph, and the person it starts from, now and then one past the graph. */
interface WalkSketch {
	readonly bound: number
	readonly graph: Graph
	readonly start: number
}

const walkGen: Gen<WalkSketch> = (source) => {
	const graph = source.draw(graphGen)
	return { bound: source.draw(int(1, 6)), graph, start: source.draw(int(0, graph.people)) }
}

/** What the walks' search shares. */
const walkSearch = {
	draw: drawn(walkGen),
	literal: Formatter.format,
	kept: [],
	runs: 12,
	shrink: completeShrink,
	concurrency: 1,
	steerEvery: 16,
	caseHang
} as const

type ReachedFeature = "reached people" | "reached nobody"

layer(Substrate.layer)("the Walks example through the optimized lowering", (it) => {
	it.effect("each walk's plan has one Recursive Union and no other deduplication (V6)", (ctx) =>
		searched(
			ctx,
			explore(
				{
					...walkSearch,
					suite: "recursion/lowering/walk-plans",
					oracle: {
						kind: "postgresql",
						name: "EXPLAIN's plan: one Recursive Union over one WorkTable Scan and no other deduplication step"
					},
					coverage: noCoverage
				},
				(k) =>
					Effect.gen(function* () {
						const c = caseOf(
							"Walks",
							walksBelow("Walks", k.bound),
							{ start: vertexId(k.start) },
							k.graph
						)
						const plan = yield* explainMain(c, optimized)
						assert.equal(Arr.filter(plan.nodes, (n) => n === "Recursive Union").length, 1, plan.sql)
						assert.equal(Arr.filter(plan.nodes, (n) => n === "WorkTable Scan").length, 1, plan.sql)
						assert.deepEqual(
							groupingSteps(plan.nodes),
							[],
							`${Arr.join(plan.nodes, ", ")}\n${plan.sql}`
						)
					})
			)
		)
	)

	it.effect(
		"dropping the hop count deduplicates once, outside the recursion, and agrees with the reference",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const name = yield* s.schema({ create: false, label: "reachable" })
					return yield* explore(
						{
							...walkSearch,
							suite: "recursion/lowering/reachable",
							oracle: {
								kind: "second-implementation",
								name: "the reference evaluator over the same facts; EXPLAIN's plan, one Recursive Union and one deduplication"
							},
							coverage: required<ReachedFeature>(["reached people", "reached nobody"], {
								cases: 24,
								sense: notesOnly
							})
						},
						(k, c) =>
							Effect.gen(function* () {
								const reached = caseOf(
									"Reachable",
									reachableBy(walksBelow("Walks", k.bound)),
									{ person: vertexId(k.start) },
									k.graph
								)
								const outcome = yield* runLabelledOracle(reached, optimized, reference, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								const plan = yield* explainMain(reached, optimized)
								assert.equal(Arr.filter(plan.nodes, (n) => n === "Recursive Union").length, 1)
								assert.equal(
									groupingSteps(plan.nodes).length,
									1,
									`${Arr.join(plan.nodes, ", ")}\n${plan.sql}`
								)
								c.note(
									Arr.some(outcome.left.run.statements, (st) => st.rows.length > 0)
										? "reached people"
										: "reached nobody"
								)
							})
					)
				})
			)
	)
})

/**
 * Counters past the Walks shape: one or two seeds, and one or two arms, each forward or backward along a follow,
 * counting up or down while a bound in the direction it counts holds. Each lowers to the recursive CTE, which must
 * agree row for row with the reference evaluator and the conservative lowering.
 */
type NetworkRule = Rule<typeof Network>
/** The feedback of a counter: the person reached and the hop count. */
type CounterSelf = SelfSource<{ readonly person: typeof uuid; readonly hops: typeof pg.integer }>
type Hops = Term<number, unknown, unknown, "integer">

/** An integer literal of the counter's field. */
const lit = (n: number) => Compute.literal(pg.integer, n)

/**
 * The bound an arm's filter states in the direction its step counts: below or at a limit counting up, above or at it
 * counting down, its operands either way round; or a between.
 */
type Bound =
	| Readonly<{ kind: "compare"; strict: boolean; swapped: boolean; limit: number }>
	| Readonly<{ kind: "between"; low: number; high: number }>

/** An arm: the direction it follows, its step, nonzero, and its bound. */
interface Arm {
	readonly backward: boolean
	readonly step: number
	readonly bound: Bound
}

interface CounterSketch {
	readonly seeds: Arr.NonEmptyReadonlyArray<number>
	readonly arms: Arr.NonEmptyReadonlyArray<Arm>
	readonly graph: Graph
	readonly start: number
}

const boundGen: Gen<Bound> = (source) => {
	if (source.draw(boolean)) {
		const low = source.draw(int(-1, 3))
		return { kind: "between", low, high: low + source.draw(int(0, 3)) }
	}
	return {
		kind: "compare",
		strict: source.draw(boolean),
		swapped: source.draw(boolean),
		limit: source.draw(int(-1, 5))
	}
}

const armGen: Gen<Arm> = (source) => ({
	backward: source.draw(boolean),
	step: source.draw(boolean) ? source.draw(int(1, 2)) : -source.draw(int(1, 2)),
	bound: source.draw(boundGen)
})

const counterGen: Gen<CounterSketch> = (source) => {
	const graph = source.draw(graphGen)
	return {
		seeds: [source.draw(int(-2, 4)), ...source.draw(array(int(-2, 4), { min: 0, max: 1 }))],
		arms: [source.draw(armGen), ...source.draw(array(armGen, { min: 0, max: 1 }))],
		graph,
		start: source.draw(int(0, graph.people))
	}
}

/** An arm's filter: its bound over the hop count, in the direction its step counts. */
const filterOf = (r: NetworkRule, hops: Hops, arm: Arm): Predicate => {
	const { bound } = arm
	if (bound.kind === "between") {
		return r.between(hops, bound.low, bound.high)
	}
	const limit = bound.limit
	if (arm.step > 0) {
		if (bound.swapped) {
			return bound.strict ? r.gt(lit(limit), hops) : r.ge(lit(limit), hops)
		}
		return bound.strict ? r.lt(hops, limit) : r.le(hops, limit)
	}
	if (bound.swapped) {
		return bound.strict ? r.lt(lit(limit), hops) : r.le(lit(limit), hops)
	}
	return bound.strict ? r.gt(hops, limit) : r.ge(hops, limit)
}

const armOf = (arm: Arm) => (r: NetworkRule, self: CounterSelf) => {
	const { person, hops } = v(self, "self")
	const { from, to } = v(Follows, "follows")
	return r
		.match(self, { person, hops })
		.match(Follows, arm.backward ? { from, to: person } : { from: person, to })
		.where(filterOf(r, hops, arm))
		.find({
			person: arm.backward ? from : to,
			hops: arm.step > 0 ? Compute.add(hops, lit(arm.step)) : Compute.sub(hops, lit(-arm.step))
		})
}

const counterOf = (k: CounterSketch): unknown =>
	query(Network).recursive("Counter", {
		row: { person: uuid, hops: pg.integer },
		base: Arr.map(k.seeds, (seed) => (r: NetworkRule) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ person: id, hops: lit(seed) })
		}),
		rec: Arr.map(k.arms, armOf)
	})

type CounterFeature =
	| "counting up"
	| "counting down"
	| "arms counting both ways"
	| "two seeds"
	| "a stride of two"
	| "a backward arm"
	| "a between"
	| "swapped operands"
	| "a non-strict bound"
	| "rows reached past a seed"

layer(Substrate.layer)("counter shapes through the optimized lowering", (it) => {
	it.effect(
		"each lowers to the recursive CTE and agrees with the reference and the conservative lowering",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const names = productionNames(
						"Network",
						{ kind: "declared" },
						localVectorSchema,
						emptyCodebook
					)
					const name = yield* s.schema({ create: false, label: "counters" })
					return yield* explore(
						{
							suite: "recursion/lowering/counters",
							draw: drawn(counterGen),
							literal: Formatter.format,
							oracle: {
								kind: "second-implementation",
								name: "the reference evaluator and the conservative lowering over the same facts"
							},
							coverage: required<CounterFeature>(
								[
									"counting up",
									"counting down",
									"arms counting both ways",
									"two seeds",
									"a stride of two",
									"a backward arm",
									"a between",
									"swapped operands",
									"a non-strict bound",
									"rows reached past a seed"
								],
								{ cases: 48, sense: notesOnly }
							),
							kept: [],
							runs: 24,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(k, c) =>
							Effect.gen(function* () {
								const counted = caseOf(
									"Counter",
									counterOf(k),
									{ start: vertexId(k.start) },
									k.graph
								)
								const u = lowerCase(counted, names)
								if (!u.ok) {
									return assert.fail(`the counter is refused: ${u.error.message}`)
								}
								const [statement] = programAsts(u.value)
								assert.ok(
									featureCount(shapeOf(statement), "with recursive") > 0,
									"the counter lowers to the recursive CTE"
								)
								const outcome = yield* runLabelledOracle(counted, optimized, reference, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								const against = yield* runLabelledOracle(counted, optimized, conservative, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(against.comparison.equal, true, printOutcome(against))
								const up = Arr.some(k.arms, (arm) => arm.step > 0)
								const down = Arr.some(k.arms, (arm) => arm.step < 0)
								c.note(up ? "counting up" : "counting down")
								if (up && down) {
									c.note("arms counting both ways")
								}
								if (k.seeds.length > 1) {
									c.note("two seeds")
								}
								if (Arr.some(k.arms, (arm) => Math.abs(arm.step) > 1)) {
									c.note("a stride of two")
								}
								if (Arr.some(k.arms, (arm) => arm.backward)) {
									c.note("a backward arm")
								}
								for (const { bound } of k.arms) {
									if (bound.kind === "between") {
										c.note("a between")
									} else {
										if (bound.swapped) {
											c.note("swapped operands")
										}
										if (!bound.strict) {
											c.note("a non-strict bound")
										}
									}
								}
								if (
									Arr.some(outcome.left.run.statements, (st) => st.rows.length > k.seeds.length)
								) {
									c.note("rows reached past a seed")
								}
							})
					)
				})
			)
	)
})
