/**
 * Computed terms and the error frontier, conservative and optimized against the reference evaluator on PostgreSQL 19
 * (Compute in queries and the error frontier).
 *
 * The oracle population with computed terms in projections and filters: arithmetic over every numeric carrier and
 * money, casts between them with the numeric typmods that round and overflow, CASE, LEAST and GREATEST, round, trunc,
 * sqrt, power, gcd and the rest of the Compute catalogue, typed by the checker's own resolution (gen/compute.ts), over
 * the small domains with their bounds, NaN, the infinities and -0, so integer overflow, division by zero, a NaN cast
 * to an integer and a negative square root all happen. Each case is swarm-configured and runs under a plan
 * perturbation, and every answer of both lowerings is judged as "error or rows" against the reference (support.ts).
 *
 * Half the plain roots end in a division by zero over the rows the query delivers (finish.ts), delivered by a
 * projection that keeps every column or compared by a filter: wherever the query delivers a row whose dividend is not
 * NaN, every lowering must raise, so failures every lowering must raise meet every run, over every operator the query
 * below them draws. Failing terms inside an attachment's child are attach.test.ts's.
 */
import { layer } from "@effect/vitest"
import { type Draw, type Kept, sketched } from "@grizzle/testing/explore"
import { features } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, weighted } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Duration, Formatter } from "effect"
import { topoOrder } from "#compiler/ir/dag.ts"
import type { TypedLiteral } from "#compiler/ir/expr.ts"
import { conservativeMeta } from "#compiler/ir/rel.ts"
import {
	type Finish,
	finished,
	keeping,
	powered,
	poweredFinishGen
} from "#test/pg/oracle/frontier/finish.ts"
import { exploreFrontier, type FrontierFeature } from "#test/pg/oracle/frontier/support.ts"
import {
	defaultGenConfig,
	fullCaseSwarms,
	type GenConfig,
	paramNamesSketchGen,
	type QueryCase,
	type QueryCaseSketch,
	queryCaseSketchGen,
	resolveQueryCase,
	spellingSketchGen
} from "#test/support/oracle/gen/case.ts"
import {
	byZeroSketchGen,
	type CompareSketch,
	termSketchGen
} from "#test/support/oracle/gen/compute.ts"
import { bool, int4 } from "#test/support/oracle/gen/domain.ts"
import { rowSketchGen } from "#test/support/oracle/gen/facts.ts"
import { compareOpId } from "#test/support/oracle/gen/ops.ts"
import {
	normalQuery,
	type QueryFeature,
	type QuerySketch,
	queryExprs,
	queryGenerators,
	type RootSketch
} from "#test/support/oracle/gen/query.ts"
import { type GenRelation, schemaName, schemaSketchGen } from "#test/support/oracle/gen/schema.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { Q } from "#test/unit/lower/conservative/fixtures.ts"

const cases = 300

/**
 * What a case's query holds beyond the frontier's features: conditional and cast terms, and a filter that can fail over
 * an intersection or difference whose right arm projects a constant. The last is a defect class: a may-fail analysis
 * that reads only the left arm's values misses the constant the filter meets in the right arm. Both populations must
 * reach it, and the dense one, a draw of resolved cases, keeps a hand-built one (rightArmZero).
 */
type ComputeFeature = "case" | "cast" | "may-fail predicate over a set operation's right arm"

/**
 * Computed terms everywhere a projection or filter can take one; attachments are attach.test.ts's, so every root here is
 * a plain set or a heterogeneous union.
 */
const config: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		compute: 6,
		roots: {
			...defaultGenConfig.query.roots,
			attach: 0
		}
	}
}

/**
 * The dense population also draws the edge values (gen/domain.ts edgeClasses): integer and money bounds, float
 * subnormals and ±MAX, wide numerics, combining and right-to-left text.
 */
const edgeConfig: GenConfig = {
	...defaultGenConfig,
	query: {
		...defaultGenConfig.query,
		compute: 6,
		roots: {
			...defaultGenConfig.query.roots,
			attach: 0
		}
	},
	edge: true
}

const finishedRoot = (root: RootSketch, finish: Finish): RootSketch =>
	finish.form === "none" || root.tag !== "plain"
		? root
		: { ...root, body: finished(root.body, finish) }

/**
 * A set operation the plain root's body meets before its finish: none, or an intersection or difference with a drawn
 * right arm, under a filter whose predicate can fail. The generator projects the right arm onto the body's heading, a
 * literal wherever the arm has no column of a column's type (gen/query.ts conform), so the filter meets the constant
 * the right arm projects.
 */
type Arm =
	| { readonly form: "none" }
	| {
			readonly form: "intersect" | "difference"
			readonly right: QuerySketch
			readonly picks: ReadonlyArray<number>
			readonly compare: CompareSketch
	  }

const armGen = (c: GenConfig): Gen<Arm> => {
	const right = queryGenerators(c.query).query(1)
	return weighted<Arm>([
		[3, constant({ form: "none" })],
		[
			1,
			(source) => ({
				form: source.draw(element(["intersect", "difference"] as const)),
				right: source.draw(right),
				picks: source.draw(array(int(0, 7), { min: 1, max: 4 })),
				compare: {
					op: source.draw(int(0, 5)),
					left: source.draw(byZeroSketchGen(1)),
					right: source.draw(termSketchGen(0))
				}
			})
		]
	])
}

const armed = (body: QuerySketch, arm: Arm): QuerySketch =>
	arm.form === "none"
		? body
		: {
				tag: "filter",
				input: { tag: arm.form, left: body, right: arm.right, picks: arm.picks },
				pred: { tag: "term", compare: arm.compare }
			}

/**
 * What the computed population draws: the generator's sketch, the set operation its plain root's body meets, and how
 * that root is finished.
 */
interface ComputeSketch {
	readonly sketch: QueryCaseSketch
	readonly arm: Arm
	readonly finish: Finish
}

/**
 * The computed population, drawn as sketches, so a failure prints a sketch a person can keep; the property draws the
 * case its sketch resolves to. The swarm keeps the forms an arm and a finish draw at full weight.
 */
const computeDraw = (c: GenConfig): Draw<ComputeSketch, Gen<QueryCase>> => {
	const sketchGen = queryCaseSketchGen(c)
	const arms = armGen(c)
	return sketched(
		(source): ComputeSketch => ({
			sketch: source.draw(sketchGen),
			arm: source.draw(arms),
			finish: source.draw(poweredFinishGen)
		}),
		({ sketch, arm, finish }) => {
			/** The power finish replaces the body, so it keeps its projection and term, and no arm. */
			const kept: ReadonlyArray<QueryFeature> =
				finish.form === "power"
					? ["project"]
					: [
							...(finish.form === "none" ? [] : [finish.form]),
							...(arm.form === "none" ? [] : [arm.form, "filter" as const])
						]
			return resolveQueryCase(
				kept.length === 0 || sketch.root.tag !== "plain"
					? sketch
					: {
							...powered(sketch, finish),
							root: { ...sketch.root, body: finished(armed(sketch.root.body, arm), finish) },
							swarm: keeping(sketch.swarm, [...kept, "compute"])
						},
				c
			)
		}
	)
}

/**
 * The dense population draws no swarm: every feature is on in every case. Its cases are test/support/oracle/mutants
 * rootedCaseGen's, three to six facts per relation, with a power finish's schema and facts (finish.ts powered).
 */
const denseGen = (c: GenConfig): Gen<QueryCase> => {
	const schema = schemaSketchGen(c.schema)
	const facts = array(array(rowSketchGen, { min: 3, max: Math.max(3, c.facts.maxRows) }), {
		min: c.schema.maxRelations,
		max: c.schema.maxRelations
	})
	const roots = queryGenerators(c.query).root
	return (source) => {
		/** rootedCaseGen's sketch: every feature on at full weight. */
		const sketch: QueryCaseSketch = {
			schema: source.draw(schema),
			facts: source.draw(facts),
			spelling: source.draw(spellingSketchGen),
			root: source.draw(roots),
			paramNames: source.draw(paramNamesSketchGen),
			...fullCaseSwarms
		}
		const finish = source.draw(poweredFinishGen)
		const root = finishedRoot(sketch.root, finish)
		return source.draw(
			resolveQueryCase(
				sketch.root.tag === "plain" ? { ...powered(sketch, finish), root } : { ...sketch, root },
				c
			)
		)
	}
}

/**
 * The dense population's filter over a set operation's right arm, which it draws a few times a run, planted: R0 and R1
 * (k, a) keyed by k, a never zero, and the rows of R0's a that R1 projects as the literal 0, filtered where a / a = a.
 * The intersection holds no row, but PostgreSQL pushes the filter into both arms, where 0 / 0 folds at plan time: every
 * lowering may raise a division by zero, which an analysis reading only the left arm's values judges impossible.
 */
const rightArmZero: QueryCase = (() => {
	const stored = (name: string): GenRelation => ({
		name,
		columns: Arr.map(["k", "a"], (c) => ({ name: c, type: int4 })),
		primaryKey: ["k"],
		keys: [],
		mutable: false
	})
	const [R0, R1] = [stored("R0"), stored("R1")]
	const int = (value: number): TypedLiteral => ({ kind: "int", value: BigInt(value) })
	const q = new Q()
	const base = (r: GenRelation) =>
		q.base({ name: r.name, heading: r.columns, primaryKey: r.primaryKey }, conservativeMeta)
	const left = q.project(base(R0), [["a", "a"]], conservativeMeta)
	const right = q.project(base(R1), [["a", [q.int(0, int4), int4]]], conservativeMeta)
	const both = q.setOp("Intersect", left, right)
	const a = q.col(both, "a")
	const quotient = q.op("int4div", [a, a], int4, "canFail")
	const root = q.filter(both, q.op(compareOpId(int4, "eq"), [quotient, a], bool, "canFail"))
	const dag = normalQuery(q.b.build(Arr.of(root)))
	const facts = Arr.map(
		[
			[1, 1],
			[2, 2],
			[3, 3]
		],
		(row) => Arr.map(row, int)
	)
	return {
		schema: { name: schemaName, relations: [R0, R1], closed: [], containments: [] },
		facts: { R0: facts, R1: facts },
		query: { dag, params: {} },
		spelling: { mode: "perCase", choices: [], edge: false }
	}
})()

/** The dense population, each case drawn resolved, so its kept case is a case, replayed by value. */
const denseDraw = (c: GenConfig): Draw<QueryCase, Gen<QueryCase>> => sketched(denseGen(c), constant)

const denseKept: ReadonlyArray<Kept<QueryCase, FrontierFeature | ComputeFeature>> = [
	{
		note: "the intersection of R0's a and R1's literal 0, filtered where a / a = a",
		sketch: rightArmZero,
		draws: "",
		reaches: ["may-fail predicate over a set operation's right arm", "conservative error"]
	}
]

/**
 * The answers the population must reach: rows checked against the reference, a column it leaves unstated (a float
 * power the host declines, held by type alone), failures every lowering must raise, failures a lowering may raise, both
 * lowerings raising and delivering, conditional and cast terms, and the filter over a set operation's right arm.
 */
const required = [
	"reference rows",
	"an unstated declined column",
	"reference error",
	"forced failure",
	"conservative rows",
	"conservative error",
	"optimized rows",
	"optimized error",
	"case",
	"cast",
	"may-fail predicate over a set operation's right arm"
] as const satisfies ReadonlyArray<FrontierFeature | ComputeFeature>

/**
 * Whether some filter whose predicate can fail reads an intersection or difference whose right arm projects a literal.
 */
const mayFailOverRightArm = (c: QueryCase): boolean =>
	Arr.some(topoOrder(c.query.dag), (n) => {
		if (n.kind !== "Filter" || n.pred.failure !== "canFail") {
			return false
		}
		const input = n.input
		if (input.kind !== "Intersect" && input.kind !== "Difference") {
			return false
		}
		const right = input.right
		return right.kind === "ProjectSet" && Arr.some(right.out, (o) => o.expr.kind === "literal")
	})

/** The computed terms and shapes a case's query holds. */
const terms = (c: QueryCase): ReadonlyArray<ComputeFeature> => {
	const kinds = new Set(Arr.map(queryExprs(c.query.dag), (e) => e.kind))
	return [
		...(kinds.has("cond") ? ["case" as const] : []),
		...(kinds.has("cast") ? ["cast" as const] : []),
		...(mayFailOverRightArm(c)
			? ["may-fail predicate over a set operation's right arm" as const]
			: [])
	]
}

const judge = <K>(
	draw: Draw<K, Gen<QueryCase>>,
	kept: ReadonlyArray<Kept<K, FrontierFeature | ComputeFeature>>,
	suite: string
) =>
	exploreFrontier<K, ComputeFeature>(
		draw,
		"frontier",
		{
			suite,
			literal: Formatter.format,
			features: features<FrontierFeature | ComputeFeature>(required),
			kept,
			runs: cases,
			/** Every candidate runs on PostgreSQL. */
			shrink: { kind: "bounded", candidates: 150 },
			steering: { kind: "none" },
			caseHang: Duration.minutes(2),
			perturb: "all"
		},
		(c) => terms(c)
	)

layer(Substrate.layer)("computed terms against the reference, error or rows", (it) => {
	it.effect(
		`agrees on ${cases} generated cases with computed terms`,
		(ctx) => searched(ctx, judge(computeDraw(config), [], "frontier/compute")),
		1_800_000
	)

	it.effect(
		`agrees on ${cases} generated cases with computed terms, dense facts and edge values`,
		(ctx) => searched(ctx, judge(denseDraw(edgeConfig), denseKept, "frontier/dense")),
		1_800_000
	)
})
