import { Array as Arr, Effect } from "effect"
import type { PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { compareVariants, measureVariant } from "#bench/harness/variant.ts"
import {
	agrees,
	autocommit,
	type Compiled,
	compile,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	type MeasureOptions,
	measureQuery,
	optimizedAst,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession
} from "#bench/query/support/kit.ts"

import { indices } from "@bjornpagen/grizzle-text/base/array"
import {
	Lab,
	labData,
	labPrices,
	labPrograms,
	labSittings,
	loadLab,
	withNext,
	withNextPrice,
	withPrice,
	withPriceFor
} from "#bench/query/support/lab.ts"
import { nodeTypes, outline, planOf, rowsReadFrom, scansOf } from "#bench/query/support/plans.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"

/**
 * R27 and R42: successors and as-of selections by the parent set. (R20's take(k) has one form, the probe, whose pages
 * test/pg/lower-shapes/take-probe.test.ts counts against n × (h + k + 1).)
 *
 * Each gate runs its shape over a small bound parent set and over every group of the Lab fixture (support/lab.ts), the
 * generated statements against the conservative composition and against handwritten LATERAL and whole-relation SQL:
 *
 * - R27: the strict successor over every sitting agrees with the LATERAL take(1) on groups of one row, on the last row
 *   of each group (which the bound form removes) and on ties of the day broken by the key.
 * - R42: the latest price at or before each sitting, and the mirror, agree with the LATERAL form on ties at equal
 *   prefixes, on parents before the first price and on groups without prices; the ordered pass over whole inputs probes
 *   no parent; a relation parameter's few students take the LATERAL probe.
 */
interface Options extends Readonly<Record<string, unknown>> {
	readonly students: number
	readonly perStudent: number
	readonly samples: number
}

type Gates = "R27" | "R42"

export default defineGate({
	name: "query-take",
	gates: ["R27", "R42"],
	title: "Successors and as-of selections by the parent set against handwritten SQL",
	scope:
		"the successor of every sitting (R27); the as-of price of every sitting, its mirror, and of a relation " +
		"parameter's students (R42). A tutoring timeline is represented by the whole-input as-of over every sitting.",
	phases: queryPhases,
	options: {
		full: {
			students: 3000,
			perStudent: 30,
			samples: 15
		},
		quick: {
			students: 400,
			perStudent: 16,
			samples: 2
		}
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Lab, labPrograms, {}, "benchtake", () => [])
			const size = { students: options.students, perStudent: options.perStudent }
			yield* loadLab(fx, size)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b take raw")
			const sitting = fx.relationName("Sitting")
			const price = fx.relationName("Price")
			const S = fx.table("Sitting")
			const P = fx.table("Price")
			const s = (f: string) => fx.column("Sitting", f)
			const p = (f: string) => fx.column("Price", f)
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
			const installed =
				"fresh install of Lab with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const hand = (compiled: Compiled, label: string, sql: string) =>
				measureVariant(
					raw,
					handwritten(
						label,
						[{ sql: handwrittenRows(headingOf(compiled), sql), params: [] }],
						autocommit
					),
					{
						samples: options.samples,
						warmup: 0,
						explainSamples: 1,
						explain: plainExplain,
						serverPlans: []
					}
				)
			const wholeOnce = (plan: PlanNode) =>
				scansOf(plan, sitting).length === 1 &&
				Arr.every(scansOf(plan, sitting), (n) => n.actualLoops === 1)

			/** R27. */
			const next = compile(fx, withNext, reading)
			const nextM = yield* measureQuery(runtime, raw, next, {}, measure)
			const nextLateral = yield* hand(
				next,
				"handwritten LATERAL take(1)",
				`SELECT x.${s("id")} AS id, n.id AS nid, n.score AS nscore FROM ${S} AS x JOIN LATERAL (SELECT y.${s("id")} AS id, y.${s("score")} AS score ` +
					`FROM ${S} AS y WHERE y.${s("student")} = x.${s("student")} AND (y.${s("day")}, y.${s("id")}) > (x.${s("day")}, x.${s("id")}) ` +
					`ORDER BY y.${s("day")}, y.${s("id")} LIMIT 1) AS n ON true`
			)
			const nextLead = yield* hand(
				next,
				"handwritten LEAD",
				`SELECT w.id, w.nid, w.nscore FROM (SELECT x.${s("id")} AS id, lead(x.${s("id")}, 1, x.${s("id")}) OVER o AS nid, ` +
					`lead(x.${s("score")}, 1, x.${s("score")}) OVER o AS nscore, count(*) OVER (o ROWS BETWEEN 1 FOLLOWING AND 1 FOLLOWING) AS present ` +
					`FROM ${S} AS x WINDOW o AS (PARTITION BY x.${s("student")} ORDER BY x.${s("day")}, x.${s("id")})) AS w WHERE w.present = 1`
			)
			const nextPlan = planOf(nextM.generated, 0)
			cases.push({
				name: "every sitting with its student's next sitting by (day, id)",
				gates: ["R27"],
				conditions: {
					workload: "take(1) of the strict successor by (day, id), bound to every sitting",
					schemaState: installed,
					dataDistribution: data,
					parameters: {},
					resultSemantics: "each sitting that has a successor, with the successor's id and score",
					cacheState: warm
				},
				phases: {},
				variants: [nextM.generated, nextM.conservative, nextLateral, nextLead],
				comparisons: [compareVariants(nextM.generated, nextLateral)],
				transactions: {},
				loads: {},
				measures: {
					delivered: nextM.delivered.generated.rows.length,
					expected: sittings - options.students,
					sittingRowsReadGenerated: rowsReadFrom(nextPlan, sitting),
					sittingRowsReadLateral: rowsReadFrom(planOf(nextLateral, 0), sitting)
				}
			})
			const r27: VerdictInput = {
				checks: [
					mechanism(
						"LEAD with the row's own default and a presence count over one scan",
						has(shapeOf(optimizedAst(next)), "window lead") &&
							wholeOnce(nextPlan) &&
							nodeTypes(nextPlan).has("WindowAgg"),
						outline(nextPlan, 0)
					),
					agrees("the successor agrees with the composition", nextM),
					equivalence(
						"the successor agrees with handwritten LATERAL take(1)",
						compareVariants(nextM.generated, nextLateral).sameResult,
						`${nextM.generated.result.rows} generated rows, ${nextLateral.result.rows} handwritten`
					),
					equivalence(
						"the successor agrees with handwritten LEAD",
						compareVariants(nextM.generated, nextLead).sameResult,
						`${nextM.generated.result.rows} generated rows, ${nextLead.result.rows} handwritten`
					),
					equivalence(
						"the last row of every group, and the single row of a one-row group, has no successor",
						nextM.delivered.generated.rows.length === sittings - options.students,
						`${nextM.delivered.generated.rows.length} delivered, ${sittings - options.students} expected`
					)
				]
			}

			/** R42. */
			const asOf = compile(fx, withPrice, reading)
			const asOfM = yield* measureQuery(runtime, raw, asOf, {}, measure)
			const asOfLateral = yield* hand(
				asOf,
				"handwritten LATERAL",
				`SELECT x.${s("id")} AS id, q.id AS pid, q.amount FROM ${S} AS x JOIN LATERAL (SELECT y.${p("id")} AS id, y.${p("amount")} AS amount ` +
					`FROM ${P} AS y WHERE y.${p("student")} = x.${s("student")} AND y.${p("day")} <= x.${s("day")} ` +
					`ORDER BY y.${p("day")} DESC, y.${p("id")} DESC LIMIT 1) AS q ON true`
			)
			const mirror = compile(fx, withNextPrice, reading)
			const mirrorM = yield* measureQuery(runtime, raw, mirror, {}, measure)
			const mirrorLateral = yield* hand(
				mirror,
				"handwritten LATERAL, mirror",
				`SELECT x.${s("id")} AS id, q.id AS pid, q.amount FROM ${S} AS x JOIN LATERAL (SELECT y.${p("id")} AS id, y.${p("amount")} AS amount ` +
					`FROM ${P} AS y WHERE y.${p("student")} = x.${s("student")} AND y.${p("day")} >= x.${s("day")} ` +
					`ORDER BY y.${p("day")}, y.${p("id")} LIMIT 1) AS q ON true`
			)
			const few = Arr.map(indices(6), (i) => ({ id: 3 + i * 5 }))
			const bound = compile(fx, withPriceFor, reading)
			const boundM = yield* measureQuery(runtime, raw, bound, { students: few }, measure)
			const asOfPlan = planOf(asOfM.generated, 0)
			const mirrorPlan = planOf(mirrorM.generated, 0)
			const boundPlan = planOf(boundM.generated, 0)
			const noProbe = (plan: PlanNode) =>
				Arr.every([...scansOf(plan, sitting), ...scansOf(plan, price)], (n) => n.actualLoops === 1)
			const fewSittings = Arr.reduce(few, 0, (n, w) => n + (w.id === 1 ? 1 : options.perStudent))
			const prices = labPrices(size)
			cases.push(
				{
					name: "every sitting with its student's latest price at or before its day",
					gates: ["R42"],
					conditions: {
						workload:
							"take(1) by (day desc, id desc) of Price with day <= the sitting's day, bound to every sitting",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics:
							"each sitting with a price at or before its day, with the latest such price",
						cacheState: warm
					},
					phases: {},
					variants: [asOfM.generated, asOfM.conservative, asOfLateral],
					comparisons: [compareVariants(asOfM.generated, asOfLateral)],
					transactions: {},
					loads: {},
					measures: {
						sittingRowsRead: rowsReadFrom(asOfPlan, sitting),
						priceRowsRead: rowsReadFrom(asOfPlan, price),
						sittingScans: scansOf(asOfPlan, sitting).length,
						priceScans: scansOf(asOfPlan, price).length,
						sittings,
						prices,
						lateralPriceRowsRead: rowsReadFrom(planOf(asOfLateral, 0), price)
					}
				},
				{
					name: "every sitting with its student's earliest price at or after its day (the mirror)",
					gates: ["R42"],
					conditions: {
						workload:
							"take(1) by (day, id) of Price with day >= the sitting's day, bound to every sitting",
						schemaState: installed,
						dataDistribution: data,
						parameters: {},
						resultSemantics:
							"each sitting with a price at or after its day, with the earliest such price",
						cacheState: warm
					},
					phases: {},
					variants: [mirrorM.generated, mirrorM.conservative, mirrorLateral],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				},
				{
					name: "a relation parameter's students' sittings with their as-of price",
					gates: ["R42"],
					conditions: {
						workload: "the as-of take bound to the sittings of a relation parameter's six students",
						schemaState: installed,
						dataDistribution: data,
						parameters: { students: Arr.map(few, (w) => w.id) },
						resultSemantics: "each such sitting with its latest price at or before its day",
						cacheState: warm
					},
					phases: {},
					variants: [boundM.generated, boundM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						boundSittingRowsRead: rowsReadFrom(boundPlan, sitting),
						boundPriceRowsRead: rowsReadFrom(boundPlan, price),
						parentSittings: fewSittings
					}
				}
			)
			const r42: VerdictInput = {
				checks: [
					mechanism(
						"the ordered pass over whole inputs probes no parent: every scan runs once",
						noProbe(asOfPlan) && noProbe(mirrorPlan),
						outline(asOfPlan, 0)
					),
					mechanism(
						"the ordered pass reads Price once",
						rowsReadFrom(asOfPlan, price) === prices && rowsReadFrom(mirrorPlan, price) === prices,
						`${rowsReadFrom(asOfPlan, price)} of ${prices}`
					),
					mechanism(
						"the ordered pass reads the parents once",
						rowsReadFrom(asOfPlan, sitting) === sittings &&
							rowsReadFrom(mirrorPlan, sitting) === sittings,
						`${rowsReadFrom(asOfPlan, sitting)} and ${rowsReadFrom(mirrorPlan, sitting)} of ${sittings}`
					),
					mechanism(
						"a relation parameter's few students take the LATERAL probe, reading their sittings, not every sitting",
						rowsReadFrom(boundPlan, sitting) <= 2 * fewSittings,
						`${rowsReadFrom(boundPlan, sitting)} sitting rows for ${fewSittings} parent sittings\n${outline(boundPlan, 0)}`
					),
					agrees("the as-of agrees with the composition", asOfM),
					equivalence(
						"the as-of agrees with handwritten LATERAL",
						compareVariants(asOfM.generated, asOfLateral).sameResult,
						`${asOfM.generated.result.rows} generated rows, ${asOfLateral.result.rows} handwritten`
					),
					agrees("the mirror agrees with the composition", mirrorM),
					equivalence(
						"the mirror agrees with handwritten LATERAL",
						compareVariants(mirrorM.generated, mirrorLateral).sameResult,
						`${mirrorM.generated.result.rows} generated rows, ${mirrorLateral.result.rows} handwritten`
					),
					agrees("the bound form agrees with the composition", boundM)
				]
			}
			return { cases, verdicts: { R27: r27, R42: r42 } }
		})
})
