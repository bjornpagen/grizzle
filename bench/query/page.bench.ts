import { Array as Arr, Effect, Option } from "effect"
import type { PlanNode } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	compareVariants,
	measureVariant,
	type VariantOptions,
	type VariantSpec,
	type VariantStatement
} from "#bench/harness/variant.ts"

import {
	Access,
	accessPrograms,
	amountsOf,
	byAmount,
	entriesData,
	loadEntries
} from "#bench/query/access.bench.ts"

import {
	autocommit,
	compile,
	conditions,
	handwritten,
	handwrittenRows,
	headingOf,
	installedIndexes,
	installFixture,
	plainExplain,
	queryPhases,
	rawSession,
	runtimeSession
} from "#bench/query/support/kit.ts"
import { type DeliveredPage, deliverPage, pageRuntime } from "#bench/query/support/page.ts"
import {
	indexAccessOn,
	outline,
	planOf,
	serverStatementPlanOf,
	rowsReadFrom,
	scansOf
} from "#bench/query/support/plans.ts"
import type { BinaryOperator } from "#compiler/sql/ast.ts"
import { identityHooks, transformStatement } from "#compiler/sql/transform.ts"

/**
 * R05: native row seeks for eligible orders.
 *
 * The Access fixture (access.bench.ts): Entry(id, account, kind, amount, code), installed with the same schema, workload
 * and facts. Its pages are requested as the runtime requests them: the page runtime template of the ordered query,
 * each request's flight built by the runtime's own pageFlight from the call, with the boundary texts the runtime
 * receives, and sent on the recording session (support/page.ts). Its own file, so a page failure records R05's verdict
 * alone and never erases R04's, R18's or R39's.
 *
 * - The page after a cursor is a native row comparison in the index condition of the index whose key leads with the
 *   seek's columns, reading the page and its lookahead with no filter, custom and generic alike, where the handwritten
 *   OR expansion filters every entry before the boundary.
 * - A page over a key-dropping projection repeats no answer.
 */
interface Options extends Readonly<Record<string, unknown>> {
	readonly entries: number
	readonly accounts: number
	readonly samples: number
}

/** The rows statement of a delivered page request, run alone as a variant. */
const rowsVariant = (
	role: "generated" | "conservative",
	label: string,
	page: DeliveredPage
): VariantSpec => ({
	role,
	label,
	statements: [page.rows.sent],
	transaction: autocommit,
	decode: { kind: "none" },
	outside: {}
})

/** @internal */
export default defineGate({
	name: "query-page",
	gates: ["R05"],
	title: "Row seeks of keyset pages against the handwritten OR expansion",
	scope:
		"Keyset pages after a cursor of an account's entries by (amount, id), requested through the page runtime, against " +
		"the OR expansion and the handwritten row seek (R05); a page over a key-dropping projection.",
	phases: queryPhases,
	options: {
		full: { entries: 200000, accounts: 200, samples: 20 },
		quick: { entries: 30000, accounts: 30, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Access, accessPrograms, "benchpage", [])
			const size = { entries: options.entries, accounts: options.accounts }
			yield* loadEntries(fx, size)
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b page runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b page raw")
			const entry = fx.relationName("Entry")
			const E = fx.table("Entry")
			const col = (f: string) => fx.column("Entry", f)
			const indexes = yield* installedIndexes(fx)
			const data = entriesData(size)
			const installed =
				"fresh install of Access with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const pageReading = {
				role: fx.world.app,
				context: "snapshot",
				warm: 3,
				read: "page"
			} as const
			const once: VariantOptions = {
				samples: 1,
				warmup: 0,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const cases: Array<CaseRecord<"R05">> = []

			const pageSize = 20
			const account = BigInt(1 + Math.floor(options.accounts / 3))
			const page = compile(fx, byAmount, pageReading)
			const pages = pageRuntime(page)
			const boundary = ["50000", "0"]
			const call = { variant: "after", size: pageSize, boundary } as const
			const after = yield* deliverPage(runtime, pages, "optimized", { account }, call)
			const afterConservative = yield* deliverPage(
				runtime,
				pages,
				"conservative",
				{ account },
				call
			)
			const seek = yield* measureVariant(raw, rowsVariant("generated", "generated after", after), {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: ["generic"]
			})
			const seekConservative = yield* measureVariant(
				raw,
				rowsVariant("conservative", "conservative after", afterConservative),
				once
			)
			const orExpansion: VariantStatement = {
				sql: handwrittenRows(
					headingOf(page),
					`SELECT e.${col("amount")} AS amount, e.${col("id")} AS id FROM ${E} AS e WHERE e.${col("account")} = $1::int8 ` +
						`AND (e.${col("amount")} > $2::int8 OR (e.${col("amount")} = $2::int8 AND e.${col("id")} > $3::int8)) ` +
						`ORDER BY e.${col("amount")}, e.${col("id")} LIMIT ${pageSize + 1}`
				),
				params: [String(account), ...boundary]
			}
			const rowSeek: VariantStatement = {
				sql: handwrittenRows(
					headingOf(page),
					`SELECT e.${col("amount")} AS amount, e.${col("id")} AS id FROM ${E} AS e WHERE e.${col("account")} = $1::int8 ` +
						`AND (e.${col("amount")}, e.${col("id")}) > ($2::int8, $3::int8) ORDER BY e.${col("amount")}, e.${col("id")} LIMIT ${pageSize + 1}`
				),
				params: [String(account), ...boundary]
			}
			const handOptions: VariantOptions = { ...once, samples: options.samples }
			const orM = yield* measureVariant(
				raw,
				handwritten("handwritten OR expansion", [orExpansion], autocommit),
				handOptions
			)
			const rowM = yield* measureVariant(
				raw,
				handwritten("handwritten row seek", [rowSeek], autocommit),
				handOptions
			)
			const seekPlan = planOf(seek, 0)
			const genericSeekPlan = serverStatementPlanOf(seek, "generic", 0)
			const dropped = compile(fx, amountsOf, pageReading)
			const droppedPages = pageRuntime(dropped)
			const droppedCall = { variant: "after", size: pageSize, boundary: ["50000"] } as const
			const droppedOptimized = yield* deliverPage(
				runtime,
				droppedPages,
				"optimized",
				{ account },
				droppedCall
			)
			const droppedAfter = yield* measureVariant(
				raw,
				rowsVariant("generated", "generated after, key dropped", droppedOptimized),
				once
			)
			const droppedConservativeRows = yield* deliverPage(
				runtime,
				droppedPages,
				"conservative",
				{ account },
				droppedCall
			)
			const droppedConservative = yield* measureVariant(
				raw,
				rowsVariant("conservative", "conservative after, key dropped", droppedConservativeRows),
				once
			)
			/** The comparisons of the rows statement's seek: a row value against a row value. */
			const rowComparisons: Array<BinaryOperator> = []
			transformStatement(after.rows.statement.ast, {
				...identityHooks,
				expr: (e) => {
					if (e.kind === "binary" && e.left.kind === "row" && e.right.kind === "row") {
						rowComparisons.push(e.op)
					}
					return e
				}
			})
			const leading = [
				fx.columnName("Entry", "account"),
				fx.columnName("Entry", "amount"),
				fx.columnName("Entry", "id")
			]
			/**
			 * The seek in the index condition of the index whose key begins with (account, amount, id), and no scan of the
			 * entries filtering anything.
			 */
			const seeks = (plan: PlanNode): boolean =>
				Arr.some(
					indexAccessOn(plan, entry, indexes),
					(a) => a.condition === "index cond" && Arr.every(leading, (c, i) => a.columns[i] === c)
				) && Arr.every(scansOf(plan, entry), (n) => Option.isNone(n.filter))
			cases.push(
				{
					name: "the page after (50000, 0) of an account's entries by amount",
					gates: ["R05"],
					conditions: conditions({
						workload:
							"page { first: 20, after } of an account's (id, amount) ordered by amount, id",
						schemaState: installed,
						data,
						parameters: { account: String(account), after: boundary, size: pageSize },
						semantics:
							"the 21 entries (page and lookahead) following the boundary in (amount, id) order",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [seek, seekConservative, orM, rowM],
					comparisons: [compareVariants(seek, orM), compareVariants(seek, rowM)],
					transactions: {},
					loads: {},
					measures: {
						requestStatements: after.statements.length,
						requestFlights: after.flights,
						seekRowsRead: rowsReadFrom(seekPlan, entry),
						orRowsRead: rowsReadFrom(planOf(orM, 0), entry),
						orRowsRemovedByFilter: Arr.reduce(
							scansOf(planOf(orM, 0), entry),
							0,
							(s, n) => s + n.rowsRemovedByFilter * n.actualLoops
						)
					}
				},
				{
					name: "the page after 50000 of an account's amounts, the key dropped",
					gates: ["R05"],
					conditions: conditions({
						workload: "page { first: 20, after } of an account's distinct amounts",
						schemaState: installed,
						data,
						parameters: { account: String(account), after: ["50000"], size: pageSize },
						semantics: "the 21 distinct amounts following 50000",
						cache: "warm: each variant runs once before its timed samples"
					}),
					phases: {},
					variants: [droppedAfter, droppedConservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const r05: VerdictInput = {
				checks: [
					mechanism(
						"the seek is a row comparison in the index condition",
						rowComparisons.includes(">") && seeks(seekPlan),
						`row comparisons: ${Arr.join(rowComparisons, ", ")}\n${outline(seekPlan, 0)}`
					),
					mechanism(
						"the seek reads the page and its lookahead",
						rowsReadFrom(seekPlan, entry) <= pageSize + 1,
						`${rowsReadFrom(seekPlan, entry)} rows`
					),
					mechanism(
						"the generic plan keeps the seek",
						seeks(genericSeekPlan),
						outline(genericSeekPlan, 0)
					),
					equivalence(
						"the generated page equals the conservative page",
						compareVariants(seek, seekConservative).sameResult,
						`${seek.result.rows} generated rows, ${seekConservative.result.rows} conservative`
					),
					equivalence(
						"the generated page equals the OR expansion's",
						compareVariants(seek, orM).sameResult,
						`${seek.result.rows} generated rows, ${orM.result.rows} handwritten`
					),
					equivalence(
						"the generated page equals the handwritten row seek's",
						compareVariants(seek, rowM).sameResult,
						`${seek.result.rows} generated rows, ${rowM.result.rows} handwritten`
					),
					equivalence(
						"a page over a key-dropping projection repeats no answer and equals the conservative page",
						droppedAfter.result.repeated === 0 &&
							compareVariants(droppedAfter, droppedConservative).sameResult,
						`${droppedAfter.result.repeated} repeated of ${droppedAfter.result.rows}; ${droppedConservative.result.rows} conservative`
					)
				]
			}
			return { cases, verdicts: { R05: r05 } }
		})
})
