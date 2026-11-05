import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { noCoverage, requiredInSpace } from "@grizzle/testing/features"
import { element } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { emptyCodebook } from "#compiler/ir/codes.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { Compute, type Predicate, type Term } from "#compiler/public/compute.ts"
import { pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { queryValueDesc } from "#compiler/query/build/query.ts"
import { explainMain, lowerCase, optimizedLowering } from "#test/pg/recursion/lowering/support.ts"
import { assert, contains } from "#test/support/assert.ts"
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

/**
 * The Walks example through the optimized lowering on PostgreSQL 19 (V6).
 *
 * Walks is admitted with explicit casts and lowered by the optimized pipeline to WITH RECURSIVE ... UNION, at every
 * depth its counter bounds it to (hops < 4 from 0, and the same walk one hop longer); that it agrees with the reference
 * and the conservative lowering is also the graph suite's (graph/equivalence). Its plan has one Recursive Union and,
 * its seed and step being plain SELECTs and its consumer the complete state, no Unique or Aggregate node at all, where
 * the conservative plan deduplicates (the recursive UNION's hash is the only deduplication). A consumer that drops the
 * hop count deduplicates once, outside the recursion.
 *
 * The counter shapes past Walks's own (a union of arms bounded unequally, a between, swapped operands, a decreasing
 * counter, a step of two over two seeds) each lower to the recursive CTE and agree with the reference and the
 * conservative lowering.
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

/** Walks: depth 4. LongWalks: one hop more. */
const Walks = walksBelow("Walks", 4)
const LongWalks = walksBelow("LongWalks", 5)

/** The people a walk reaches, its hop count dropped. */
const reachableBy = (walks: typeof Walks) =>
	query(Network).rule((r) => {
		const source = walks.bind({ start: r.param("person", uuid) })
		const { person } = v(source, "source")
		return r.match(source, { person }).find({ person })
	})

const vertex = (i: number): Uuid => `00000000-0000-4000-8000-00000000000${i}`
const vertexId = (i: number): TypedLiteral => ({ kind: "uuid", value: vertex(i) })

/** 0 -> 1 -> 3, 0 -> 2 -> 3 (a diamond), 3 -> 4 -> 0 (a cycle), 4 -> 5 -> 5 (a self-loop), and 3 -> 6, a dead end. */
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

const facts = {
	Person: Arr.map([0, 1, 2, 3, 4, 5, 6], (i) =>
		row("Person", { id: vertexId(i), name: { kind: "text", value: `p${i}` } })
	),
	Follows: Arr.map(edges, ([a, b]) => row("Follows", { from: vertexId(a), to: vertexId(b) }))
}

const caseOf = (
	label: string,
	q: unknown,
	values: Readonly<Record<string, TypedLiteral>>
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
		facts: canonicalFacts(facts),
		query: { dag, params },
		spelling: { mode: "drawn", edge: false },
		label
	}
}

const optimized = optimizedLowering("optimized")

const walks = caseOf("Walks", Walks, { start: vertexId(0) })
const longWalks = caseOf("LongWalks", LongWalks, { start: vertexId(0) })
const reachable = caseOf("Reachable", reachableBy(Walks), { person: vertexId(0) })
const longReachable = caseOf("LongReachable", reachableBy(LongWalks), { person: vertexId(0) })

/** A case that agreed with the reference, by its label. */
type AgreedFeature = `agreed: ${string}`

const deduplicating = (nodes: ReadonlyArray<string>): number =>
	Arr.filter(nodes, (n) => n === "Unique" || n === "Aggregate").length

layer(Substrate.layer)("the Walks example through the optimized lowering", (it) => {
	it.effect("each walk's plan has one Recursive Union and no other deduplication (V6)", (ctx) => {
		const walkCases: Arr.NonEmptyReadonlyArray<LabelledCase> = [walks, longWalks]
		return searched(
			ctx,
			exhaust(
				{
					suite: "recursion/lowering/walk-plans",
					generator: element(walkCases),
					literal: (c: LabelledCase) => c.label,
					limit: walkCases.length,
					coverage: noCoverage,
					caseHang
				},
				(c) =>
					Effect.gen(function* () {
						const plan = yield* explainMain(c, optimized)
						assert.equal(Arr.filter(plan.nodes, (n) => n === "Recursive Union").length, 1, plan.sql)
						assert.equal(Arr.filter(plan.nodes, (n) => n === "WorkTable Scan").length, 1, plan.sql)
						assert.equal(deduplicating(plan.nodes), 0, `${Arr.join(plan.nodes, ", ")}\n${plan.sql}`)
						/** The conservative plan of the same query deduplicates the seed and the step itself. */
						const baseline = yield* explainMain(c, conservative)
						contains(baseline.nodes, "Recursive Union")
						assert.ok(deduplicating(baseline.nodes) > 0, Arr.join(baseline.nodes, ", "))
					})
			)
		)
	})

	it.effect("dropping the hop count deduplicates once, outside the recursion", (ctx) =>
		searched(
			ctx,
			Effect.gen(function* () {
				const s = yield* Substrate
				const name = yield* s.schema({ create: false, label: "reachable" })
				const reachables: Arr.NonEmptyReadonlyArray<LabelledCase> = [reachable, longReachable]
				const agreed = yield* exhaust(
					{
						suite: "recursion/lowering/reachable",
						generator: element(reachables),
						literal: (c: LabelledCase) => c.label,
						limit: reachables.length,
						coverage: requiredInSpace<AgreedFeature>(
							Arr.map(reachables, (c): AgreedFeature => `agreed: ${c.label}`)
						),
						caseHang
					},
					(c, k) =>
						Effect.gen(function* () {
							const outcome = yield* runLabelledOracle(c, optimized, reference, {
								...defaultRunOptions,
								schema: { kind: "named", name: name }
							})
							assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
							assert.equal(outcome.comparison.leftDuplicates, 0, printOutcome(outcome))
							k.note(`agreed: ${c.label}`)
						})
				)
				const plan = yield* explainMain(longReachable, optimized)
				assert.equal(Arr.filter(plan.nodes, (n) => n === "Recursive Union").length, 1)
				assert.equal(deduplicating(plan.nodes), 1, `${Arr.join(plan.nodes, ", ")}\n${plan.sql}`)
				return agreed
			})
		)
	)
})

/**
 * Counters past the Walks shape: a union of arms bounded unequally, a between, swapped operands,
 * a decreasing counter, and a step of two over two seeds. Each lowers to the recursive CTE, which must agree row for
 * row with the reference evaluator and the conservative lowering.
 */
type NetworkRule = Rule<typeof Network>
/** The feedback of a counter: the person reached and the hop count. */
type CounterSelf = SelfSource<{ readonly person: typeof uuid; readonly hops: typeof pg.integer }>
type Hops = Term<number, unknown, unknown, "integer">

/** A step's next count: integer arithmetic is exact, and the counter proof narrows it into the row's integer field. */
type Next = Term<bigint, unknown, unknown, "exact integer">

/** The step's direction: from the person reached along a follow, or back against one. */
type Direction = "forward" | "backward"

const step =
	(
		bound: (r: NetworkRule, hops: Hops) => Predicate,
		direction: Direction,
		next: (hops: Hops) => Next
	) =>
	(r: NetworkRule, self: CounterSelf) => {
		const { person, hops } = v(self, "self")
		const { from, to } = v(Follows, "follows")
		return r
			.match(self, { person, hops })
			.match(Follows, direction === "backward" ? { from, to: person } : { from: person, to })
			.where(bound(r, hops))
			.find({ person: direction === "backward" ? from : to, hops: next(hops) })
	}

const counter = (
	name: string,
	rec: ReadonlyArray<ReturnType<typeof step>>,
	seeds: ReadonlyArray<number>
): unknown =>
	query(Network).recursive(name, {
		row: { person: uuid, hops: pg.integer },
		base: Arr.map(seeds, (seed) => (r: NetworkRule) => {
			const { id } = v(Person, "person")
			return r
				.match(Person, { id })
				.where(r.eq(id, r.param("start", uuid)))
				.find({ person: id, hops: Compute.literal(pg.integer, seed) })
		}),
		rec: [...rec]
	})

const plusOne = (hops: Hops) => Compute.add(hops, Compute.literal(pg.integer, 1))
const minusOne = (hops: Hops) => Compute.sub(hops, Compute.literal(pg.integer, 1))
const plusTwo = (hops: Hops) => Compute.add(hops, Compute.literal(pg.integer, 2))

/** Each counter case. */
interface Counter {
	readonly label: string
	readonly q: unknown
}
const counters: Arr.NonEmptyReadonlyArray<Counter> = [
	{
		/**
		 * Forward from hops 0 and 1, backward from 0 through 3: the backward states at hops 3 and 4 are reached only
		 * under the weaker arm's bound.
		 */
		label: "two arms bounded unequally",
		q: counter(
			"Both",
			[
				step((r, hops) => r.lt(hops, 2), "forward", plusOne),
				step((r, hops) => r.lt(hops, 4), "backward", plusOne)
			],
			[0]
		)
	},
	{
		label: "two arms bounded unequally, the weaker first",
		q: counter(
			"Both",
			[
				step((r, hops) => r.lt(hops, 4), "backward", plusOne),
				step((r, hops) => r.lt(hops, 2), "forward", plusOne)
			],
			[0]
		)
	},
	{
		label: "between 0 and 3",
		q: counter("Between", [step((r, hops) => r.between(hops, 0, 3), "forward", plusOne)], [0])
	},
	{
		label: "4 > hops",
		q: counter(
			"Swapped",
			[step((r, hops) => r.gt(Compute.literal(pg.integer, 4), hops), "forward", plusOne)],
			[0]
		)
	},
	{
		label: "a countdown from 3 while hops >= 1",
		q: counter("Countdown", [step((r, hops) => r.ge(hops, 1), "forward", minusOne)], [3])
	},
	{
		label: "a countdown from 3 while 1 <= hops",
		q: counter(
			"Countdown",
			[step((r, hops) => r.le(Compute.literal(pg.integer, 1), hops), "forward", minusOne)],
			[3]
		)
	},
	{
		label: "a countdown from 3 while 0 < hops",
		q: counter(
			"Countdown",
			[step((r, hops) => r.lt(Compute.literal(pg.integer, 0), hops), "forward", minusOne)],
			[3]
		)
	},
	{
		label: "a step of 2 from 0 and 2 while hops < 6",
		q: counter("Strides", [step((r, hops) => r.lt(hops, 6), "forward", plusTwo)], [0, 2])
	}
]

/** A counter with its oracle case. */
interface CounterCase extends Counter {
	readonly oracle: LabelledCase
}

const counterCases = Arr.map(counters, (c): CounterCase => ({
	...c,
	oracle: caseOf(c.label, c.q, { start: vertexId(0) })
}))

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
					return yield* exhaust(
						{
							suite: "recursion/lowering/counters",
							generator: element(counterCases),
							literal: (c: CounterCase) => c.label,
							limit: counterCases.length,
							coverage: requiredInSpace<AgreedFeature>(
								Arr.map(counterCases, (c): AgreedFeature => `agreed: ${c.label}`)
							),
							caseHang
						},
						(c, k) =>
							Effect.gen(function* () {
								const u = lowerCase(c.oracle, names)
								if (!u.ok) {
									throw new Error(`${c.label}: ${u.error.message}`)
								}
								const statement = flight(u.value.roots)[0]
								assert.equal(featureCount(shapeOf(statement.ast), "with recursive"), 1, c.label)
								const name = yield* s.schema({ create: false, label: "counters" })
								const outcome = yield* runLabelledOracle(c.oracle, optimized, reference, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(outcome.comparison.equal, true, printOutcome(outcome))
								assert.equal(outcome.comparison.leftDuplicates, 0, printOutcome(outcome))
								const against = yield* runLabelledOracle(c.oracle, optimized, conservative, {
									...defaultRunOptions,
									schema: { kind: "named", name: name }
								})
								assert.equal(against.comparison.equal, true, printOutcome(against))
								k.note(`agreed: ${c.label}`)
							})
					)
				})
			)
	)
})
