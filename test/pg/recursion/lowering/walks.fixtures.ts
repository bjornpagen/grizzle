/** What the properties of walks.test.ts read: its spaces, models and helpers. */

import { array, boolean, type Gen, int, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { Num, type Predicate, type Term, Type } from "#compiler/public/compute.ts"
import { pg, type Uuid } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { Id } from "#test/support/ids.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { canonicalFacts } from "#test/support/oracle/gen/facts.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import type { GenSchema } from "#test/support/oracle/gen/schema.ts"
import type { LabelledCase } from "#test/support/oracle/runner.ts"
import { optimizedLowering } from "#test/support/pg/recursion/lowering/support.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
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
 */

/** The graph fixture's Network. */
const Person = relation("Person", { id: Id, name: str.regex("^.*$", "su") }, ["id"])

const Follows = relation("Follows", { from: Id, to: Id }, ["from", "to"])

const Network = schema(
	"Network",
	[Person, Follows],
	[contained(on(Follows, "from"), on(Person, "id")), contained(on(Follows, "to"), on(Person, "id"))]
)

/** The (person, hops) states reachable from the start in fewer than `limit` hops, which proves depth `limit`. */
export const walksBelow = (name: string, limit: number) =>
	query(Network).recursive(name, {
		row: { person: Id, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Person, "person")
				return r
					.match(Person, { id })
					.where(r.eq(id, r.param("start", Id)))
					.find({ person: id, hops: Type.literal(pg.integer, 0) })
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
						hops: Num.add(hops, Type.literal(pg.integer, 1))
					})
			}
		]
	})

/** The people a walk reaches, its hop count dropped. */
export const reachableBy = (walks: ReturnType<typeof walksBelow>) =>
	query(Network).rule((r) => {
		const source = walks.bind({ start: r.param("person", Id) })
		const { person } = v(source, "source")
		return r.match(source, { person }).find({ person })
	})

const vertex = (i: number): Uuid => `00000000-0000-4000-8000-00000000000${i}`

export const vertexId = (i: number): TypedLiteral => ({ kind: "uuid", value: vertex(i) })

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

export const caseOf = (
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

export const optimized = optimizedLowering("optimized")

/** A walk: its bound, its graph, and the person it starts from, now and then one past the graph. */
interface WalkSketch {
	readonly bound: number
	readonly graph: Graph
	readonly start: number
}

export const walkGen: Gen<WalkSketch> = (source) => {
	const graph = source.draw(graphGen)
	return { bound: source.draw(int(1, 6)), graph, start: source.draw(int(0, graph.people)) }
}

export type ReachedFeature = "reached people" | "reached nobody"

/**
 * Counters past the Walks shape: one or two seeds, and one or two arms, each forward or backward along a follow,
 * counting up or down while a bound in the direction it counts holds. Each lowers to the recursive CTE, which must
 * agree row for row with the reference evaluator and the conservative lowering.
 */
type NetworkRule = Rule<typeof Network>

/** The feedback of a counter: the person reached and the hop count. */
type CounterSelf = SelfSource<{ readonly person: typeof Id; readonly hops: typeof pg.integer }>

type Hops = Term<number, unknown, unknown, "integer">

/** An integer literal of the counter's field. */
const lit = (n: number) => Type.literal(pg.integer, n)

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

export const counterGen: Gen<CounterSketch> = (source) => {
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
			hops: arm.step > 0 ? Num.add(hops, lit(arm.step)) : Num.sub(hops, lit(-arm.step))
		})
}

export const counterOf = (k: CounterSketch): unknown =>
	query(Network).recursive("Counter", {
		row: { person: Id, hops: pg.integer },
		base: Arr.map(k.seeds, (seed) => (r: NetworkRule) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", Id)))
				.find({ person: id, hops: lit(seed) })
		}),
		rec: Arr.map(k.arms, armOf)
	})

export type CounterFeature =
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

export const names = productionNames(
	"Network",
	{ kind: "declared" },
	localVectorSchema,
	emptyCodebook
)
