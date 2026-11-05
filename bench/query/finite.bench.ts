import { Array as Arr, Effect, Result } from "effect"
import { findNodes, type PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"
import { compareVariants, measureVariant, type VariantOptions } from "#bench/harness/variant.ts"
import {
	agrees,
	autocommit,
	compile,
	conditions,
	fill,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"
import { outline, planOf } from "#bench/query/support/plans.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, relation, schema } from "#compiler/public/schema.ts"
import { featureCount, has, shapeOf } from "#test/support/kernel/shape.ts"

/**
 * R07: keep finite schema facts visible to PostgreSQL.
 *
 * R07 states no gate paragraph, so its gate is the performance contract's: "a measurement that can disprove the
 * performance assumption". The assumption is that a closed relation's declared facts, matched only to test
 * membership, are better as native constant membership the planner sees than as a VALUES join. One closed
 * roster, Tier, of twelve handles with a (rate, region) payload, and Order(id, tier, amount) referring to it:
 *
 * - a literal constant on the payload selects the matching facts at compile time, so the match becomes `tier IN
 *   (...)` over the enum, with no VALUES scan;
 * - a parameter constant keeps each fact's correlation as tuple membership, never independent IN lists;
 * - a membership covering the whole roster is a tautology and disappears.
 * Each is compared with the conservative lowering, which joins the closed facts as a VALUES relation, and with the
 * handwritten IN list.
 */
const handles = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11"] as const
const Tier = closed("Tier", handles).with(
	{ rate: pg.integer, region: pg.integer },
	{
		T0: { rate: 10, region: 0 },
		T1: { rate: 11, region: 1 },
		T2: { rate: 12, region: 2 },
		T3: { rate: 13, region: 0 },
		T4: { rate: 14, region: 1 },
		T5: { rate: 15, region: 2 },
		T6: { rate: 16, region: 0 },
		T7: { rate: 17, region: 1 },
		T8: { rate: 18, region: 2 },
		T9: { rate: 19, region: 0 },
		T10: { rate: 20, region: 1 },
		T11: { rate: 21, region: 2 }
	}
)
const Order = relation("Order", { id: pg.bigint, tier: closedId(Tier), amount: pg.integer }, ["id"])
const Finite = schema("Finite", { Tier, Order }, [])

/** Orders of the region-1 tiers: a literal on the payload. */
const regionOne = query(Finite).rule((r) => {
	const { id, tier, amount } = v(Order, "order")
	return r
		.match(Order, { id, tier, amount })
		.match(Tier, { id: tier, region: 1 })
		.where(r.gt(amount, 900))
		.find({ id, amount })
})

/** Orders of the tiers of a parameter's region: tuple membership. */
const ofRegion = query(Finite).rule((r) => {
	const { id, tier, amount } = v(Order, "order")
	return r
		.match(Order, { id, tier, amount })
		.match(Tier, { id: tier, region: r.param("region", Tier.payload.region) })
		.where(r.gt(amount, 900))
		.find({ id, amount })
})

/** Every tier: a tautology. */
const anyTier = query(Finite).rule((r) => {
	const { id, tier, amount } = v(Order, "order")
	return r
		.match(Order, { id, tier, amount })
		.match(Tier, { id: tier })
		.where(r.gt(amount, 990))
		.find({ id, amount })
})

const programs = { regionOne, ofRegion, anyTier } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly orders: number
	readonly samples: number
}

const valuesScans = (plan: PlanNode) => findNodes(plan, "Values Scan").length

/** @internal */
export default defineGate({
	name: "query-finite",
	gates: ["R07"],
	title:
		"Closed facts as native constant membership against a VALUES join and a handwritten IN list",
	scope:
		"Membership-only matches of a twelve-handle closed roster's facts: a payload literal (compile-time selection), a " +
		"payload parameter (tuple membership), and every handle (a tautology), against the conservative VALUES join and " +
		"the handwritten IN list.",
	phases: queryPhases,
	options: {
		full: { orders: 200000, samples: 15 },
		quick: { orders: 30000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Finite, programs, "benchfinite", [])
			const tierType = fx.enumType("Tier")
			yield* fill(fx, "Order", options.orders, {
				id: "g::int8",
				tier: `(ARRAY[${Arr.join(
					Arr.map(handles, (h) => `'${h}'`),
					", "
				)}]::${tierType}[])[1 + g % ${handles.length}]`,
				amount: "((pg_catalog.hashint8(g) & 2147483647) % 1000)::int4"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b finite runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b finite raw")
			const O = fx.table("Order")
			const c = (f: string) => fx.column("Order", f)
			const data = `${options.orders} orders over the twelve tiers in turn, amounts hashed 0-999`
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: options.samples
			}
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 0,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const installed =
				"fresh install of Finite with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const inList = (hs: ReadonlyArray<string>) =>
				Arr.join(
					Arr.map(hs, (h) => `'${h}'::${tierType}`),
					", "
				)
			const regionHandles = (region: number) =>
				Arr.filterMap(handles, (handle, i) =>
					i % 3 === region ? Result.succeed(handle) : Result.failVoid
				)

			const one = compile(fx, regionOne, reading)
			const oneM = yield* measureQuery(runtime, raw, one, {}, measure)
			const oneHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten IN list",
					[
						{
							sql: handwrittenRows(
								headingOf(one),
								`SELECT ${c("id")} AS id, ${c("amount")} AS amount FROM ${O} WHERE ${c("tier")} IN (${inList(regionHandles(1))}) AND ${c("amount")} > 900`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			const param = compile(fx, ofRegion, reading)
			const paramM = yield* measureQuery(runtime, raw, param, { region: 2 }, measure)
			const paramHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten IN list for region 2",
					[
						{
							sql: handwrittenRows(
								headingOf(param),
								`SELECT ${c("id")} AS id, ${c("amount")} AS amount FROM ${O} WHERE ${c("tier")} IN (${inList(regionHandles(2))}) AND ${c("amount")} > 900`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			const all = compile(fx, anyTier, reading)
			const allM = yield* measureQuery(runtime, raw, all, {}, measure)
			const onePlan = planOf(oneM.generated, 0)
			const paramPlan = planOf(paramM.generated, 0)
			const allPlan = planOf(allM.generated, 0)
			const oneShape = shapeOf(optimizedStatement(one, 0).ast)
			const allShape = shapeOf(optimizedStatement(all, 0).ast)
			const cases: Array<CaseRecord<"R07">> = [
				{
					name: "orders of the region-1 tiers above an amount",
					gates: ["R07"],
					conditions: conditions({
						workload: "Order matched to Tier on the handle with region literal 1",
						schemaState: installed,
						data,
						parameters: {},
						semantics: "the (id, amount) of orders above 900 whose tier lies in region 1",
						cache: warm
					}),
					phases: {},
					variants: [oneM.generated, oneM.conservative, oneHand],
					comparisons: [
						compareVariants(oneM.generated, oneHand),
						compareVariants(oneM.generated, oneM.conservative)
					],
					transactions: {},
					loads: {},
					measures: {
						valuesScansGenerated: valuesScans(onePlan),
						valuesScansConservative: valuesScans(planOf(oneM.conservative, 0))
					}
				},
				{
					name: "orders of a parameter region's tiers above an amount",
					gates: ["R07"],
					conditions: conditions({
						workload: "Order matched to Tier on the handle with region a parameter",
						schemaState: installed,
						data,
						parameters: { region: 2 },
						semantics: "the (id, amount) of orders above 900 whose tier lies in region 2",
						cache: warm
					}),
					phases: {},
					variants: [paramM.generated, paramM.conservative, paramHand],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { valuesScansParameter: valuesScans(paramPlan) }
				},
				{
					name: "orders of any tier above an amount",
					gates: ["R07"],
					conditions: conditions({
						workload: "Order matched to Tier on the handle only",
						schemaState: installed,
						data,
						parameters: {},
						semantics: "the (id, amount) of orders above 990",
						cache: warm
					}),
					phases: {},
					variants: [allM.generated, allM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { inListsTautology: featureCount(allShape, "in list") }
				}
			]
			const r07: VerdictInput = {
				checks: [
					mechanism(
						"a payload literal becomes enum membership with no VALUES scan",
						valuesScans(onePlan) === 0 && has(oneShape, "in list") && !has(oneShape, "from values"),
						outline(onePlan, 0)
					),
					mechanism(
						"the parameter form joins no VALUES list",
						valuesScans(paramPlan) === 0,
						outline(paramPlan, 0)
					),
					mechanism(
						"a membership of the whole roster disappears",
						valuesScans(allPlan) === 0 &&
							!has(allShape, "in list") &&
							!has(allShape, "from values"),
						outline(allPlan, 0)
					),
					agrees("the literal form agrees with the VALUES join", oneM),
					equivalence(
						"the literal form agrees with the handwritten IN list",
						compareVariants(oneM.generated, oneHand).sameResult,
						`${oneM.generated.result.rows} generated rows, ${oneHand.result.rows} handwritten`
					),
					agrees("the parameter form agrees with the VALUES join", paramM),
					equivalence(
						"the parameter form agrees with the handwritten IN list",
						compareVariants(paramM.generated, paramHand).sameResult,
						`${paramM.generated.result.rows} generated rows, ${paramHand.result.rows} handwritten`
					),
					agrees("the tautology agrees with the VALUES join", allM)
				]
			}
			return { cases, verdicts: { R07: r07 } }
		})
})
