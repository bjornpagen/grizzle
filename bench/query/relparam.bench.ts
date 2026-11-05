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
import { indices, maxOf } from "#compiler/core/array.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { featureCount, shapeOf } from "#test/support/kernel/shape.ts"

/**
 * R22: a relation parameter is one array per column.
 *
 * "The join uses the keyed relation's index; the planner estimates the input's rows as its arrays' length at every
 * size, so plan shape follows the input's size only through that estimate; the arrays deliver what the handwritten
 * VALUES join and the OR tree deliver on the same input, including duplicate facts". A relation parameter of item ids is
 * joined to a large keyed relation, sent by the runtime's one transport (relations.ts: one array per column, whatever
 * the input's size). The input carries repeated facts, which the host deduplicates. The handwritten baselines are the
 * VALUES join and the N-ary OR tree R22 replaces.
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
	title: "Relation parameters as arrays against VALUES and OR-tree handwritten SQL",
	scope:
		"Ids of a large keyed relation as one relation parameter: the runtime's arrays on one input with repeated facts, " +
		"the input's estimate and plan shape across input sizes, and the OR tree.",
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
			/** Ten distinct ids, each given twice: the host deduplicates before writing the arrays. */
			const input = [...ids(10, 977), ...ids(10, 977)]
			const viaArrays = yield* deliver(runtime, compiled, "optimized", { ids: input })
			const viaConservative = yield* deliver(runtime, compiled, "conservative", { ids: input })
			const arraysOp = yield* timeDeliveries(
				runtime,
				compiled,
				"optimized",
				{ ids: input },
				options.samples
			)
			const variantOptions: VariantOptions = {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const arraysM = yield* measureVariant(
				raw,
				deliveredVariant("generated, arrays", viaArrays, compiled, arraysOp),
				variantOptions
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
			 * Plan shape across sizes: each array is a constant of the execution's custom plan, so the input's estimate is
			 * its length (sql/print.ts printArrays).
			 */
			const sizes = [50, 200, 800] as const
			const shapes: Array<string> = []
			const sizeRows: Array<number> = []
			const estimates: Array<number> = []
			for (const n of sizes) {
				const d = yield* deliver(runtime, compiled, "optimized", { ids: ids(n, 7919) })
				const m = yield* measureVariant(raw, deliveredAlone(`arrays, ${n} ids`, d, {}), {
					...handOptions,
					samples: 1
				})
				shapes.push(summaryOf(m, 0).shape)
				sizeRows.push(rowsReadFrom(planOf(m, 0), item))
				estimates.push(
					maxOf(
						Arr.map(findNodes(planOf(m, 0), "ProjectSet"), (p) => p.planRows),
						0
					)
				)
			}
			const arraysPlan = planOf(arraysM, 0)
			/** The template's statement: its relation parameter as its arrays, one placeholder per column. */
			const templateShape = shapeOf(optimizedStatement(compiled, 0).ast)
			const itemKey = fx.columnName("Item", "id")
			const probesKey = (plan: PlanNode): boolean =>
				Arr.some(
					indexAccessOn(plan, item, indexes),
					(a) => a.columns[0] === itemKey && a.condition === "index cond"
				)
			const [arraysSent] = viaArrays.statements
			const cases: Array<CaseRecord<"R22">> = [
				{
					name: "ten ids, each given twice, as arrays",
					gates: ["R22"],
					conditions: conditions({
						workload: "a relation parameter of ids joined to Item by key",
						schemaState: installed,
						data,
						parameters: { ids: Arr.map(distinctIds, String), repeated: true },
						semantics: "the (id, price) of the named items",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [arraysM, valuesHand, orTree],
					comparisons: [compareVariants(arraysM, valuesHand), compareVariants(arraysM, orTree)],
					transactions: {},
					loads: {},
					measures: {
						itemRowsReadArrays: rowsReadFrom(arraysPlan, item),
						itemRowsReadOrTree: rowsReadFrom(planOf(orTree, 0), item)
					}
				},
				{
					name: "the arrays at 50, 200 and 800 ids",
					gates: ["R22"],
					conditions: conditions({
						workload: "the same join with ids sent as one array",
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
					measures: {
						shapes: Arr.join(shapes, " || "),
						itemRowsReadBySize: sizeRows,
						estimatedInputRowsBySize: estimates
					}
				}
			]
			const r22: VerdictInput = {
				checks: [
					mechanism(
						"the relation parameter is one array per column",
						featureCount(templateShape, "from arrays") === 1 &&
							findNodes(arraysPlan, "ProjectSet").length > 0 &&
							arraysSent.params.length === 1,
						`${arraysSent.params.length} parameters sent\n${outline(arraysPlan, 0)}`
					),
					mechanism(
						"the arrays join probes the keyed relation's index",
						probesKey(arraysPlan),
						outline(arraysPlan, 0)
					),
					mechanism(
						"the input's estimate is its length at every size",
						Arr.every(Arr.zip(sizes, estimates), ([n, estimate]) => n === estimate),
						`${Arr.join(Arr.map(estimates, String), ", ")} estimated for ${Arr.join(Arr.map(sizes, String), ", ")} ids`
					),
					mechanism(
						"the join reads the named rows, not the relation",
						rowsReadFrom(arraysPlan, item) <= distinctIds.length,
						`${rowsReadFrom(arraysPlan, item)} rows for ${distinctIds.length} ids`
					),
					equivalence(
						"the host deduplicates the repeated facts: one row per distinct id",
						viaArrays.rows.length === distinctIds.length,
						`${viaArrays.rows.length} rows for ${distinctIds.length} distinct ids`
					),
					judged(
						"the generated read agrees with the conservative lowering",
						deliveredAgree("ordered"),
						viaArrays.rows,
						viaConservative.rows
					),
					equivalence(
						"the arrays agree with the handwritten VALUES join",
						compareVariants(arraysM, valuesHand).sameResult,
						`${arraysM.result.rows} generated rows, ${valuesHand.result.rows} handwritten`
					),
					equivalence(
						"the arrays agree with the OR tree",
						compareVariants(arraysM, orTree).sameResult,
						`${arraysM.result.rows} generated rows, ${orTree.result.rows} handwritten`
					)
				]
			}
			return { cases, verdicts: { R22: r22 } }
		})
})
