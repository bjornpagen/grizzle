import { Array as Arr, Effect } from "effect"
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
	autocommit,
	compile,
	conditions,
	deliver,
	deliveredAgree,
	deliveredAlone,
	deliveredVariant,
	fill,
	handwritten,
	handwrittenRows,
	headingOf,
	installedIndexes,
	installFixture,
	judged,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession,
	settle,
	timeDeliveries
} from "#bench/query/support/kit.ts"

import {
	indexAccessOn,
	outline,
	planOf,
	rowsReadFrom,
	summaryOf
} from "#bench/query/support/plans.ts"
import { transportLimits } from "#compiler/lower/shapes/relparam/index.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"
import { indices } from "#test/support/oracle/pick.ts"

/**
 * R22: a relation parameter is one parameter.
 *
 * "The join uses the keyed relation's index under the VALUES transport, and under the recordset transport whenever the
 * keyed relation is large against the function scan's default row estimate ...; plan shape is independent of input
 * size except through estimates; the VALUES and recordset transports produce identical outcomes on the same input,
 * including duplicate and same-key facts". A relation parameter of item ids is joined to a large keyed relation, sent
 * by the runtime's own transport rule (relations.ts: VALUES at or below valuesMaxRows distinct facts, the recordset
 * above), and, to compare the two on one input, sent again under transport limits whose VALUES threshold is lower: the
 * measurement's choice, never a setting of the library. The input carries repeated facts, which the host deduplicates.
 * The handwritten baselines are the VALUES join and the N-ary OR tree R22 replaces.
 */
const Item = relation("Item", { id: pg.bigint, account: pg.bigint, price: pg.integer }, ["id"])
const Params = schema("Params", { Item }, [])

const itemsByIds = query(Params).rule((r) => {
	const wanted = r.relation("ids", { id: pg.bigint })
	const { id, price } = v(Item, "item")
	return r.match(wanted, { id }).match(Item, { id, price }).find({ id, price })
})

const programs = { itemsByIds } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly items: number
	readonly samples: number
}

/** @internal */
export default defineGate({
	name: "query-relparam",
	gates: ["R22"],
	title: "Relation parameters by VALUES and recordset against VALUES and OR-tree handwritten SQL",
	scope:
		"Ids of a large keyed relation as one relation parameter: the runtime's VALUES and recordset transports on one " +
		"input with repeated facts, plan shape across input sizes, and the OR tree.",
	phases: queryPhases,
	options: {
		full: { items: 500000, samples: 15 },
		quick: { items: 60000, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Params, programs, "benchrelparam", [])
			yield* fill(fx, "Item", options.items, {
				id: "g::int8",
				account: "(g % 1000)::int8",
				price: "((pg_catalog.hashint8(g) & 2147483647) % 10000)::int4"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b relparam runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b relparam raw")
			const indexes = yield* installedIndexes(fx)
			const item = fx.relationName("Item")
			const I = fx.table("Item")
			const c = (f: string) => fx.column("Item", f)
			const data = `${options.items} items keyed by id`
			const installed =
				"fresh install of Params with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const compiled = compile(fx, itemsByIds, {
				role: fx.world.app,
				context: "snapshot",
				warm: 3,
				read: "rows"
			})
			const ids = (n: number, stride: number) =>
				Arr.map(indices(n), (i) => ({ id: BigInt(1 + ((i * stride) % options.items)) }))
			const small = transportLimits.valuesMaxRows
			/** Ten distinct ids, each given twice: the host deduplicates before choosing the transport. */
			const input = [...ids(10, 977), ...ids(10, 977)]
			const recordsetLimits = { ...transportLimits, valuesMaxRows: 1 }
			const viaValues = yield* deliver(
				runtime,
				compiled,
				"optimized",
				{ ids: input },
				transportLimits
			)
			const viaRecordset = yield* deliver(
				runtime,
				compiled,
				"optimized",
				{ ids: input },
				recordsetLimits
			)
			const viaConservative = yield* deliver(
				runtime,
				compiled,
				"conservative",
				{ ids: input },
				transportLimits
			)
			const valuesOp = yield* timeDeliveries(
				runtime,
				compiled,
				"optimized",
				{ ids: input },
				options.samples,
				transportLimits
			)
			const recordsetOp = yield* timeDeliveries(
				runtime,
				compiled,
				"optimized",
				{ ids: input },
				options.samples,
				recordsetLimits
			)
			const variantOptions: VariantOptions = {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const valuesM = yield* measureVariant(
				raw,
				deliveredVariant("generated, VALUES", viaValues, compiled, valuesOp),
				variantOptions
			)
			const recordsetM = yield* measureVariant(
				raw,
				deliveredVariant("generated, recordset", viaRecordset, compiled, recordsetOp),
				{ ...variantOptions, serverPlans: ["generic"] }
			)
			const distinctIds = [...new Set(Arr.map(input, (x) => x.id))]
			const handOptions: VariantOptions = { ...variantOptions, warmup: 0 }
			const valuesHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten VALUES join",
					[
						{
							sql: handwrittenRows(
								headingOf(compiled),
								`SELECT i.${c("id")} AS id, i.${c("price")} AS price FROM (VALUES ${Arr.join(
									Arr.map(distinctIds, (x) => `(${x}::int8)`),
									", "
								)}) AS w(id) JOIN ${I} AS i ON i.${c("id")} = w.id`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			const orTree = yield* measureVariant(
				raw,
				handwritten(
					"OR tree, the replaced form",
					[
						{
							sql: handwrittenRows(
								headingOf(compiled),
								`SELECT ${c("id")} AS id, ${c("price")} AS price FROM ${I} WHERE ${Arr.join(
									Arr.map(distinctIds, (x) => `${c("id")} = ${x}::int8`),
									" OR "
								)}`
							),
							params: []
						}
					],
					autocommit
				),
				handOptions
			)
			/**
			 * Plan shape across sizes under the recordset transport: the function scan's estimate is its declared default
			 * whatever the input's size.
			 */
			const sizes = [50, 200, 800] as const
			const shapes: Array<string> = []
			const sizeRows: Array<number> = []
			for (const n of sizes) {
				const d = yield* deliver(
					runtime,
					compiled,
					"optimized",
					{ ids: ids(n, 7919) },
					recordsetLimits
				)
				const m = yield* measureVariant(raw, deliveredAlone(`recordset, ${n} ids`, d, {}), {
					...handOptions,
					samples: 1
				})
				shapes.push(summaryOf(m, 0).shape)
				sizeRows.push(rowsReadFrom(planOf(m, 0), item))
			}
			const valuesPlan = planOf(valuesM, 0)
			const recordsetPlan = planOf(recordsetM, 0)
			/**
			 * The template's statement: its relation parameter as one recordset, which the VALUES transport replaces in the
			 * execution's own text (reader/execution.ts executionOf).
			 */
			const templateShape = shapeOf(optimizedStatement(compiled, 0).ast)
			const itemKey = fx.columnName("Item", "id")
			const probesKey = (plan: PlanNode): boolean =>
				Arr.some(
					indexAccessOn(plan, item, indexes),
					(a) => a.columns[0] === itemKey && a.condition === "index cond"
				)
			const [valuesSent] = viaValues.statements
			const [recordsetSent] = viaRecordset.statements
			const cases: Array<CaseRecord<"R22">> = [
				{
					name: "ten ids, each given twice, by VALUES and by recordset",
					gates: ["R22"],
					conditions: conditions({
						workload: "a relation parameter of ids joined to Item by key",
						schemaState: installed,
						data,
						parameters: { ids: Arr.map(distinctIds, String), repeated: true, valuesMaxRows: small },
						semantics: "the (id, price) of the named items",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [valuesM, recordsetM, valuesHand, orTree],
					comparisons: [compareVariants(valuesM, valuesHand), compareVariants(valuesM, orTree)],
					transactions: {},
					loads: {},
					measures: {
						itemRowsReadValues: rowsReadFrom(valuesPlan, item),
						itemRowsReadRecordset: rowsReadFrom(recordsetPlan, item),
						itemRowsReadOrTree: rowsReadFrom(planOf(orTree, 0), item)
					}
				},
				{
					name: "the recordset transport at 50, 200 and 800 ids",
					gates: ["R22"],
					conditions: conditions({
						workload: "the same join with ids sent as one jsonb_to_recordset parameter",
						schemaState: installed,
						data,
						parameters: { sizes: [...sizes] },
						semantics: "the (id, price) of the named items",
						cache: "each size runs once before its one timed sample"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { shapes: Arr.join(shapes, " || "), itemRowsReadBySize: sizeRows }
				}
			]
			const r22: VerdictInput = {
				checks: [
					mechanism(
						"ten distinct ids travel as a VALUES list of typed literals",
						findNodes(valuesPlan, "Values Scan").length > 0 &&
							findNodes(valuesPlan, "Function Scan").length === 0 &&
							featureCount(templateShape, "from recordset") === 1 &&
							valuesSent.params.length === 0,
						`${valuesSent.params.length} parameters sent\n${outline(valuesPlan, 0)}`
					),
					mechanism(
						"the VALUES join probes the keyed relation's index",
						probesKey(valuesPlan),
						outline(valuesPlan, 0)
					),
					mechanism(
						"the recordset is one parameter",
						featureCount(templateShape, "from recordset") === 1 &&
							recordsetSent.params.length === 1,
						`${recordsetSent.params.length} parameters sent`
					),
					mechanism(
						"the recordset join probes the large keyed relation's index",
						probesKey(recordsetPlan),
						outline(recordsetPlan, 0)
					),
					mechanism(
						"the recordset plan's shape is the same at every input size",
						new Set(shapes).size === 1,
						Arr.join(shapes, " || ")
					),
					mechanism(
						"the join reads the named rows, not the relation",
						rowsReadFrom(valuesPlan, item) <= distinctIds.length &&
							rowsReadFrom(recordsetPlan, item) <= distinctIds.length,
						`${rowsReadFrom(valuesPlan, item)} and ${rowsReadFrom(recordsetPlan, item)} rows for ${distinctIds.length} ids`
					),
					judged(
						"VALUES and recordset deliver identical results on the same input, repeated facts included",
						deliveredAgree("ordered"),
						viaValues.rows,
						viaRecordset.rows
					),
					equivalence(
						"the host deduplicates the repeated facts: one row per distinct id",
						viaValues.rows.length === distinctIds.length,
						`${viaValues.rows.length} rows for ${distinctIds.length} distinct ids`
					),
					judged(
						"the generated read agrees with the conservative lowering",
						deliveredAgree("ordered"),
						viaValues.rows,
						viaConservative.rows
					),
					equivalence(
						"the VALUES transport agrees with the handwritten VALUES join",
						compareVariants(valuesM, valuesHand).sameResult,
						`${valuesM.result.rows} generated rows, ${valuesHand.result.rows} handwritten`
					),
					equivalence(
						"the VALUES transport agrees with the OR tree",
						compareVariants(valuesM, orTree).sameResult,
						`${valuesM.result.rows} generated rows, ${orTree.result.rows} handwritten`
					)
				]
			}
			return { cases, verdicts: { R22: r22 } }
		})
})
