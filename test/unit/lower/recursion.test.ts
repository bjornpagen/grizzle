import { describe, it } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { boolean, element, filter, type Gen, int, oneOf, subarray } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Effect, Formatter, Order } from "effect"
import { checkQuery } from "#compiler/check/index.ts"
import { BudgetMeter } from "#compiler/core/budget.ts"
import { catchRefusal } from "#compiler/core/canonical.ts"
import { compileBudgets, recursionUnrollMax } from "#compiler/core/policy.ts"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { LogicalQuery } from "#compiler/ir/products.ts"
import { conservativeMeta, type NodeOf } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { emptyEnv, LowerContext } from "#compiler/lower/conservative/context.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { emptyCtePlan } from "#compiler/lower/optimize/cte-policy/index.ts"
import type { OptimizedProgram } from "#compiler/lower/optimize/index.ts"
import { optimizedDispatch, ShapeState } from "#compiler/lower/shapes/index.ts"
import {
	type CounterAnalysis,
	counterBound,
	recursionLowerer
} from "#compiler/lower/shapes/recursion/index.ts"
import type { RelationInput } from "#compiler/lower/shapes/take/index.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, type Rule, type SelfSource, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { queryValueDesc } from "#compiler/query/build/index.ts"
import type { Cte, Expr, Select, SelectBody, SelectCore } from "#compiler/sql/ast.ts"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import { lowerAligned } from "#test/support/compile.ts"
import { ownedSchemaFixture } from "#test/support/evidence.ts"
import { localVectorSchema, productionNames } from "#test/support/kernel/naming.ts"
import { checking, checkOptions } from "#test/support/policy.ts"
import { heading } from "#test/unit/ir/fixture.ts"
import { Edge as EdgeSpec, Q, T } from "#test/unit/lower/conservative/fixtures.ts"
import { conservativeShapeFacts } from "#test/unit/lower/shapes/support.ts"
import { nodeOfKind, present } from "#test/unit/lower/support.ts"

/**
 * The optimized recursive lowering's proof of an iteration bound (lower/shapes/recursion/bound.ts) and the form it
 * chooses (lower/shapes/recursion/index.ts), against the rule their headers state:
 *
 * - a bounded counter c: every seed fixes c to an integer literal (the set S), every row the step produces sets c to
 *   the current c plus one nonzero literal k, and a top-level conjunct bounds the current c by a literal L on the side
 *   it moves towards; then N = max over s in S of (s <= L ? floor((L - s) / k) + 1 : 0) for k > 0, and the mirror for
 *   k < 0, and a union of arms is bounded by its weakest arm's guard;
 * - no bound on that side proves nothing (noLiteralBound), nor do arms advancing by different steps (noCounter), a seed
 *   read from data (unboundedSeeds), another expression of the step that can fail (failingExpression), or a value
 *   s + j·k, j up to N, outside the counter's carrier for some seed (counterOverflow);
 * - the recursion unrolls when N is at most recursionUnrollMax (core/policy.ts), and keeps the recursive CTE
 *   otherwise: its feedback under UNION and no DISTINCT anywhere, the complete final state needing none; a recursion
 *   realized without its UNION is refused in either form.
 *
 * The model the proofs are checked against reads no IR: it evaluates each guard as the comparison it states, finds the
 * last value the guard admits in the direction the counter moves, and counts each seed's advances one step at a time.
 */

type Comparison = "lt" | "le" | "eq" | "ge" | "gt"

/** A guard on the current counter: a comparison with a literal, the counter on either side, or a between. */
type Guard =
	| {
			readonly kind: "compare"
			readonly op: Comparison
			readonly counter: "left" | "right"
			readonly bound: bigint
	  }
	| { readonly kind: "between"; readonly low: bigint; readonly high: bigint }

const compared = (op: Comparison, a: bigint, b: bigint): boolean =>
	op === "lt" ? a < b : op === "le" ? a <= b : op === "eq" ? a === b : op === "ge" ? a >= b : a > b

/** Whether the guard admits the current value v. */
const admits = (guard: Guard, value: bigint): boolean =>
	guard.kind === "between"
		? guard.low <= value && value <= guard.high
		: guard.counter === "left"
			? compared(guard.op, value, guard.bound)
			: compared(guard.op, guard.bound, value)

/** The guards' literals lie well inside it. */
const reach = 64n

/**
 * The last current value some guard admits in the direction the counter moves (any of several arms advances it), or
 * none when they admit values as far as the window reaches on that side.
 */
const lastAdmitted = (guards: ReadonlyArray<Guard>, delta: bigint): bigint | "none" => {
	const direction = delta > 0n ? 1n : -1n
	const any = (value: bigint) => Arr.some(guards, (g) => admits(g, value))
	if (any(direction * reach)) {
		return "none"
	}
	for (let value = direction * reach; value !== -direction * reach; value -= direction) {
		if (any(value)) {
			return value
		}
	}
	return "none"
}

/** How many times the counter advances from seed s before it passes the limit, one step at a time. */
const advances = (seed: bigint, delta: bigint, limit: bigint): bigint => {
	let n = 0n
	for (let value = seed; delta > 0n ? value <= limit : value >= limit; value += delta) {
		n++
	}
	return n
}

type Carrier = "int2" | "int4" | "int8"

const ranges: Readonly<Record<Carrier, readonly [bigint, bigint]>> = {
	int2: [-(2n ** 15n), 2n ** 15n - 1n],
	int4: [-(2n ** 31n), 2n ** 31n - 1n],
	int8: [-(2n ** 63n), 2n ** 63n - 1n]
}

/** What the model proves of a counter over `carrier` seeded at `seeds`, advanced by `delta` under any of `guards`. */
const modelAnalysis = (
	carrier: Carrier,
	seeds: ReadonlyArray<bigint>,
	delta: bigint,
	guards: ReadonlyArray<Guard>
): CounterAnalysis => {
	const limit = lastAdmitted(guards, delta)
	if (limit === "none") {
		return { kind: "unbounded", reason: "noLiteralBound" }
	}
	const depth = Arr.reduce(seeds, 0n, (most, s) => {
		const n = advances(s, delta, limit)
		return n > most ? n : most
	})
	const [min, max] = ranges[carrier]
	for (const s of seeds) {
		for (let j = 0n; j <= depth; j++) {
			const value = s + j * delta
			if (value < min || value > max) {
				return { kind: "unbounded", reason: "counterOverflow" }
			}
		}
	}
	return {
		kind: "bounded",
		proof: {
			column: "hops",
			delta,
			limit,
			seeds: Arr.sort(seeds, Order.BigInt),
			depth: Number(depth)
		}
	}
}

/**
 * Counters stated in the IR, over every integer carrier: a planted sketch, since the checker admits only the guards on
 * the side a counter moves towards and states each carrier through its own typed field.
 */
const types: Readonly<Record<Carrier, ScalarType>> = { int2: T.int2, int4: T.int4, int8: T.int8 }
const betweenOp: Readonly<Record<Carrier, string>> = {
	int2: "between:smallint",
	int4: "between:integer",
	int8: "between:bigint"
}

interface Counter {
	readonly carrier: Carrier
	readonly seeds: ReadonlyArray<bigint>
	readonly delta: bigint
	readonly guard: Guard
}

/**
 * The closure over Edge from every source vertex, its state (node, hops): one base arm per seed fixing hops to it, and
 * a step from the current state to the next vertex under the guard, setting hops to hops + delta.
 */
const counterRecursion = (c: Counter) => {
	const q = new Q()
	const t = types[c.carrier]
	const state = heading(["node", T.int4], ["hops", t])
	const rec = q.b.reserve()
	const self = q.node({
		kind: "SelfRef",
		recursive: rec,
		heading: state,
		loc: undefined,
		meta: conservativeMeta
	})
	const arms = Arr.map(c.seeds, (s) =>
		q.project(
			q.region([
				{ source: q.base(EdgeSpec, conservativeMeta), bind: { src: "node" }, constants: {} }
			]),
			[
				["node", "node"],
				["hops", [q.int(s, t), t]]
			],
			conservativeMeta
		)
	)
	const base = arms.length === 1 ? present(arms[0], "a seed arm") : q.union(arms, [])
	const m = q.region([
		{ source: self, bind: { node: "node", hops: "hops" }, constants: {} },
		{
			source: q.base(EdgeSpec, conservativeMeta),
			bind: { src: "node", dst: "next" },
			constants: {}
		}
	])
	const hops = q.col(m, "hops")
	const g = c.guard
	const pred =
		g.kind === "between"
			? q.op(betweenOp[c.carrier], [hops, q.int(g.low, t), q.int(g.high, t)], T.bool, "total")
			: q.op(
					`${c.carrier}${g.op}`,
					g.counter === "left" ? [hops, q.int(g.bound, t)] : [q.int(g.bound, t), hops],
					T.bool,
					"total"
				)
	const f = q.filter(m, pred)
	const magnitude = c.delta > 0n ? c.delta : -c.delta
	const step = q.project(
		f,
		[
			["node", "next"],
			[
				"hops",
				[
					q.op(
						`${c.carrier}${c.delta > 0n ? "pl" : "mi"}`,
						[q.col(f, "hops"), q.int(magnitude, t)],
						t,
						"canFail"
					),
					t
				]
			]
		],
		conservativeMeta
	)
	const root = q.b.define(rec, {
		kind: "Recursive",
		name: "walks",
		base,
		step,
		self,
		termination: { kind: "finiteCarrier", stateEstimate: 100n, premises: [] },
		origin: [],
		heading: state,
		loc: undefined,
		meta: conservativeMeta
	})
	const built = q.build(root)
	return { dag: built.dag, rec: nodeOfKind(root, "Recursive") }
}

const comparisons: Arr.NonEmptyReadonlyArray<Comparison> = ["lt", "le", "eq", "ge", "gt"]

const guards: Gen<Guard> = oneOf<Guard>([
	(source) => ({
		kind: "compare",
		op: source.draw(element(comparisons)),
		counter: source.draw(element<"left" | "right">(["left", "right"])),
		bound: source.draw(element([0n, 3n]))
	}),
	element<Guard>([
		{ kind: "between", low: 0n, high: 3n },
		{ kind: "between", low: 1n, high: 9n }
	])
])

/**
 * Seeds near the guards' literals, and the carrier's extreme on the side the counter moves towards, from which it
 * never advances but whose steps over the other seeds' depth leave the carrier.
 */
const seedPool = (carrier: Carrier, delta: bigint): ReadonlyArray<bigint> => {
	const [min, max] = ranges[carrier]
	return delta > 0n ? [0n, 3n, max] : [min, 0n, 3n]
}

const counters: Gen<Counter> = (source) => {
	const carrier = source.draw(element<Carrier>(["int2", "int4", "int8"]))
	const delta = source.draw(element([1n, 2n, -1n, -2n]))
	const guard = source.draw(guards)
	const seeds = source.draw(
		filter(subarray(seedPool(carrier, delta)), (picked) => picked.length > 0, 1)
	)
	return { carrier, seeds, delta, guard }
}

type CounterFeature =
	| "bounded"
	| "no literal bound"
	| "counter overflow"
	| "a seed past its limit"
	| "depth 0"

/**
 * The graph schema of the public-API cases: a vertex relation with a carrier column a seed may copy, and edges with a
 * cost a step may divide by.
 */
const Vertex = relation("Vertex", { id: uuid, rank: pg.smallint }, ["id"])
const Edge = relation("Edge", { from: uuid, to: uuid, cost: pg.integer }, ["from", "to"])
const Graph = schema("Graph", { Vertex, Edge }, [
	contained(on(Edge, "from"), on(Vertex, "id")),
	contained(on(Edge, "to"), on(Vertex, "id"))
])

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

const proof = (q: unknown): CounterAnalysis => {
	const checked = admit(q)
	return counterBound(checked.dag, recursiveNode(checked))
}

/** The graph schema's own catalog, every key named as ownership installs it. */
const graphCatalog = ownedSchemaFixture(Graph).catalog

const names = productionNames("Graph", { kind: "declared" }, localVectorSchema)

const optimize = (q: LogicalQuery): OptimizedProgram =>
	succeeded(
		lowerAligned(q, "query", {
			names,
			meter: new BudgetMeter(compileBudgets),
			context: "snapshot",
			catalog: graphCatalog
		})
	)

/** Every query nested in a statement: the statement, its CTE bodies, derived tables and subquery expressions. */
const queries = (s: Select): ReadonlyArray<Select> => {
	const out: Array<Select> = []
	const visitSelect = (q: Select): void => {
		out.push(q)
		for (const cte of q.with?.ctes ?? []) {
			if (cte.query.kind === "select") {
				visitSelect(cte.query)
			}
		}
		visitBody(q.body)
	}
	const visitBody = (b: SelectBody): void => {
		if (b.kind === "select") {
			visitSelect(b)
			return
		}
		if (b.kind === "setOp") {
			visitBody(b.left)
			visitBody(b.right)
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
		} else if (f.kind === "join" || f.kind === "crossJoin") {
			visitFrom(f.left)
			visitFrom(f.right)
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

const mainAst = (p: OptimizedProgram): Select => flight(p.roots)[0].ast

const recursiveCtes = (s: Select): ReadonlyArray<Cte> =>
	Arr.flatMap(queries(s), (q) => (q.with?.recursive === true ? q.with.ctes : []))

type WalkSelf = SelfSource<{ readonly node: typeof uuid; readonly hops: typeof pg.integer }>

/** The walk from a parameter root, one hop at a time from hops 0 while hops is below `below`. */
const walkBelow = (below: number) =>
	query(Graph).recursive("Walks", {
		row: { node: uuid, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Vertex)
				return r
					.match(Vertex, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ node: id, hops: Compute.literal(pg.integer, 0) })
			}
		],
		rec: [
			(r, self) => {
				const { node, hops } = v(self)
				const { to } = v(Edge)
				return r
					.match(self, { node, hops })
					.match(Edge, { from: node, to })
					.where(r.lt(hops, below))
					.find({ node: to, hops: Compute.add(hops, Compute.literal(pg.integer, 1)) })
			}
		]
	})

/**
 * Two transition arms, forward and backward along Edge, each advancing hops by its own step under its own literal bound
 * on the current hops: the checker factors them into one feedback scan.
 */
interface Arm {
	readonly bound: number
	readonly step: number
}

const twoArms = (forward: Arm, backward: Arm, backwardFirst: boolean) => {
	const arm = (isForward: boolean, a: Arm) => (r: Rule<typeof Graph>, self: WalkSelf) => {
		const { node, hops } = v(self)
		const { from, to } = v(Edge)
		return r
			.match(self, { node, hops })
			.match(Edge, isForward ? { from: node, to } : { from, to: node })
			.where(r.lt(hops, a.bound))
			.find({
				node: isForward ? to : from,
				hops: Compute.add(hops, Compute.literal(pg.integer, a.step))
			})
	}
	const arms = [arm(true, forward), arm(false, backward)]
	return query(Graph).recursive("Both", {
		row: { node: uuid, hops: pg.integer },
		base: [
			(r) => {
				const { id } = v(Vertex)
				return r
					.match(Vertex, { id })
					.where(r.eq(id, r.param("start", uuid)))
					.find({ node: id, hops: Compute.literal(pg.integer, 0) })
			}
		],
		rec: backwardFirst ? Arr.reverse(arms) : arms
	})
}

/**
 * The recursions no counter bounds, each planted with the reason the rule gives: the rule is about where the counter
 * comes from, which no generated recursion varies.
 */
type Unbounded = "noCounter" | "unboundedSeeds" | "noLiteralBound" | "failingExpression"
const unboundedFamilies: Readonly<Record<Unbounded, () => unknown>> = {
	/** An endpoint closure: no integer state column. */
	noCounter: () =>
		query(Graph).recursive("Reach", {
			row: { node: uuid },
			base: [
				(r) => {
					const { id } = v(Vertex)
					return r
						.match(Vertex, { id })
						.where(r.eq(id, r.param("start", uuid)))
						.find({ node: id })
				}
			],
			rec: [
				(r, self) => {
					const { node } = v(self)
					const { to } = v(Edge)
					return r.match(self, { node }).match(Edge, { from: node, to }).find({ node: to })
				}
			]
		}),
	/** The counter starts at each root's stored rank. */
	unboundedSeeds: () =>
		query(Graph).recursive("Seeded", {
			row: { node: uuid, hops: pg.smallint },
			base: [
				(r) => {
					const { id, rank } = v(Vertex)
					return r
						.match(Vertex, { id, rank })
						.where(r.eq(id, r.param("start", uuid)))
						.find({ node: id, hops: rank })
				}
			],
			rec: [
				(r, self) => {
					const { node, hops } = v(self)
					const { to } = v(Edge)
					return r
						.match(self, { node, hops })
						.match(Edge, { from: node, to })
						.where(r.lt(hops, 4))
						.find({ node: to, hops: Compute.add(hops, Compute.literal(pg.smallint, 1)) })
				}
			]
		}),
	/** The bound is a parameter: a smallint counter, whose carrier extreme keeps the seen-state estimate admitted. */
	noLiteralBound: () =>
		query(Graph).recursive("Walks", {
			row: { node: uuid, hops: pg.smallint },
			base: [
				(r) => {
					const { id } = v(Vertex)
					return r
						.match(Vertex, { id })
						.where(r.eq(id, r.param("start", uuid)))
						.find({ node: id, hops: Compute.literal(pg.smallint, 0) })
				}
			],
			rec: [
				(r, self) => {
					const { node, hops } = v(self)
					const { to } = v(Edge)
					return r
						.match(self, { node, hops })
						.match(Edge, { from: node, to })
						.where(r.lt(hops, r.param("limit", pg.smallint)))
						.find({ node: to, hops: Compute.add(hops, Compute.literal(pg.smallint, 1)) })
				}
			]
		}),
	/** The step divides by an edge's cost, which an inlined level could evaluate on a row an earlier level removed. */
	failingExpression: () =>
		query(Graph).recursive("Dividing", {
			row: { node: uuid, hops: pg.integer },
			base: [
				(r) => {
					const { id } = v(Vertex)
					return r
						.match(Vertex, { id })
						.where(r.eq(id, r.param("start", uuid)))
						.find({ node: id, hops: Compute.literal(pg.integer, 0) })
				}
			],
			rec: [
				(r, self) => {
					const { node, hops } = v(self)
					const { to, cost } = v(Edge)
					return r
						.match(self, { node, hops })
						.match(Edge, { from: node, to, cost })
						.where(r.lt(hops, 4))
						.where(r.gt(Compute.div(Compute.literal(pg.integer, 100), cost), 1))
						.find({ node: to, hops: Compute.add(hops, Compute.literal(pg.integer, 1)) })
				}
			]
		})
}

const below = (bound: number): Guard => ({
	kind: "compare",
	op: "lt",
	counter: "left",
	bound: BigInt(bound)
})

describe("the bounded-counter proof (packages/engine/src/lower/shapes/recursion/bound.ts)", () => {
	it.effect(
		"proves the model's depth, limit and seeds for every counter, or the model's reason for none",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/recursion/counter",
						generator: counters,
						literal: Formatter.format,
						limit: 2000,
						features: features<CounterFeature>([
							"bounded",
							"no literal bound",
							"counter overflow",
							"a seed past its limit",
							"depth 0"
						]),
						caseHang: Duration.minutes(2)
					},
					(c, note) =>
						Effect.sync(() => {
							const { dag, rec } = counterRecursion(c)
							const expected = modelAnalysis(c.carrier, c.seeds, c.delta, [c.guard])
							assert.deepEqual(counterBound(dag, rec), expected)
							if (expected.kind === "bounded") {
								note.note("bounded")
								if (expected.proof.depth === 0) {
									note.note("depth 0")
								} else if (
									Arr.some(c.seeds, (s) => advances(s, c.delta, expected.proof.limit) === 0n)
								) {
									note.note("a seed past its limit")
								}
							} else {
								note.note(
									expected.reason === "noLiteralBound" ? "no literal bound" : "counter overflow"
								)
							}
						})
				)
			)
	)

	it.effect(
		"bounds the arms the checker factors into one feedback scan by the weakest guard, when they step alike",
		(ctx) => {
			const arms: Gen<Arm> = (source) => ({
				bound: source.draw(int(2, 4)),
				step: source.draw(int(1, 2))
			})
			return searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/recursion/two-arms",
						generator: (source) =>
							[source.draw(arms), source.draw(arms), source.draw(boolean)] as const,
						literal: Formatter.format,
						limit: 72,
						features: features<"bounded" | "different steps">(["bounded", "different steps"]),
						caseHang: Duration.minutes(2)
					},
					([forward, backward, backwardFirst], c) =>
						Effect.sync(() => {
							const got = proof(twoArms(forward, backward, backwardFirst))
							if (forward.step !== backward.step) {
								assert.deepEqual(got, { kind: "unbounded", reason: "noCounter" })
								c.note("different steps")
								return
							}
							assert.deepEqual(
								got,
								modelAnalysis("int4", [0n], BigInt(forward.step), [
									below(forward.bound),
									below(backward.bound)
								])
							)
							c.note("bounded")
						})
				)
			)
		}
	)

	it.effect(
		"proves no bound where the counter's seed, bound or step is not a literal, and keeps the recursive CTE",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/recursion/unbounded",
						generator: element<Unbounded>([
							"noCounter",
							"unboundedSeeds",
							"noLiteralBound",
							"failingExpression"
						]),
						literal: Formatter.format,
						limit: 4,
						features: features<Unbounded>([
							"noCounter",
							"unboundedSeeds",
							"noLiteralBound",
							"failingExpression"
						]),
						caseHang: Duration.minutes(2)
					},
					(reason, c) =>
						Effect.sync(() => {
							const q = admit(unboundedFamilies[reason]())
							assert.deepEqual(counterBound(q.dag, recursiveNode(q)), { kind: "unbounded", reason })
							assert.equal(recursiveCtes(mainAst(optimize(q))).length, 1, reason)
							c.note(reason)
						})
				)
			)
	)
})

describe("the form a recursion lowers to (packages/engine/src/lower/shapes/recursion/index.ts)", () => {
	it.effect(
		"unrolls a proved depth within recursionUnrollMax, keeps the UNION recursive CTE beyond it, and refuses a plain realization",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "unit/lower/recursion/form",
						/** Walks whose proved depth lies below, at and above recursionUnrollMax. */
						generator: int(0, recursionUnrollMax + 2),
						literal: Formatter.format,
						limit: recursionUnrollMax + 3,
						features: features<"unrolled" | "recursive">(["unrolled", "recursive"]),
						caseHang: Duration.minutes(2)
					},
					(below, c) =>
						Effect.sync(() => {
							const q = admit(walkBelow(below))
							const rec = recursiveNode(q)
							const depth = Number(advances(0n, 1n, BigInt(below) - 1n))
							const ast = mainAst(optimize(q))
							const ctes = recursiveCtes(ast)
							if (depth <= recursionUnrollMax) {
								assert.equal(ctes.length, 0)
								c.note("unrolled")
							} else {
								const [cte] = ctes
								assert.equal(ctes.length, 1)
								const body = present(cte, "the recursive CTE").query
								assert.ok(
									body.kind === "select" && body.body.kind === "setOp" && body.body.op === "UNION"
								)
								assert.equal(
									Arr.some(
										queries(ast),
										(x) => x.body.kind === "core" && x.body.distinct !== false
									),
									false
								)
								c.note("recursive")
							}
							/** A recursion realized without its UNION, whichever form it lowers to. */
							const facts = conservativeShapeFacts({
								realization: (node) => (node.id === rec.id ? "plain" : "distinct")
							})
							const cx = new LowerContext(
								q.dag,
								{
									names,
									params: q.params,
									subject: { kind: "query" },
									meter: new BudgetMeter(compileBudgets)
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
