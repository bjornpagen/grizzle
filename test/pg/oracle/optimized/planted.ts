import type { Kept } from "@grizzle/testing/explore"
import { Array as Arr, Record as Rec } from "effect"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import {
	type CompletedOrder,
	conservativeMeta,
	type Heading,
	type RelNode,
	type TakeBound
} from "#compiler/ir/rel.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import type { OptimizedFeature } from "#test/pg/oracle/optimized/suite.ts"
import { publicCase } from "#test/pg/recursion/graph/support.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { bool, int4, spellingChoiceCount } from "#test/support/oracle/gen/domain.ts"
import { aggregateOpId, aggregateResult, compareOpId } from "#test/support/oracle/gen/ops.ts"
import { type GenParam, normalQuery } from "#test/support/oracle/gen/query.ts"
import {
	defaultRecursiveLimits,
	firstGraphSketch,
	firstRecursionSketch,
	resolveRecursiveCase
} from "#test/support/oracle/gen/recursive.ts"
import { type GenRelation, type GenSchema, schemaName } from "#test/support/oracle/gen/schema.ts"
import { Q, type RelationSpec } from "#test/unit/lower/conservative/fixtures.ts"

const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })

/** R0 and R1 (k, a, b), keyed by k, each holding the same four facts: a repeats, so a group by a merges rows. */
const stored = (name: string): GenRelation => ({
	name,
	columns: Arr.map(["k", "a", "b"], (c) => ({ name: c, type: int4 })),
	primaryKey: ["k"],
	keys: [],
	mutable: false
})
const R0 = stored("R0")
const R1 = stored("R1")
const specOf = (r: GenRelation): RelationSpec => ({
	name: r.name,
	heading: Arr.map(r.columns, (c) => ({ name: c.name, type: c.type })),
	primaryKey: r.primaryKey
})

const facts: ReadonlyArray<ReadonlyArray<TypedLiteral>> = Arr.map(
	[
		[1, 1, 10],
		[2, 1, 20],
		[3, 2, 30],
		[4, 3, 30]
	],
	(row) => Arr.map(row, int)
)

/** The case of a query over R0, or R0 and R1, with its relation parameters' rows, built by `build`. */
const storedCase = (
	relations: ReadonlyArray<GenRelation>,
	params: Readonly<Record<string, GenParam>>,
	build: (q: Q) => RelNode
): QueryCase => {
	const q = new Q()
	const root = build(q)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	const s: GenSchema = { name: schemaName, relations, closed: [], containments: [] }
	return {
		schema: s,
		facts: Rec.fromEntries(Arr.map(relations, (r) => [r.name, facts])),
		query: { dag, params },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
}

/** `c` with every node's logical metadata computed, as production annotates a query before it is optimized. */
const annotated = (c: QueryCase): QueryCase => {
	const analysis = analyzeLogical(c.query.dag, checkerEvidence)
	if (!analysis.ok) {
		throw new Error(`a planted query: ${analysis.error.message}`)
	}
	return { ...c, query: { ...c.query, dag: analysis.value.dag } }
}

/** The predicate that two integer expressions are equal. */
const equal = (q: Q, left: ScalarExpr, right: ScalarExpr): ScalarExpr =>
	q.op(compareOpId(int4, "eq"), [left, right], bool, "total")

/** The rows of `input` whose integer column equals `value`. */
const where = (q: Q, input: RelNode, column: string, value: number): RelNode =>
	q.filter(input, equal(q, q.col(input, column), q.int(value, int4)))

const base = (q: Q, r: GenRelation) => q.base(specOf(r), conservativeMeta)

/** R0 grouped by a, each group counted as n. */
const counted = (q: Q) =>
	q.group(
		base(q, R0),
		["k", "a", "b"],
		["a"],
		[
			{
				name: "n",
				fn: "count",
				op: aggregateOpId("count", undefined),
				args: [],
				type: aggregateResult("count", undefined)
			}
		],
		conservativeMeta
	)

/** `input` read through a region binding each of `columns` to a variable of its name. */
const bound = (q: Q, input: RelNode, columns: ReadonlyArray<string>): RelNode =>
	q.region([
		{ source: input, bind: Rec.fromEntries(Arr.map(columns, (c) => [c, c])), constants: {} }
	])

/** The first k facts of R0 by b, ties by k, for each id of the relation parameter `ids`, bound to the id by a. */
const firstPer = (q: Q, k: number) => {
	const ids: Heading = [{ name: "id", type: int4 }]
	const order: CompletedOrder = {
		keys: [
			{ column: "b", dir: "asc" },
			{ column: "k", dir: "asc" }
		]
	}
	const takeBound: TakeBound = { kind: "literal", k: BigInt(k) }
	const outer = q.b.reserve()
	const parent = q.b.expr({
		kind: "column",
		column: { node: outer, name: "id" },
		args: [],
		type: int4,
		nonNull: "storage"
	})
	const entries = bound(q, base(q, R0), ["k", "a", "b"])
	const first = q.take(entries, order, takeBound, [{ column: "a", expr: parent }], conservativeMeta)
	return q.regionWith(
		[
			{ source: q.input("ids", ids), bind: { id: "id" }, constants: {} },
			{ source: first, bind: { k: "k", a: "id", b: "b" }, constants: {} }
		],
		{
			heading: { kind: "bound" },
			id: { kind: "reserved", id: outer },
			correlated: [],
			equalities: []
		}
	)
}

/**
 * R0's facts, each with the first three facts of R0 x R0 whose second a is its a, taken under a filter that is always
 * false: branch removal empties the correlated take into the empty relation. Six columns are more than a fused
 * attachment carries (core/policy.ts attachFuseMaxFields), so the child is a statement of its own.
 */
const emptiedChild = (q: Q): RelNode => {
	const parent = bound(q, base(q, R0), ["k", "a", "b"])
	const pairs = q.region([
		{ source: base(q, R0), bind: { k: "k", a: "a", b: "b" }, constants: {} },
		{ source: base(q, R0), bind: { k: "k_2", a: "a_2", b: "b_2" }, constants: {} }
	])
	const never = q.filter(pairs, q.lit({ kind: "bool", value: false }, bool))
	const order: CompletedOrder = {
		keys: Arr.map(["k", "a", "b", "k_2", "a_2", "b_2"], (column) => ({ column, dir: "asc" }))
	}
	const takeBound: TakeBound = { kind: "literal", k: 3n }
	const child = q.take(
		never,
		order,
		takeBound,
		[{ column: "a_2", expr: q.col(parent, "a") }],
		conservativeMeta
	)
	return q.attach(parent, child, "pairs", [["a", "a_2"]], "array", undefined)
}

const idsParam: Readonly<Record<string, GenParam>> = {
	ids: {
		kind: "relation",
		heading: [{ name: "id", type: int4 }],
		rows: [[int(1)], [int(2)], [int(5)]]
	}
}

/**
 * A closure over a graph of five vertices, the origin of each walk carried: every vertex one or more steps from each.
 */
const V = relation("V", { id: pg.integer }, ["id"])
const E = relation("E", { from: pg.integer, to: pg.integer }, ["from", "to"])
const Net = schema("Net", { V, E }, [
	contained(on(E, "from"), on(V, "id")),
	contained(on(E, "to"), on(V, "id"))
])

const Closure = query(Net).recursive("Closure", {
	row: { origin: pg.integer, node: pg.integer },
	base: [
		(r) => {
			const { from, to } = v(E)
			return r.match(E, { from, to }).find({ origin: from, node: to })
		}
	],
	rec: [
		(r, self) => {
			const { origin, node } = v(self)
			const { to } = v(E)
			return r.match(self, { origin, node }).match(E, { from: node, to }).find({ origin, node: to })
		}
	]
})

const netCase = (label: string, q: unknown): QueryCase =>
	publicCase({
		schema: Net,
		name: "Net",
		relations: ["V", "E"],
		containments: [
			{ from: { relation: "E", fields: ["from"] }, to: { relation: "V", fields: ["id"] } },
			{ from: { relation: "E", fields: ["to"] }, to: { relation: "V", fields: ["id"] } }
		],
		facts: {
			V: Arr.map([0, 1, 2, 3, 4], (i) => [int(i)]),
			E: Arr.map(
				[
					[0, 1],
					[1, 2],
					[2, 3],
					[2, 0],
					[3, 4]
				],
				(edge) => Arr.map(edge, int)
			)
		},
		label,
		query: q,
		params: {}
	})

const planted = (
	note: string,
	reaches: Kept<QueryCase, OptimizedFeature>["reaches"],
	sketch: QueryCase
): Kept<QueryCase, OptimizedFeature> => ({ note, sketch, draws: "", reaches })

/**
 * The rewrite families the optimizer's population reaches too rarely to leave to it, planted as kept cases.
 *
 * Each rule fires on one shape: a filter directly over a group with keys (pushdown.group), a union (pushdown.union), a
 * projection (pushdown.project) or a filter (simplify.mergeFilters); a filter over a region whose occurrence reads a
 * group (pushdown.source), or comparing two of its variables (simplify.equality); a semi-join on a group's key over a
 * region reading the group (pushdown.semiSource onto the group's occurrence, then pushdown.semiGroup below the group,
 * the shape of the platform's nearCap, which the population's semiOver form reaches too); a folding stage two readers
 * share (cte.materialized); a take of the first rows per fact of a relation parameter (R20.lateral, and R20.distinctOn or
 * R20.rowNumber for the whole-relation variant); and a closure filtered on, fixed at, or matched on its origin
 * (graph.seedPushdown.filter, .constant and .region). Compiled over the optimizer's population (gen/case.ts
 * optimizerGenConfig), a part's cases fire each of these a few to a dozen times, some parts never. So each is a
 * hand-built query over stored relations of a few facts, which every part replays before its streams (runner.ts
 * oracleCheck).
 *
 * One more is planted for a shape the generated population reaches about once in 12,500 cases: an attachment's
 * correlated child that branch removal empties (simplify.empty), sent as a pipelined statement whose share key reads the
 * child alone. It carries the logical metadata production compiles it with (logical/annotate.ts), the correlated
 * child's free variable included.
 */
export const plantedRewrites: ReadonlyArray<Kept<QueryCase, OptimizedFeature>> = [
	planted(
		"a filter on a group's key over the group",
		["pushdown.group"],
		storedCase([R0], {}, (q) => where(q, counted(q), "a", 1))
	),
	planted(
		"a filter over a union of two stored relations",
		["pushdown.union"],
		storedCase([R0, R1], {}, (q) => where(q, q.union([base(q, R0), base(q, R1)], []), "a", 1))
	),
	planted(
		"a filter over a projection",
		["pushdown.project"],
		storedCase([R0], {}, (q) => {
			const projected: ReadonlyArray<readonly [string, string]> = [
				["k", "k"],
				["a", "a"]
			]
			return where(q, q.project(base(q, R0), projected, conservativeMeta), "a", 1)
		})
	),
	planted(
		"a filter over a filter",
		["simplify.mergeFilters"],
		storedCase([R0], {}, (q) => where(q, where(q, base(q, R0), "a", 1), "b", 10))
	),
	planted(
		"a filter over a region reading a group",
		["pushdown.source"],
		storedCase([R0], {}, (q) => where(q, bound(q, counted(q), ["a", "n"]), "a", 1))
	),
	planted(
		"a semi-join on a group's key over a region reading the group",
		["pushdown.semiSource", "pushdown.semiGroup"],
		storedCase([R0, R1], {}, (q) =>
			q.semi(bound(q, counted(q), ["a", "n"]), where(q, base(q, R1), "b", 10), [["a", "a"]])
		)
	),
	planted(
		"a filter equating two variables of a region",
		["simplify.equality"],
		storedCase([R0], {}, (q) => {
			const r = bound(q, base(q, R0), ["k", "a", "b"])
			return q.filter(r, equal(q, q.col(r, "k"), q.col(r, "a")))
		})
	),
	planted(
		"a union of two filters over one group",
		["cte.materialized"],
		storedCase([R0], {}, (q) => {
			const g = counted(q)
			return q.union([where(q, g, "a", 1), where(q, g, "a", 2)], [])
		})
	),
	planted(
		"the first fact per id of a relation parameter",
		["R20.lateral", "R20.distinctOn"],
		storedCase([R0], idsParam, (q) => firstPer(q, 1))
	),
	planted(
		"the first two facts per id of a relation parameter",
		["R20.rowNumber"],
		storedCase([R0], idsParam, (q) => firstPer(q, 2))
	),
	planted(
		"a closure filtered on its origin",
		["graph.seedPushdown.filter"],
		resolveRecursiveCase(
			{
				graph: firstGraphSketch,
				recursion: {
					...firstRecursionSketch,
					consumer: defaultRecursiveLimits.consumers.indexOf("originFilter")
				},
				spelling: Array.from({ length: spellingChoiceCount }, () => 0)
			},
			defaultRecursiveLimits,
			"unmutated"
		)
	),
	planted(
		"a closure matched with its origin fixed",
		["graph.seedPushdown.constant"],
		netCase(
			"constant",
			query(Net).rule((r) => {
				const { node } = v(Closure)
				return r.match(Closure, { origin: 2, node }).find({ node })
			})
		)
	),
	planted(
		"an attachment's correlated child emptied by branch removal",
		["simplify.empty", "pipelined attachment"],
		annotated(storedCase([R0], {}, emptiedChild))
	),
	planted(
		"a closure matched with a condition on its origin",
		["graph.seedPushdown.region"],
		netCase(
			"region",
			query(Net).rule((r) => {
				const { origin, node } = v(Closure)
				return r.match(Closure, { origin, node }).where(r.eq(origin, 2)).find({ node })
			})
		)
	)
]
