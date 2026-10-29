/**
 * Failing computed terms inside attachments, conservative and optimized against the reference evaluator on PostgreSQL
 * 19, judged as "error or rows" (support.ts).
 *
 * Every root delivers attachments: one or two children, each a query with computed terms that can fail (integer
 * overflow, division by zero, a NaN cast to an integer, a negative square root) over the small domains, with a take per
 * parent key and one level of nesting where the sketch draws them. Half the children are a query of their own and half
 * repeat the parent's body, so their rows correlate with the parent's keys wherever the correlation pairs a column with
 * itself. Half the children end in a division by zero (finish.ts) that a projection keeping every column delivers or a
 * filter compares, so on a child row that correlates with a delivered parent key the attachment's statement must
 * raise: a lowering that delivers the parent and its children there, or raises a SQLSTATE no expression of the query
 * can raise, or delivers other rows than the definition's, disagrees. Each attachment runs as the lowering delivers
 * it, a statement of its own fed the parent keys its parent statement delivered, or fused into its parent's statement
 * and unfused for the comparison. Bodies are two operators deep, the children one, so parents deliver rows often
 * enough.
 */
import { layer } from "@effect/vitest"
import { type Draw, type Kept, sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, boolean, constant, type Gen, map } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter } from "effect"
import { DecimalText } from "#compiler/ir/decimal.ts"
import type { ScalarExpr, TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { finished, finishGen, keeping, type PlainFinish } from "#test/pg/oracle/frontier/finish.ts"
import { exploreFrontier, type FrontierFeature } from "#test/pg/oracle/frontier/support.ts"
import { succeeded } from "#test/support/assert.ts"
import {
	defaultGenConfig,
	type GenConfig,
	type QueryCase,
	queryCaseSketchGen,
	resolveQueryCase
} from "#test/support/oracle/gen/case.ts"
import { bool, float8, int4, int8, numeric, scalarOfSpec } from "#test/support/oracle/gen/domain.ts"
import { compareOpId } from "#test/support/oracle/gen/ops.ts"
import { normalQuery, queryGenerators, type RootSketch } from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName } from "#test/support/oracle/gen/schema.ts"
import { rootedCaseGen } from "#test/support/oracle/mutants/cases.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

const cases = 600

const roots = { plain: 0, attach: 1, hetero: 0 }
const config: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		compute: 6,
		maxDepth: 2,
		roots: { ...defaultGenConfig.query.roots, ...roots }
	}
}

/**
 * The dense population also draws the edge values (gen/domain.ts edgeClasses): integer and money bounds, float
 * subnormals and ±MAX, wide numerics.
 */
const edgeConfig: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		compute: 6,
		maxDepth: 2,
		roots: { ...defaultGenConfig.query.roots, ...roots }
	},
	edge: true
}

type AttachRoot = Extract<RootSketch, { readonly tag: "attach" }>

/** How each child is drawn: its own query or the parent's body, and how it ends. */
interface ChildDraw {
	readonly own: boolean
	readonly finish: PlainFinish
}

const drawsGen: Gen<ReadonlyArray<ChildDraw>> = array(
	(source) => ({ own: source.draw(boolean), finish: source.draw(finishGen) }),
	{ min: 2, max: 2 }
)

const drawnChildren = (root: RootSketch, draws: ReadonlyArray<ChildDraw>): RootSketch =>
	root.tag !== "attach"
		? root
		: {
				...root,
				children: Arr.map(root.children, (a, i): AttachRoot["children"][number] => {
					const draw = draws[i] ?? { own: true, finish: { form: "none" } }
					return { ...a, child: finished(draw.own ? a.child : root.body, draw.finish) }
				})
			}

const attachGen = (c: GenConfig): Gen<QueryCase> => {
	const sketchGen = queryCaseSketchGen(c)
	return (source) => {
		const sketch = source.draw(sketchGen)
		const draws = source.draw(drawsGen)
		return source.draw(
			resolveQueryCase(
				{
					...sketch,
					root: drawnChildren(sketch.root, draws),
					/** The root form, computed terms and the finishing forms are always on; the rest is the swarm's. */
					swarm: keeping(sketch.swarm, ["attach", "compute", "project", "filter"])
				},
				c
			)
		)
	}
}

/** The dense population draws no swarm: every feature is on in every case. */
const denseGen = (c: GenConfig): Gen<QueryCase> => {
	const root = queryGenerators(c.query).root
	return rootedCaseGen(
		map(
			(source) => ({ root: source.draw(root), draws: source.draw(drawsGen) }),
			({ root: drawnRoot, draws }) => drawnChildren(drawnRoot, draws)
		),
		c
	)
}

/**
 * A parent whose projection reads a failing column of the projection below it only in a CASE branch, planted: R0(a
 * bigint, b integer) keyed by a, holding a = -9223372036854775808, 1 and 2, the projection y1 = a, y2 = -a over it, and
 * above it y0 = CASE WHEN y1 <op> 0 THEN y2 ELSE -1 END, with R0's facts attached at y0 = a. -a overflows at the least
 * bigint, and the two projections compose (factoring invariance, reference/frontier.ts): where the branch is taken on
 * that row (y1 < 0) every lowering must raise; where it is never taken (y1 = 0) the answer needs no -a, so a lowering
 * may deliver rows, as the optimized one does once PostgreSQL pulls the lower projection up into the CASE, or raise, as
 * the conservative one does, computing every column of the lower projection's DISTINCT.
 */
const branchRead = (op: "eq" | "lt"): QueryCase => {
	const r0: GenRelation = {
		name: "R0",
		columns: [
			{ name: "a", type: int8 },
			{ name: "b", type: int4 }
		],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const base = () =>
		q.base({ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey }, conservativeMeta)
	const below = base()
	const lower = q.project(
		below,
		[
			["y1", "a"],
			["y2", [q.op("int8um", [q.col(below, "a")], int8, "canFail"), int8]]
		],
		conservativeMeta
	)
	const branch = q.b.expr({
		kind: "cond",
		args: [
			q.op(compareOpId(int8, op), [q.col(lower, "y1"), q.int(0, int8)], bool, "total"),
			q.col(lower, "y2"),
			q.int(-1, int8)
		],
		type: int8,
		nonNull: "cond"
	})
	const upper = q.project(lower, [["y0", [branch, int8]]], conservativeMeta)
	const root = q.attach(upper, base(), "att1", [["y0", "a"]], "array", undefined)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	const int = (value: bigint): TypedLiteral => ({ kind: "int", value })
	return {
		schema: { name: schemaName, relations: [r0], closed: [], containments: [] },
		facts: { R0: Arr.map([-9223372036854775808n, 1n, 2n], (a) => [int(a), int(1n)]) },
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
}

/**
 * A population of resolved cases, each the property's case as drawn: so its kept cases are cases, replayed by value.
 */
const resolvedDraw = (gen: Gen<QueryCase>): Draw<QueryCase, Gen<QueryCase>> =>
	sketched(gen, constant)

/** The plain population, each case resolved from its sketch, keeps both planted parents. */
const attachKept: ReadonlyArray<Kept<QueryCase, FrontierFeature>> = [
	{
		note: "y0 = CASE WHEN y1 = 0 THEN y2 ELSE -1 END over y1 = a, y2 = -a, a holding the least bigint",
		sketch: branchRead("eq"),
		draws: "",
		reaches: ["reference error", "may fail", "conservative error", "optimized rows"]
	},
	{
		note: "y0 = CASE WHEN y1 < 0 THEN y2 ELSE -1 END over y1 = a, y2 = -a, a holding the least bigint",
		sketch: branchRead("lt"),
		draws: "",
		reaches: ["forced failure", "conservative error", "optimized error"]
	}
]

const float = (value: number): TypedLiteral => ({ kind: "float", value })

/**
 * A fold over a bound column it reads nowhere else, planted for the dense population: R0(a double precision) keyed by
 * a, holding the least double, 0 and 1, the projection y0 = -a + (a + a), y1 = a over it, and the count of its distinct
 * (y0, y1), with the count of a second such fold attached at it. y1 is a key, so the input has one row per bound tuple,
 * but a + a overflows at the least double: the fold must still compute y0, which only its contributions' DISTINCT does
 * (dedup/place.ts); without it PostgreSQL drops y0 from the input and the count hides the failure.
 */
const unreadBound: QueryCase = (() => {
	const r0: GenRelation = {
		name: "R0",
		columns: [{ name: "a", type: float8 }],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const fold = () => {
		const below = q.base(
			{ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey },
			conservativeMeta
		)
		const a = () => q.col(below, "a")
		const doubled = q.op("float8pl", [a(), a()], float8, "canFail")
		const y0 = q.op(
			"float8pl",
			[q.op("float8um", [a()], float8, "total"), doubled],
			float8,
			"canFail"
		)
		const projected = q.project(
			below,
			[
				["y0", [y0, float8]],
				["y1", "a"]
			],
			conservativeMeta
		)
		return q.group(
			projected,
			["y0", "y1"],
			[],
			[{ name: "g0", fn: "count", op: "count", args: [], type: int8 }],
			conservativeMeta
		)
	}
	const root = q.attach(fold(), fold(), "att1", [["g0", "g0"]], "array", undefined)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	return {
		schema: { name: schemaName, relations: [r0], closed: [], containments: [] },
		facts: { R0: Arr.map([-Number.MAX_VALUE, 0, 1], (a) => [float(a)]) },
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
})()

/**
 * A set projection meeting one value at two display scales, planted for the dense population: R0(a integer, b
 * numeric(5, 2)) keyed by a, holding -1.00 at 2 and 1.00 at 1 in that order, joined on a with R1(a integer), and
 * projected as CASE WHEN b > 0 THEN -b ELSE b::numeric(38, 10)::numeric END. Both rows give -1, as -1.0000000000 and as
 * -1.00, and the projection's DISTINCT keeps one: which spelling survives is PostgreSQL's choice (the conservative
 * lowering's nested DISTINCTs keep -1.00, the optimized one and the reference, in fact order, -1.0000000000), so the
 * reference states that cell by its value alone (reference/values.ts).
 */
const twoScales: QueryCase = (() => {
	const decimal = scalarOfSpec({ carrier: "numericTypmod", precision: 5, scale: 2 })
	const wide = scalarOfSpec({ carrier: "numericTypmod", precision: 38, scale: 10 })
	const r0: GenRelation = {
		name: "R0",
		columns: [
			{ name: "a", type: int4 },
			{ name: "b", type: decimal }
		],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const r1: GenRelation = {
		name: "R1",
		columns: [{ name: "a", type: int4 }],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const base = (r: GenRelation) =>
		q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta)
	const joined = q.region([
		{ source: base(r0), bind: { a: "a", b: "b" }, constants: {} },
		{ source: base(r1), bind: { a: "a" }, constants: {} }
	])
	const b = () => q.col(joined, "b")
	/** A cast, which can fail where it narrows or its operand can. */
	const cast = (arg: ScalarExpr, type: ScalarType, checked: boolean): ScalarExpr =>
		q.b.expr({
			kind: "cast",
			checked,
			args: [arg],
			type,
			nonNull: "strict",
			volatility: "immutable"
		})
	const branch = q.b.expr({
		kind: "cond",
		args: [
			q.op(compareOpId(decimal, "gt"), [b(), q.decimal("0", decimal)], bool, "total"),
			cast(q.op("numeric_uminus", [b()], decimal, "total"), numeric, false),
			cast(cast(b(), wide, true), numeric, false)
		],
		type: numeric,
		nonNull: "cond"
	})
	const root = q.project(joined, [["y0", [branch, numeric]]], conservativeMeta)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	const int = (value: bigint): TypedLiteral => ({ kind: "int", value })
	const row = (a: bigint, text: string): ReadonlyArray<TypedLiteral> => [
		int(a),
		{ kind: "numeric", value: succeeded(DecimalText.make(text)) }
	]
	return {
		schema: { name: schemaName, relations: [r0, r1], closed: [], containments: [] },
		facts: { R0: [row(2n, "-1.00"), row(1n, "1.00")], R1: [[int(1n)], [int(2n)]] },
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
})()

/**
 * The extreme of a float zero of either sign, planted for the dense population: R0(a integer, b double precision) keyed
 * by a, holding -0 at 2 and 0 at 1 in that order, and `fn` of b over the bound tuples (a, b). Both zeros contribute,
 * and min and max return one of them: which sign the answer spells is PostgreSQL's choice (the conservative lowering's
 * DISTINCT meets the facts in key order, the reference in fact order), so the reference states that cell by its value
 * alone (reference/values.ts merged values).
 */
const zeroSigns = (fn: "min" | "max"): QueryCase => {
	const r0: GenRelation = {
		name: "R0",
		columns: [
			{ name: "a", type: int4 },
			{ name: "b", type: float8 }
		],
		primaryKey: ["a"],
		keys: [],
		mutable: false
	}
	const q = new Q()
	const base = q.base(
		{ name: r0.name, heading: r0.columns, primaryKey: r0.primaryKey },
		conservativeMeta
	)
	const root = q.group(
		base,
		["a", "b"],
		[],
		[{ name: "m", fn, op: `${fn}(double precision)`, args: ["b"], type: float8 }],
		conservativeMeta
	)
	const dag = normalQuery(q.b.build(Arr.of(root)))
	const row = (a: bigint, b: number): ReadonlyArray<TypedLiteral> => [
		{ kind: "int", value: a },
		{ kind: "float", value: b }
	]
	return {
		schema: { name: schemaName, relations: [r0], closed: [], containments: [] },
		facts: { R0: [row(2n, -0), row(1n, 0)] },
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
}

/** The dense population, drawn with every feature on, keeps the planted fold, projection and least zeros. */
const denseKept: ReadonlyArray<Kept<QueryCase, FrontierFeature>> = [
	{
		note: "count of distinct (y0, y1) over y0 = -a + (a + a), y1 = a, a holding the least double",
		sketch: unreadBound,
		draws: "",
		reaches: ["forced failure", "conservative error", "optimized error"]
	},
	{
		note: "CASE WHEN b > 0 THEN -b ELSE b::numeric(38, 10)::numeric END over b holding 1.00 and -1.00, joined",
		sketch: twoScales,
		draws: "",
		reaches: ["reference rows", "conservative rows", "optimized rows"]
	},
	{
		note: "min of b over b holding -0 at a = 2 and 0 at a = 1",
		sketch: zeroSigns("min"),
		draws: "",
		reaches: ["reference rows", "conservative rows", "optimized rows"]
	},
	{
		note: "max of b over b holding -0 at a = 2 and 0 at a = 1",
		sketch: zeroSigns("max"),
		draws: "",
		reaches: ["reference rows", "conservative rows", "optimized rows"]
	}
]

/**
 * The answers the population must reach: attachment rows checked against the reference, attachment statements that
 * must raise and that raise, and the optimized artifact delivering attachments both pipelined and fused, raising and
 * delivering.
 */
const required = [
	"reference rows",
	"reference attachment rows",
	"reference error",
	"forced attachment failure",
	"conservative rows",
	"conservative attachment statement error",
	"optimized rows",
	"optimized error",
	"optimized pipelined",
	"optimized fused"
] as const satisfies ReadonlyArray<FrontierFeature>

/** The suite notes nothing beyond the frontier's own features. */
const nothing = (): ReadonlyArray<never> => []

const judge = (
	gen: Gen<QueryCase>,
	kept: ReadonlyArray<Kept<QueryCase, FrontierFeature>>,
	suite: string
) =>
	exploreFrontier<QueryCase, never>(
		resolvedDraw(gen),
		"frontierattach",
		{
			suite,
			literal: Formatter.format,
			features: features<FrontierFeature>(required),
			kept,
			runs: cases,
			/** Every candidate runs on PostgreSQL. */
			shrink: { kind: "bounded", candidates: 150 },
			steering: { kind: "none" },
			caseHang: Duration.minutes(2),
			perturb: "all"
		},
		nothing
	)

layer(Substrate.layer)(
	"failing computed terms inside attachments against the reference, error or rows",
	(it) => {
		it.effect(
			`agrees on ${cases} generated cases with attachments`,
			(ctx) => searched(ctx, judge(attachGen(config), attachKept, "frontier/attach")),
			1_800_000
		)

		it.effect(
			`agrees on ${cases} generated cases with attachments, dense facts and edge values`,
			(ctx) => searched(ctx, judge(denseGen(edgeConfig), denseKept, "frontier/attach-dense")),
			1_800_000
		)
	}
)
