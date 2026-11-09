import { Array as Arr, Effect, Option } from "effect"
import { findNodes, type PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	type GateCheck,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { deepEquals } from "#test/support/assert.ts"

import {
	compareVariants,
	measureVariant,
	type TextRow,
	type VariantOptions
} from "#bench/harness/variant.ts"

import {
	agreementCounts,
	agrees,
	autocommit,
	type Compiled,
	certifiedRules,
	columnAt,
	compile,
	counterexample,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	type QueryMeasure,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	within
} from "#bench/query/support/kit.ts"

import {
	conditionalPerStudent,
	continuousMedian,
	discretePercentiles,
	distinctPointsPerCohort,
	groupedShare,
	keyedShare,
	Lab,
	labData,
	labPrograms,
	labSittings,
	loadLab,
	modalDay,
	modeOfDays,
	ordinalPerStudent,
	pointsPerCohort,
	roomPercentile,
	runningPerStudent,
	runningQualified
} from "#bench/query/support/lab.ts"

import {
	aggregateNodes,
	joinTypes,
	nodeTypes,
	outline,
	planOf,
	rowsReadFrom,
	scansOf
} from "#bench/query/support/plans.ts"
import { appendAll } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import type { OptimizedStatement } from "#compiler/lower/shapes/index.ts"
import type { Expr, FunctionCall, OperandSelect, WindowSpec } from "#compiler/sql/ast.ts"
import {
	identityHooks,
	inertVisitor,
	transformStatement,
	visitSelect
} from "#compiler/sql/transform.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"

/**
 * R08, R24, R26, R28-R31 and R41: aggregates and the compile-target catalog against handwritten native SQL.
 *
 * Every catalog entry is measured three ways on the Lab fixture (support/lab.ts): the generated statement, which the
 * catalog rewrites to its native target; the conservative lowering, which is the composition itself (the self-join and
 * grouped count, the join to a second aggregate stage, the ordinal selections), correct by construction and quadratic
 * or twice-scanning where the entry says so; and the native SQL a PostgreSQL expert writes. The gates:
 *
 * - R24 (:287): identical results where no binding, some bindings and every binding satisfies the predicate, the first
 *   being the case a filtered sum gets wrong, which the handwritten `sum(x) FILTER` counterexample shows; one aggregate
 *   node.
 * - R26 (:305) and R41 (:450): agreement with the composed self-join on ties broken by the completed order, on groups of
 *   one row and on conditional forms where no row qualifies; one window pass, rows read proportional to the input; a
 *   further predicate on the second occurrence keeps the self-join.
 * - R28 (performance contract): one scan instead of a join to a second aggregate stage.
 * - R29, R30, R31 (contract): one ordered aggregate per group over one scan; R30's double-precision interpolation
 *   recorded against the composition's. R29's counterexamples (:327) are run per room of 100 sittings:
 *   p = 0.07, which is not dyadic and where the native aggregate takes the eighth value and the composition the
 *   seventh, and p = 0, where the native aggregate returns the first value and the composition none; neither is
 *   rewritten, both agree with the composition, and handwritten percentile_disc differs, so each counterexample is live.
 * - R08 (contract): the direct join and grouping against the handwritten direct and pre-aggregated shapes,
 *   and the counterexample that binding without the key changes the contributions, so a bag sum or a sum over DISTINCT
 *   argument is wrong.
 */
interface Options extends Readonly<Record<string, unknown>> {
	readonly students: number
	readonly perStudent: number
	readonly samples: number
}

type Gates = "R08" | "R24" | "R26" | "R28" | "R29" | "R30" | "R31" | "R41"

/** The tolerance the double-precision catalog entries agree within: an absolute difference of their values. */
const tolerance = 1e-9

/**
 * Keyed texts of rows: each row's (key, value) cells, and how many rows had a NULL in either, which no grizzle
 * statement delivers.
 */
interface Keyed {
	readonly pairs: ReadonlyArray<readonly [string, string]>
	readonly nulls: number
}

const keyedTexts = (rows: ReadonlyArray<TextRow>, key: number, value: number): Keyed => {
	const pairs: Array<readonly [string, string]> = []
	let nulls = 0
	for (const row of rows) {
		const k = row[key]
		const x = row[value]
		if (k === null || k === undefined || x === null || x === undefined) {
			nulls += 1
		} else {
			pairs.push([k, x])
		}
	}
	return { pairs, nulls }
}

/** Every call of a statement, nested queries included. */
const callsOf = (statement: OptimizedStatement): ReadonlyArray<FunctionCall> => {
	const calls: Array<FunctionCall> = []
	transformStatement(statement.ast, {
		...identityHooks,
		expr: (e) => {
			if (e.kind === "call") {
				calls.push(e)
			}
			return e
		}
	})
	return calls
}

/** Every CASE of a query, nested queries included. */
const casesIn = (query: OperandSelect): ReadonlyArray<Extract<Expr, { readonly kind: "case" }>> => {
	const cases: Array<Extract<Expr, { readonly kind: "case" }>> = []
	visitSelect(query, {
		...inertVisitor,
		expr: (x) => {
			if (x.kind === "case") {
				cases.push(x)
			}
		}
	})
	return cases
}

/** Every LATERAL derived table of a statement, by its alias: the rows an operation binds its operands in, once per row. */
const lateralsOf = (statement: OptimizedStatement): ReadonlyMap<string, OperandSelect> => {
	const laterals = new Map<string, OperandSelect>()
	transformStatement(statement.ast, {
		...identityHooks,
		fromSource: (source) => {
			if (source.kind === "derived" && source.lateral) {
				laterals.set(source.alias, source.query)
			}
			return source
		}
	})
	return laterals
}

export default defineGate({
	name: "query-catalog",
	gates: ["R08", "R24", "R26", "R28", "R29", "R30", "R31", "R41"],
	title:
		"Aggregates and the compile-target catalog against their compositions and handwritten native SQL",
	scope:
		"Conditional aggregates (R24), ordinals and running aggregates (R26, R41), shares (R28), discrete and continuous " +
		"percentiles and the mode (R29-R31), and aggregation over a join (R08), each delivered " +
		"as the catalog's native form and as the composition, and compared with handwritten window and ordered-set SQL.",
	phases: queryPhases,
	options: {
		full: { students: 3000, perStudent: 30, samples: 15 },
		quick: { students: 300, perStudent: 16, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Lab, labPrograms, "benchcatalog", [])
			const size = { students: options.students, perStudent: options.perStudent }
			yield* loadLab(fx, size)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b catalog raw")
			const sitting = fx.relationName("Sitting")
			const S = fx.table("Sitting")
			const St = fx.table("Student")
			const s = (f: string) => fx.column("Sitting", f)
			const data = labData(size)
			const sittings = labSittings(size)
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: 1
			}
			/**
			 * Counterexamples and refusals are timed once: their answers and plans are the evidence, their timings beside the
			 * measured forms.
			 */
			const once: MeasureOptions = { ...measure, samples: 1 }
			const installed =
				"fresh install of Lab with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 0,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}

			/** The handwritten variant of `compiled`: `sql` delivers its heading's columns. */
			const hand = (compiled: Compiled, label: string, sql: string) =>
				measureVariant(
					raw,
					handwritten(
						label,
						[{ sql: handwrittenRows(headingOf(compiled), sql), params: [] }],
						autocommit
					),
					handOptions
				)
			/** A rejected rewrite of `compiled`, kept as a counterexample: `sql` delivers its heading's columns. */
			const rejected = (compiled: Compiled, label: string, sql: string) =>
				measureVariant(
					raw,
					counterexample(
						label,
						[{ sql: handwrittenRows(headingOf(compiled), sql), params: [] }],
						autocommit
					),
					{ ...handOptions, samples: 1 }
				)

			/** R24: the threshold puts each student's scores in none, some or all of the qualifying set. */
			const conditionalChecks: Array<GateCheck> = []
			const conditionalMeasures: Record<string, number> = {}
			const conditionalVariants = []
			for (const [label, threshold] of [
				["some", 3],
				["every", -1],
				["none", 100]
			] as const) {
				const compiled = compile(fx, conditionalPerStudent(threshold), reading)
				const m = yield* measureQuery(runtime, raw, compiled, {}, measure)
				const native = yield* hand(
					compiled,
					`handwritten FILTER and CASE (${label})`,
					`SELECT ${s("student")} AS student, count(*) FILTER (WHERE ${s("score")} > ${threshold}::float8) AS passed, ` +
						`sum(CASE WHEN ${s("score")} > ${threshold}::float8 THEN ${s("score")} ELSE 0::float8 END) AS points FROM ${S} GROUP BY ${s("student")}`
				)
				const filteredSum = yield* rejected(
					compiled,
					`sum(x) FILTER, the rejected form (${label})`,
					`SELECT ${s("student")} AS student, count(*) FILTER (WHERE ${s("score")} > ${threshold}::float8) AS passed, ` +
						`sum(${s("score")}) FILTER (WHERE ${s("score")} > ${threshold}::float8) AS points FROM ${S} GROUP BY ${s("student")}`
				)
				const plan = planOf(m.generated, 0)
				const statement = optimizedStatement(compiled, 0)
				const calls = callsOf(statement)
				const laterals = lateralsOf(statement)
				/**
				 * The conditional count is count(*) with FILTER (WHERE p), and the conditional sum a sum, which takes no FILTER,
				 * of a CASE that tests the same p: the CASE an exact float sum takes the exact value of, bound once per row in the
				 * LATERAL row its argument reads, so every reference to the sum aggregates one column and no reference computes
				 * the CASE or its exact value again.
				 */
				const predicates = Arr.flatMap(calls, (c) =>
					c.star && c.filter !== undefined ? [c.filter] : []
				)
				const filteredCounts = predicates.length
				const caseSums = Arr.filter(
					calls,
					(c) =>
						!c.star &&
						c.fn.kind === "builtin" &&
						c.fn.name === "sum" &&
						Arr.some(c.args, (a) => {
							const bound =
								a.kind === "column" && a.table !== undefined ? laterals.get(a.table) : undefined
							return (
								bound !== undefined &&
								Arr.some(casesIn(bound), (k) =>
									Arr.some(k.whens, (w) => Arr.some(predicates, (p) => deepEquals(w.when, p)))
								)
							)
						})
				).length
				conditionalChecks.push(
					agrees(`${label}: generated agrees with the composition`, m),
					equivalence(
						`${label}: generated agrees with handwritten FILTER and CASE`,
						compareVariants(m.generated, native).sameResult,
						`${m.generated.result.rows} generated rows, ${native.result.rows} handwritten`
					),
					mechanism(
						`${label}: one aggregate node`,
						aggregateNodes(plan).length === 1,
						outline(plan, 0)
					),
					mechanism(
						`${label}: the count is FILTER and the sum reads a CASE through its LATERAL row`,
						filteredCounts > 0 && caseSums > 0,
						`${filteredCounts} filtered counts, ${caseSums} sums reading a CASE on a FILTER's predicate through a LATERAL row`
					)
				)
				if (label === "none") {
					conditionalChecks.push(
						equivalence(
							"none: the rejected sum(x) FILTER delivers something else (a NULL sum)",
							!compareVariants(m.generated, filteredSum).sameResult,
							`${m.generated.result.rows} generated rows, ${filteredSum.result.rows} rejected`
						)
					)
				}
				conditionalMeasures[`aggregateNodes.${label}`] = aggregateNodes(plan).length
				conditionalVariants.push(m.generated, m.conservative, native, filteredSum)
			}
			cases.push({
				name: "conditional counts and sums per student, where none, some and every score qualifies",
				gates: ["R24"],
				conditions: {
					workload:
						"sum(cond(score > t, 1, 0)) and sum(cond(score > t, score, 0)) per student for t = 3, -1, 100",
					schemaState: installed,
					dataDistribution: data,
					parameters: { thresholds: [3, -1, 100] },
					resultSemantics:
						"per student, the count and the score sum of its sittings above the threshold",
					cacheState: warm
				},
				phases: {},
				variants: conditionalVariants,
				comparisons: [],
				transactions: {},
				loads: {},
				measures: conditionalMeasures
			})
			const [firstConditional, ...moreConditional] = conditionalChecks
			if (firstConditional === undefined) {
				throw new GateSetupError({ what: "R24 judged no threshold" })
			}
			const r24: VerdictInput = { checks: [firstConditional, ...moreConditional] }

			/** R26 and R41. */
			const running = compile(fx, runningPerStudent, reading)
			const runningM = yield* measureQuery(runtime, raw, running, {}, measure)
			const runningHand = yield* hand(
				running,
				"handwritten window",
				`SELECT ${s("student")} AS student, ${s("id")} AS id, row_number() OVER w AS ordinal, sum(${s("score")}) OVER w AS total, ` +
					`max(${s("score")}) OVER w AS top, count(*) FILTER (WHERE ${s("score")} > 3::float8) OVER w AS above FROM ${S} ` +
					`WINDOW w AS (PARTITION BY ${s("student")} ORDER BY ${s("day")}, ${s("id")} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`
			)
			const ordinal = compile(fx, ordinalPerStudent, reading)
			const ordinalM = yield* measureQuery(runtime, raw, ordinal, {}, measure)
			const ordinalHand = yield* hand(
				ordinal,
				"handwritten row_number",
				`SELECT ${s("student")} AS student, ${s("id")} AS id, row_number() OVER (PARTITION BY ${s("student")} ORDER BY ${s("day")}, ${s("id")}) AS ordinal FROM ${S}`
			)
			const qualified = compile(fx, runningQualified, reading)
			const qualifiedM = yield* measureQuery(runtime, raw, qualified, {}, once)
			const runningPlan = planOf(runningM.generated, 0)
			const ordinalPlan = planOf(ordinalM.generated, 0)
			const qualifiedPlan = planOf(qualifiedM.generated, 0)
			const runningRows = yield* textRowsOf(raw, runningM.delivered.generated.statements)
			/** Student 1's single sitting, and a conditional count that is zero before a student's first qualifying row. */
			const studentAt = columnAt(running, "student")
			const ordinalAt = columnAt(running, "ordinal")
			const aboveAt = columnAt(running, "above")
			const single = Arr.filter(runningRows, (r) => r[studentAt] === "1")
			const zeroAbove = Arr.filter(runningRows, (r) => r[aboveAt] === "0").length
			if (zeroAbove === 0) {
				throw new GateSetupError({
					what: "no running conditional count is zero: no row precedes a qualifying one"
				})
			}
			/** The frames of the running aggregates' window calls. */
			const frames = Arr.flatMap(callsOf(optimizedStatement(running, 0)), (c) =>
				c.over?.frame === undefined ? [] : [c.over.frame]
			)
			const runningFrame = (frame: NonNullable<WindowSpec["frame"]>): boolean =>
				frame.start.kind === "unboundedPreceding" && frame.end.kind === "currentRow"
			cases.push(
				{
					name: "ordinals and running aggregates per student by (day, id)",
					gates: ["R26", "R41"],
					conditions: {
						workload:
							"Sitting matched twice on the student, the second occurrence at or before the first by (day, id)",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics:
							"each sitting's ordinal, running score total, running maximum and running count of scores above 3",
						cacheState: warm
					},
					phases: {},
					variants: [runningM.generated, runningM.conservative, runningHand],
					comparisons: [compareVariants(runningM.generated, runningHand)],
					transactions: {},
					loads: {},
					measures: {
						sittingRowsReadGenerated: rowsReadFrom(runningPlan, sitting),
						sittingRowsReadConservative: rowsReadFrom(planOf(runningM.conservative, 0), sitting),
						sittings,
						rowsWithZeroRunningCount: zeroAbove
					}
				},
				{
					name: "ordinals alone",
					gates: ["R26"],
					conditions: {
						workload: "the same self-match counting only",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "each sitting's ordinal within its student",
						cacheState: warm
					},
					phases: {},
					variants: [ordinalM.generated, ordinalM.conservative, ordinalHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { sittingRowsReadOrdinal: rowsReadFrom(ordinalPlan, sitting) }
				},
				{
					name: "a running maximum over the qualifying rows only (kept composed)",
					gates: ["R41"],
					conditions: {
						workload: "the self-match with a further predicate on the second occurrence, score > 3",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics:
							"each sitting's maximum score above 3 at or before it, where one exists",
						cacheState: "the refusal is timed once, after its first execution"
					},
					phases: {},
					variants: [qualifiedM.generated, qualifiedM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const windowOnce = (plan: PlanNode) =>
				nodeTypes(plan).has("WindowAgg") && scansOf(plan, sitting).length === 1
			const r26: VerdictInput = {
				checks: [
					mechanism(
						"the ordinal is one window pass over one scan",
						windowOnce(ordinalPlan),
						outline(ordinalPlan, 0)
					),
					mechanism(
						"rows read are the input, not the self-join",
						rowsReadFrom(ordinalPlan, sitting) === sittings,
						`${rowsReadFrom(ordinalPlan, sitting)} of ${sittings}`
					),
					agrees("the ordinal agrees with the composed self-join count", ordinalM),
					equivalence(
						"the ordinal agrees with handwritten row_number",
						compareVariants(ordinalM.generated, ordinalHand).sameResult,
						`${ordinalM.generated.result.rows} generated rows, ${ordinalHand.result.rows} handwritten`
					),
					equivalence(
						"a group of one row has ordinal 1",
						single.length === 1 && single[0]?.[ordinalAt] === "1",
						`${single.length} rows of student 1`
					),
					equivalence(
						"no repeated row",
						ordinalM.generated.result.repeated === 0,
						`${ordinalM.generated.result.repeated} repeated`
					)
				]
			}
			const r41: VerdictInput = {
				checks: [
					mechanism(
						"one window pass over one scan",
						windowOnce(runningPlan),
						outline(runningPlan, 0)
					),
					mechanism(
						"rows read are proportional to the input",
						rowsReadFrom(runningPlan, sitting) === sittings,
						`${rowsReadFrom(runningPlan, sitting)} of ${sittings}; the composition reads ${rowsReadFrom(planOf(runningM.conservative, 0), sitting)}`
					),
					mechanism(
						"the frame is ROWS, stated explicitly",
						frames.length > 0 && Arr.every(frames, runningFrame),
						Arr.join(
							Arr.map(frames, (f) => `${f.start.kind} to ${f.end.kind}`),
							", "
						)
					),
					mechanism(
						"a further predicate on the second occurrence keeps the self-join",
						!nodeTypes(qualifiedPlan).has("WindowAgg") && joinTypes(qualifiedPlan).length > 0,
						outline(qualifiedPlan, 0)
					),
					agrees("running aggregates agree with the composed self-join", runningM),
					equivalence(
						"running aggregates agree with the handwritten window",
						compareVariants(runningM.generated, runningHand).sameResult,
						`${runningM.generated.result.rows} generated rows, ${runningHand.result.rows} handwritten`
					),
					agrees("the kept self-join agrees with the composition", qualifiedM)
				]
			}

			/** R28. */
			const grouped = compile(fx, groupedShare, reading)
			const groupedM = yield* measureQuery(runtime, raw, grouped, {}, measure)
			const groupedHand = yield* hand(
				grouped,
				"handwritten window sum",
				`SELECT ${s("student")} AS student, count(*) AS n, (sum(count(*)) OVER ())::bigint AS "all" FROM ${S} GROUP BY ${s("student")}`
			)
			const groupedJoin = yield* hand(
				grouped,
				"handwritten join to a second aggregate",
				`SELECT g.student, g.n, t."all" FROM (SELECT ${s("student")} AS student, count(*) AS n FROM ${S} GROUP BY ${s("student")}) AS g ` +
					`CROSS JOIN (SELECT count(*) AS "all" FROM ${S}) AS t`
			)
			const keyed = compile(fx, keyedShare, reading)
			const keyedM = yield* measureQuery(runtime, raw, keyed, {}, measure)
			const keyedHand = yield* hand(
				keyed,
				"handwritten window count",
				`SELECT ${s("id")} AS id, ${s("student")} AS student, ${s("day")} AS day, count(*) OVER (PARTITION BY ${s("student")}) AS n FROM ${S}`
			)
			const groupedPlan = planOf(groupedM.generated, 0)
			const keyedPlan = planOf(keyedM.generated, 0)
			cases.push(
				{
					name: "each student's count beside the total",
					gates: ["R28"],
					conditions: {
						workload: "a grouped count joined to the ungrouped count of the same input",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "per student, its sitting count and the total count",
						cacheState: warm
					},
					phases: {},
					variants: [groupedM.generated, groupedM.conservative, groupedHand, groupedJoin],
					comparisons: [
						compareVariants(groupedM.generated, groupedHand),
						compareVariants(groupedM.generated, groupedJoin)
					],
					transactions: {},
					loads: {},
					measures: {
						sittingScansGenerated: scansOf(groupedPlan, sitting).length,
						sittingScansConservative: scansOf(planOf(groupedM.conservative, 0), sitting).length
					}
				},
				{
					name: "each sitting with its student's count",
					gates: ["R28"],
					conditions: {
						workload: "a per-student count joined back to its input on the student",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "each sitting with the number of sittings of its student",
						cacheState: warm
					},
					phases: {},
					variants: [keyedM.generated, keyedM.conservative, keyedHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { sittingScansKeyed: scansOf(keyedPlan, sitting).length }
				}
			)
			const r28: VerdictInput = {
				checks: [
					mechanism(
						"the grouped share scans the input once",
						scansOf(groupedPlan, sitting).length === 1,
						outline(groupedPlan, 0)
					),
					mechanism(
						"the keyed share scans the input once",
						scansOf(keyedPlan, sitting).length === 1,
						outline(keyedPlan, 0)
					),
					agrees("the grouped share agrees with the composition", groupedM),
					equivalence(
						"the grouped share agrees with the handwritten window sum",
						compareVariants(groupedM.generated, groupedHand).sameResult,
						`${groupedM.generated.result.rows} generated rows, ${groupedHand.result.rows} handwritten`
					),
					agrees("the keyed share agrees with the composition", keyedM),
					equivalence(
						"the keyed share agrees with the handwritten window count",
						compareVariants(keyedM.generated, keyedHand).sameResult,
						`${keyedM.generated.result.rows} generated rows, ${keyedHand.result.rows} handwritten`
					)
				]
			}

			/** R29, R30, R31. */
			const disc = compile(fx, discretePercentiles, reading)
			const discM = yield* measureQuery(runtime, raw, disc, {}, measure)
			const discHand = yield* hand(
				disc,
				"handwritten percentile_disc",
				`SELECT ${s("student")} AS student, percentile_disc(0.5::float8) WITHIN GROUP (ORDER BY ${s("score")}) AS median, ` +
					`percentile_disc(0.25::float8) WITHIN GROUP (ORDER BY ${s("score")}) AS "lowerQuartile" FROM ${S} GROUP BY ${s("student")}`
			)
			/** R29's counterexamples, per room of 100 sittings. */
			const r = (f: string) => fx.column("Sitting", f)
			const counterexamples = []
			for (const [label, p] of [
				["0.07", 0.07],
				["0", 0]
			] as const) {
				const compiled = compile(fx, roomPercentile(p), reading)
				const m = yield* measureQuery(runtime, raw, compiled, {}, once)
				const native = yield* rejected(
					compiled,
					`handwritten percentile_disc(${label}), the rejected rewrite`,
					`SELECT ${r("room")} AS room, percentile_disc(${label}::float8) WITHIN GROUP (ORDER BY ${r("score")}) AS value ` +
						`FROM ${S} GROUP BY ${r("room")}`
				)
				counterexamples.push({ label, compiled, m, native })
			}
			const roomRows = yield* raw.values(
				`SELECT count(*)::text FROM (SELECT ${r("room")} FROM ${S} GROUP BY ${r("room")} HAVING count(*) = 100) AS full_rooms`,
				[]
			)
			const [fullRoomsRow] = trusted<ReadonlyArray<readonly [count: string]>>(roomRows)
			if (fullRoomsRow === undefined) {
				throw new GateSetupError({ what: "no count of the full rooms" })
			}
			const fullRooms = Number(fullRoomsRow[0])
			if (fullRooms === 0) {
				throw new GateSetupError({ what: "the fixture has no room of 100 sittings" })
			}
			const cont = compile(fx, continuousMedian, reading)
			const contM = yield* measureQuery(runtime, raw, cont, {}, measure)
			const contHand = yield* hand(
				cont,
				"handwritten percentile_cont",
				`SELECT ${s("student")} AS student, percentile_cont(0.5::float8) WITHIN GROUP (ORDER BY ${s("score")}) AS median FROM ${S} GROUP BY ${s("student")}`
			)
			const contStudent = columnAt(cont, "student")
			const contMedian = columnAt(cont, "median")
			const generatedTexts = yield* textRowsOf(raw, contM.delivered.generated.statements)
			const contGenerated = keyedTexts(generatedTexts, contStudent, contMedian)
			const conservativeTexts = yield* textRowsOf(raw, contM.delivered.conservative.statements)
			const contComposed = keyedTexts(conservativeTexts, contStudent, contMedian)
			const contAgreement = within(tolerance)(contGenerated.pairs, contComposed.pairs)
			const contCounts = agreementCounts(tolerance, contGenerated.pairs, contComposed.pairs)
			const mode = compile(fx, modalDay, reading)
			const modeM = yield* measureQuery(runtime, raw, mode, {}, measure)
			const modeHand = yield* hand(
				mode,
				"handwritten mode()",
				`SELECT ${s("student")} AS student, mode() WITHIN GROUP (ORDER BY ${s("day")}) AS mode FROM ${S} GROUP BY ${s("student")}`
			)
			const modeAll = compile(fx, modeOfDays, reading)
			const modeAllM = yield* measureQuery(runtime, raw, modeAll, {}, measure)
			const orderedOnce = (m: QueryMeasure) => {
				const plan = planOf(m.generated, 0)
				return scansOf(plan, sitting).length === 1 && !nodeTypes(plan).has("WindowAgg")
			}
			appendAll(cases, [
				{
					name: "discrete percentiles 1/2 and 1/4 of each student's scores",
					gates: ["R29"],
					conditions: {
						workload: "the score at ordinal ceil(p n) by (score, id) for p = 0.5 and 0.25",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics:
							"per student, its median and lower-quartile scores by the discrete definition",
						cacheState: warm
					},
					phases: {},
					variants: [discM.generated, discM.conservative, discHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						sittingScansGenerated: scansOf(planOf(discM.generated, 0), sitting).length,
						sittingRowsReadConservative: rowsReadFrom(planOf(discM.conservative, 0), sitting)
					}
				},
				...Arr.map(counterexamples, ({ label, m, native, compiled }): CaseRecord<Gates> => ({
					name: `the score at ordinal ceil(${label} n) of each room (an R29 counterexample)`,
					gates: ["R29"],
					conditions: {
						workload: `the score at ordinal ceil(${label} n) by (score, id) per room`,
						schemaState: installed,
						dataDistribution: data,
						parameters: { p: Number(label) },
						resultSemantics:
							label === "0"
								? "no row: ceil(0) selects no ordinal"
								: "per room, the score at the composition's ordinal ceil((0.07 n::float8)::numeric)",
						cacheState: "the counterexample is timed once, after its first execution"
					},
					phases: {},
					variants: [m.generated, m.conservative, native],
					comparisons: [compareVariants(m.generated, native)],
					transactions: {},
					loads: {},
					measures: {
						delivered: m.delivered.generated.rows.length,
						fullRooms,
						certifiedR29: certifiedRules(compiled).includes("R29") ? 1 : 0
					}
				})),
				{
					name: "the interpolated median of each student's scores",
					gates: ["R30"],
					conditions: {
						workload: "the values at floor and ceil of 1 + (n - 1)/2, interpolated",
						schemaState: installed,
						dataDistribution: data,
						parameters: { tolerance },
						resultSemantics: "per student, its continuous median score",
						cacheState: warm
					},
					phases: {},
					variants: [contM.generated, contM.conservative, contHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						groups: contCounts.keys,
						exactGroups: contCounts.exact,
						roundingGroups: contCounts.withinTolerance,
						maxAbsDifference: contCounts.maxAbsDifference
					}
				},
				{
					name: "each student's most frequent day, ties to the earliest",
					gates: ["R31"],
					conditions: {
						workload: "a count per day ordered by count desc, day asc, take(1), bound per student",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "per student with sittings, its modal day",
						cacheState: warm
					},
					phases: {},
					variants: [
						modeM.generated,
						modeM.conservative,
						modeHand,
						modeAllM.generated,
						modeAllM.conservative
					],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { sittingScansGenerated: scansOf(planOf(modeM.generated, 0), sitting).length }
				}
			])
			const r29: VerdictInput = {
				checks: [
					mechanism(
						"one call per fraction over one scan",
						orderedOnce(discM) &&
							has(shapeOf(optimizedStatement(disc, 0).ast), "aggregate percentile_disc"),
						outline(planOf(discM.generated, 0), 0)
					),
					agrees("percentile_disc agrees with the ordinal composition", discM),
					equivalence(
						"percentile_disc agrees with the handwritten aggregate",
						compareVariants(discM.generated, discHand).sameResult,
						`${discM.generated.result.rows} generated rows, ${discHand.result.rows} handwritten`
					),
					...Arr.flatMap(counterexamples, ({ label, m, native }) => [
						agrees(`p = ${label}: the generated statement agrees with the ordinal composition`, m),
						equivalence(
							`p = ${label}: the counterexample is live, handwritten percentile_disc differs`,
							!compareVariants(m.generated, native).sameResult,
							`${m.generated.result.rows} generated rows, ${native.result.rows} handwritten`
						)
					])
				]
			}
			const r30: VerdictInput = {
				checks: [
					mechanism(
						"one ordered aggregate over one scan",
						orderedOnce(contM) &&
							has(shapeOf(optimizedStatement(cont, 0).ast), "aggregate percentile_cont"),
						outline(planOf(contM.generated, 0), 0)
					),
					equivalence(
						"percentile_cont agrees with the composition up to double-precision rounding",
						contGenerated.nulls === 0 && contComposed.nulls === 0 && Option.isNone(contAgreement),
						`${contGenerated.nulls} and ${contComposed.nulls} NULL rows; ${Option.getOrElse(contAgreement, () => "agree")}`
					),
					equivalence(
						"percentile_cont agrees with the handwritten aggregate",
						compareVariants(contM.generated, contHand).sameResult,
						`${contM.generated.result.rows} generated rows, ${contHand.result.rows} handwritten`
					)
				]
			}
			const r31: VerdictInput = {
				checks: [
					mechanism(
						"one ordered aggregate over one scan",
						orderedOnce(modeM) && has(shapeOf(optimizedStatement(mode, 0).ast), "aggregate mode"),
						outline(planOf(modeM.generated, 0), 0)
					),
					agrees("mode() agrees with the count-and-take composition per student", modeM),
					equivalence(
						"mode() agrees with the handwritten aggregate",
						compareVariants(modeM.generated, modeHand).sameResult,
						`${modeM.generated.result.rows} generated rows, ${modeHand.result.rows} handwritten`
					),
					agrees("the uncorrelated mode agrees with its composition", modeAllM)
				]
			}

			/** R08. */
			const direct = compile(fx, pointsPerCohort, reading)
			const directM = yield* measureQuery(runtime, raw, direct, {}, measure)
			const directHand = yield* hand(
				direct,
				"handwritten direct join and grouping",
				`SELECT st.${fx.column("Student", "cohort")} AS cohort, count(*) AS sittings, sum(x.${s("points")}) AS points FROM ${S} AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.${s("student")} GROUP BY st.${fx.column("Student", "cohort")}`
			)
			const preaggregated = yield* hand(
				direct,
				"handwritten pre-aggregation per student",
				`SELECT st.${fx.column("Student", "cohort")} AS cohort, sum(x.n)::bigint AS sittings, sum(x.p)::bigint AS points FROM ` +
					`(SELECT ${s("student")} AS student, count(*) AS n, sum(${s("points")}) AS p FROM ${S} GROUP BY ${s("student")}) AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.student GROUP BY st.${fx.column("Student", "cohort")}`
			)
			const distinct = compile(fx, distinctPointsPerCohort, reading)
			const distinctM = yield* measureQuery(runtime, raw, distinct, {}, once)
			const bagSum = yield* rejected(
				distinct,
				"bag sum, the rejected rewrite",
				`SELECT st.${fx.column("Student", "cohort")} AS cohort, sum(x.${s("points")}) AS points FROM ${S} AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.${s("student")} GROUP BY st.${fx.column("Student", "cohort")}`
			)
			const argumentDistinct = yield* rejected(
				distinct,
				"sum(DISTINCT points), the rejected rewrite",
				`SELECT st.${fx.column("Student", "cohort")} AS cohort, sum(DISTINCT x.${s("points")}) AS points FROM ${S} AS x ` +
					`JOIN ${St} AS st ON st.${fx.column("Student", "id")} = x.${s("student")} GROUP BY st.${fx.column("Student", "cohort")}`
			)
			const directPlan = planOf(directM.generated, 0)
			const directStatement = optimizedStatement(direct, 0)
			const directShape = shapeOf(directStatement.ast)
			/** An aggregate over DISTINCT arguments, which deduplicates the argument alone. */
			const distinctArguments = (statement: OptimizedStatement): number =>
				Arr.filter(callsOf(statement), (c) => !c.star && c.distinct).length
			/**
			 * Whether PostgreSQL's eager aggregation ran a partial aggregate below the join, which the direct form lets it
			 * consider.
			 */
			const eager = Arr.some(
				findNodes(directPlan, (n) => Option.isSome(n.joinType)),
				(j) => Arr.some(j.children, (c) => findNodes(c, "Aggregate").length > 0)
			)
			cases.push(
				{
					name: "sittings and points per cohort over the Student join",
					gates: ["R08"],
					conditions: {
						workload:
							"Student joined to Sitting by student, grouped by cohort, the sitting key bound",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "per cohort, the number of sittings and the sum of their points",
						cacheState: warm
					},
					phases: {},
					variants: [directM.generated, directM.conservative, directHand, preaggregated],
					comparisons: [
						compareVariants(directM.generated, directHand),
						compareVariants(directM.generated, preaggregated)
					],
					transactions: {},
					loads: {},
					measures: {
						eagerAggregation: eager,
						aggregateNodesGenerated: aggregateNodes(directPlan).length,
						plan: outline(directPlan, 0)
					}
				},
				{
					name: "points per cohort with the sitting key unbound (the counterexample)",
					gates: ["R08"],
					conditions: {
						workload: "the same join, binding (cohort, student, points) without the sitting key",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics: "per cohort, the sum over distinct (student, points) bindings",
						cacheState: "the counterexample is timed once, after its first execution"
					},
					phases: {},
					variants: [distinctM.generated, distinctM.conservative, bagSum, argumentDistinct],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const r08: VerdictInput = {
				checks: [
					mechanism(
						"the bound-key aggregate is emitted as one direct join and grouping",
						featureCount(directShape, "group by") === 1 &&
							!has(directShape, "distinct") &&
							!has(directShape, "distinct on") &&
							distinctArguments(directStatement) === 0,
						Arr.join(
							Arr.map([...directShape.counts.entries()], ([f, n]) => `${f} ${n}`),
							", "
						)
					),
					mechanism(
						"the unbound-key aggregate deduplicates the complete binding, never the argument alone",
						distinctArguments(optimizedStatement(distinct, 0)) === 0,
						`${distinctArguments(optimizedStatement(distinct, 0))} aggregates over DISTINCT arguments`
					),
					agrees("direct agrees with the composition", directM),
					equivalence(
						"direct agrees with the handwritten direct form",
						compareVariants(directM.generated, directHand).sameResult,
						`${directM.generated.result.rows} generated rows, ${directHand.result.rows} handwritten`
					),
					equivalence(
						"direct agrees with the handwritten pre-aggregated form",
						compareVariants(directM.generated, preaggregated).sameResult,
						`${directM.generated.result.rows} generated rows, ${preaggregated.result.rows} handwritten`
					),
					agrees("the counterexample agrees with the composition", distinctM),
					equivalence(
						"the counterexample is live: a bag sum differs",
						!compareVariants(distinctM.generated, bagSum).sameResult,
						`${distinctM.generated.result.rows} generated rows, ${bagSum.result.rows} bag`
					),
					equivalence(
						"the counterexample is live: sum(DISTINCT argument) differs",
						!compareVariants(distinctM.generated, argumentDistinct).sameResult,
						`${distinctM.generated.result.rows} generated rows, ${argumentDistinct.result.rows} argument-distinct`
					)
				]
			}
			return {
				cases,
				verdicts: {
					R08: r08,
					R24: r24,
					R26: r26,
					R28: r28,
					R29: r29,
					R30: r30,
					R31: r31,
					R41: r41
				}
			}
		})
})
