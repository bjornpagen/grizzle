import { Array as Arr, Effect, Option, Record as Rec } from "effect"
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
	rowsAgree,
	type VariantOptions
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	columnAt,
	compile,
	conditions,
	counterexample,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	type MeasureOptions,
	measureQuery,
	plainExplain,
	queryPhases,
	rawSession,
	textRowsOf,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"

import {
	dedupNodes,
	joinTypes,
	outline,
	planFigures,
	planOf,
	rowsReadFrom,
	scansOf,
	summaryOf
} from "#bench/query/support/plans.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * R01, R02, R03 and R17: fusion, existence, elimination and physical uniqueness.
 *
 * One fixture, Account(id, region) <- Task(id, account, priority, title) <- Note(id, task, text), each reference a
 * containment, so tasks and notes refer to existing rows; Account has a field outside its key (region), so a put at an
 * account's key replaces its row and the Task -> Account foreign key is deferred, which is what lets R03's transaction
 * counterexample exist. Every task in three has
 * two notes, so a note-matching query has duplicate witnesses, and every account has many tasks, so a key-only join has
 * duplicate referring facts. Each gate compares the generated statements, the conservative lowering's (deduplication
 * at every set boundary) and a handwritten fused statement:
 *
 * - R01: an imported filtered stage joined to Account by a selective region parameter fuses into one direct SELECT: no
 *   duplicate-removing node, the same plan as the handwritten join, and fewer task rows read than the conservative
 *   form, which deduplicates the whole child stage before the join. The counterexample the rule names, "removing an
 *   earlier projection changes aggregate contributions", is run as well: a count over a stage that projects the task id
 *   away counts distinct (account, priority) pairs, which the generated statement keeps and a bag count would not.
 * - R02: a match that only tests for a note is EXISTS, a negated one NOT EXISTS: a semi or anti join and
 *   no deduplication, with every task's two notes as duplicate witnesses.
 * - R03: a key-only match of the referenced Account is removed in the snapshot context, where the containment is
 *   valid; a transaction-context template, where the deferred containment can be temporarily false,
 *   keeps it, and so does a match whose region the query filters. The counterexample runs against data:
 *   inside one write transaction the writer deletes an Account its tasks still refer to (an absent witness, which the
 *   deferred foreign key admits until commit, with every other account's many tasks as duplicate referring facts), and
 *   the transaction template agrees with the conservative join there while the snapshot elimination delivers the
 *   dangling tasks; the transaction rolls back. Account is immutable, so a key change is a deletion and an addition, and
 *   the fixture has no alternatives, so no arm switches.
 * - R17: a retained-key projection and a retained-key bounded subset plan with no Unique node, the
 *   bounded subset reading no more Task rows than its bound, beside the handwritten redundant DISTINCT whose Unique node
 *   is the mechanism the rule removes; a projection that drops the key keeps exact deduplication and delivers no
 *   repeated row.
 */
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Task = relation(
	"Task",
	{ id: pg.bigint, account: pg.bigint, priority: pg.integer, title: str.regex("^.{1,80}$", "su") },
	["id"]
)

const Note = relation(
	"Note",
	{ id: pg.bigint, task: pg.bigint, text: str.regex("^.{1,200}$", "su") },
	["id"]
)

const Fusion = schema("Fusion", { Account, Task, Note }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Note, "task"), on(Task, "id"))
])

/** R01: an imported stage of urgent tasks, then the stage joined to Account by region. */
const urgent = query(Fusion).rule((r) => {
	const { id, account, priority } = v(Task, "task")
	return r
		.match(Task, { id, account, priority })
		.where(r.gt(priority, 5))
		.find({ id, account, priority })
})

const urgentInRegion = query(Fusion).rule((r) => {
	const { id, account, priority } = v(urgent, "urgent")
	const { region } = v(Account, "account")
	return r
		.match(urgent, { id, account, priority })
		.match(Account, { id: account, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id, priority })
})

/** R01's counterexample: the imported stage projects the task id away, so a count over it counts priority levels. */
const levels = query(Fusion).rule((r) => {
	const { account, priority } = v(Task, "task")
	return r.match(Task, { account, priority }).find({ account, priority })
})

const levelsInRegion = query(Fusion).rule((r) => {
	const { account, priority } = v(levels, "levels")
	const { region } = v(Account, "account")
	return r
		.match(levels, { account, priority })
		.match(Account, { id: account, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ account, levels: r.count() })
})

/** R02. */
const notedInRegion = query(Fusion).rule((r) => {
	const { id, account } = v(Task, "task")
	const { region } = v(Account, "account")
	return r
		.match(Task, { id, account })
		.match(Account, { id: account, region })
		.match(Note, { task: id })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ id })
})

const unnotedInRegion = query(Fusion).rule((r) => {
	const { id, account } = v(Task, "task")
	const { region } = v(Account, "account")
	return r
		.match(Task, { id, account })
		.match(Account, { id: account, region })
		.where(r.eq(region, r.param("region", pg.integer)), r.not(Note, { task: id }))
		.find({ id })
})

/** R03. */
const tasksAt = query(Fusion).rule((r) => {
	const { id, account, priority } = v(Task, "task")
	return r
		.match(Task, { id, account, priority })
		.match(Account, { id: account })
		.where(r.eq(priority, r.param("p", pg.integer)), r.lt(id, r.param("below", pg.bigint)))
		.find({ id, account })
})

const tasksAtInRegion = query(Fusion).rule((r) => {
	const { id, account, priority } = v(Task, "task")
	const { region } = v(Account, "account")
	return r
		.match(Task, { id, account, priority })
		.match(Account, { id: account, region })
		.where(r.eq(priority, r.param("p", pg.integer)), r.eq(region, r.param("region", pg.integer)))
		.find({ id, account })
})

/** R17. */
const accountTasks = query(Fusion).rule((r) => {
	const { id, priority } = v(Task, "task")
	return r
		.match(Task, { id, account: r.param("account", Task.fields.account), priority })
		.find({ id, priority })
})

const firstAccountTasks = query(Fusion)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
	})
	.orderBy(["id", "asc"])
	.take(10)

const accountPriorities = query(Fusion).rule((r) => {
	const { priority } = v(Task, "task")
	return r
		.match(Task, { account: r.param("account", Task.fields.account), priority })
		.find({ priority })
})

const regionPriorities = query(Fusion).rule((r) => {
	const { account, priority } = v(Task, "task")
	const { region } = v(Account, "account")
	return r
		.match(Task, { account, priority })
		.match(Account, { id: account, region })
		.where(r.eq(region, r.param("region", pg.integer)))
		.find({ region, priority })
})

const programs = {
	urgentInRegion,
	levelsInRegion,
	notedInRegion,
	unnotedInRegion,
	tasksAt,
	tasksAtInRegion,
	accountTasks,
	firstAccountTasks,
	accountPriorities,
	regionPriorities
} as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly accounts: number
	readonly tasksPerAccount: number
	readonly samples: number
}

type Gates = "R01" | "R02" | "R03" | "R17"

/** @internal */
export default defineGate({
	name: "query-fusion",
	gates: ["R01", "R02", "R03", "R17"],
	title: "Fusion, existence, elimination and physical uniqueness against handwritten SQL",
	scope:
		"Reads over a three-level containment chain: an imported filtered stage joined by a selective parameter (R01), " +
		"existence and absence of duplicate witnesses (R02), a key-only reference match in the snapshot and transaction " +
		"contexts (R03), retained-key projections and bounded subsets against key-dropping projections (R17). Each is " +
		"delivered by the runtime as both artifacts and compared with a handwritten statement; plans are structural " +
		"evidence, timings are information.",
	phases: queryPhases,
	options: {
		full: { accounts: 4000, tasksPerAccount: 25, samples: 20 },
		quick: { accounts: 800, tasksPerAccount: 25, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Fusion, programs, "benchfusion", [])
			const tasks = options.accounts * options.tasksPerAccount
			const notes = 2 * Math.floor(tasks / 3)
			yield* fill(fx, "Account", options.accounts, { id: "g::int8", region: "(g % 100)::int4" })
			yield* fill(fx, "Task", tasks, {
				id: "g::int8",
				account: `(1 + (g - 1) / ${options.tasksPerAccount})::int8`,
				priority: "(1 + (g * 7) % 10)::int4",
				title: "'task ' || g"
			})
			yield* fill(fx, "Note", notes, {
				id: "g::int8",
				task: "(3 * ((g + 1) / 2))::int8",
				text: "'note ' || g"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app, "m15b fusion runtime")
			const raw = yield* rawSession(fx, fx.world.app, "m15b fusion raw")
			const task = fx.relationName("Task")
			const account = fx.relationName("Account")
			const note = fx.relationName("Note")
			const T = fx.table("Task")
			const A = fx.table("Account")
			const N = fx.table("Note")
			const c = (rel: string, f: string) => fx.column(rel, f)
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
			const data = `${options.accounts} accounts in 100 regions, ${options.tasksPerAccount} tasks each (priority 1-10 uniform), two notes on every third task`
			const installed =
				"fresh install of Fusion with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []

			/** R01. */
			const fused = compile(fx, urgentInRegion, reading)
			const fusedValues = { region: 7 }
			const fusedM = yield* measureQuery(runtime, raw, fused, fusedValues, measure)
			const fusedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten",
					[
						{
							sql: handwrittenRows(
								headingOf(fused),
								`SELECT t.${c("Task", "id")} AS id, t.${c("Task", "priority")} AS priority FROM ${T} AS t ` +
									`JOIN ${A} AS a ON a.${c("Account", "id")} = t.${c("Task", "account")} ` +
									`WHERE t.${c("Task", "priority")} > 5 AND a.${c("Account", "region")} = $1::int4`
							),
							params: ["7"]
						}
					],
					autocommit
				),
				{ ...handOptions, warmup: 1 }
			)
			const fusedPlan = planOf(fusedM.generated, 0)
			const conservativeFusedPlan = planOf(fusedM.conservative, 0)
			const fusedVsHand = compareVariants(fusedM.generated, fusedHand)
			const counter = compile(fx, levelsInRegion, reading)
			const counterM = yield* measureQuery(runtime, raw, counter, fusedValues, measure)
			const counterHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten count(DISTINCT priority)",
					[
						{
							sql: handwrittenRows(
								headingOf(counter),
								`SELECT t.${c("Task", "account")} AS account, count(DISTINCT t.${c("Task", "priority")}) AS levels ` +
									`FROM ${T} AS t JOIN ${A} AS a ON a.${c("Account", "id")} = t.${c("Task", "account")} ` +
									`WHERE a.${c("Account", "region")} = $1::int4 GROUP BY t.${c("Task", "account")}`
							),
							params: ["7"]
						}
					],
					autocommit
				),
				handOptions
			)
			const counterBag = yield* measureVariant(
				raw,
				counterexample(
					"bag count(*), the rejected rewrite",
					[
						{
							sql: handwrittenRows(
								headingOf(counter),
								`SELECT t.${c("Task", "account")} AS account, count(*) AS levels ` +
									`FROM ${T} AS t JOIN ${A} AS a ON a.${c("Account", "id")} = t.${c("Task", "account")} ` +
									`WHERE a.${c("Account", "region")} = $1::int4 GROUP BY t.${c("Task", "account")}`
							),
							params: ["7"]
						}
					],
					autocommit
				),
				{ ...handOptions, samples: 1 }
			)
			cases.push(
				{
					name: "urgent tasks of one region through an imported stage",
					gates: ["R01"],
					conditions: conditions({
						workload:
							"Task filtered by priority > 5 in an imported stage, joined to Account by region",
						schemaState: installed,
						data,
						parameters: fusedValues,
						semantics: "the set of (id, priority) of urgent tasks of region 7's accounts",
						cache: warm
					}),
					phases: {},
					variants: [fusedM.generated, fusedM.conservative, fusedHand],
					comparisons: [fusedVsHand, compareVariants(fusedM.generated, fusedM.conservative)],
					transactions: {},
					loads: {},
					measures: {
						taskRowsReadGenerated: rowsReadFrom(fusedPlan, task),
						taskRowsReadConservative: rowsReadFrom(conservativeFusedPlan, task),
						...Rec.fromEntries(
							Arr.map(Rec.toEntries(planFigures(fusedM.generated)), ([k, x]) => [
								`generated.${k}`,
								x
							])
						),
						...Rec.fromEntries(
							Arr.map(Rec.toEntries(planFigures(fusedM.conservative)), ([k, x]) => [
								`conservative.${k}`,
								x
							])
						)
					}
				},
				{
					name: "priority levels per account through a key-dropping stage (the counterexample)",
					gates: ["R01"],
					conditions: conditions({
						workload: "a count over an imported stage that projects the task id away",
						schemaState: installed,
						data,
						parameters: fusedValues,
						semantics: "per account of region 7, the number of distinct priorities among its tasks",
						cache: warm
					}),
					phases: {},
					variants: [counterM.generated, counterM.conservative, counterHand, counterBag],
					comparisons: [
						compareVariants(counterM.generated, counterHand),
						compareVariants(counterM.generated, counterBag)
					],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const fusedShape = summaryOf(fusedM.generated, 0).shape
			const handShape = summaryOf(fusedHand, 0).shape
			const r01: VerdictInput = {
				checks: [
					mechanism(
						"the fused statement removes no duplicates",
						dedupNodes(fusedPlan).length === 0,
						outline(fusedPlan, 0)
					),
					mechanism(
						"the fused statement plans as the handwritten join does",
						fusedShape === handShape,
						`${fusedShape} vs ${handShape}`
					),
					mechanism(
						"the fused statement reads fewer task rows than the stage-by-stage form",
						rowsReadFrom(fusedPlan, task) < rowsReadFrom(conservativeFusedPlan, task),
						`${rowsReadFrom(fusedPlan, task)} vs ${rowsReadFrom(conservativeFusedPlan, task)}`
					),
					mechanism(
						"the counterexample's stage keeps its deduplication before the count",
						dedupNodes(planOf(counterM.generated, 0)).length > 0,
						outline(planOf(counterM.generated, 0), 0)
					),
					agrees("generated and conservative deliver the same set", fusedM),
					equivalence(
						"generated and handwritten return the same rows",
						fusedVsHand.sameResult,
						`${fusedM.generated.result.rows} generated rows, ${fusedHand.result.rows} handwritten`
					),
					equivalence(
						"no repeated row",
						fusedM.generated.result.repeated === 0,
						`${fusedM.generated.result.repeated} repeated`
					),
					agrees("the counterexample agrees with the conservative lowering", counterM),
					equivalence(
						"the counterexample agrees with the handwritten distinct count",
						compareVariants(counterM.generated, counterHand).sameResult,
						`${counterM.generated.result.rows} generated rows, ${counterHand.result.rows} handwritten`
					),
					equivalence(
						"the counterexample is live: a bag count differs",
						!compareVariants(counterM.generated, counterBag).sameResult,
						`${counterM.generated.result.rows} generated rows, ${counterBag.result.rows} bag`
					)
				]
			}

			/** R02. */
			const noted = compile(fx, notedInRegion, reading)
			const notedM = yield* measureQuery(runtime, raw, noted, fusedValues, measure)
			const notedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten EXISTS",
					[
						{
							sql: handwrittenRows(
								headingOf(noted),
								`SELECT t.${c("Task", "id")} AS id FROM ${T} AS t JOIN ${A} AS a ON a.${c("Account", "id")} = t.${c("Task", "account")} ` +
									`WHERE a.${c("Account", "region")} = $1::int4 AND EXISTS (SELECT 1 FROM ${N} AS n WHERE n.${c("Note", "task")} = t.${c("Task", "id")})`
							),
							params: ["7"]
						}
					],
					autocommit
				),
				handOptions
			)
			const unnoted = compile(fx, unnotedInRegion, reading)
			const unnotedM = yield* measureQuery(runtime, raw, unnoted, fusedValues, measure)
			const unnotedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten NOT EXISTS",
					[
						{
							sql: handwrittenRows(
								headingOf(unnoted),
								`SELECT t.${c("Task", "id")} AS id FROM ${T} AS t JOIN ${A} AS a ON a.${c("Account", "id")} = t.${c("Task", "account")} ` +
									`WHERE a.${c("Account", "region")} = $1::int4 AND NOT EXISTS (SELECT 1 FROM ${N} AS n WHERE n.${c("Note", "task")} = t.${c("Task", "id")})`
							),
							params: ["7"]
						}
					],
					autocommit
				),
				handOptions
			)
			const notedPlan = planOf(notedM.generated, 0)
			const unnotedPlan = planOf(unnotedM.generated, 0)
			cases.push(
				{
					name: "tasks of one region with a note (duplicate witnesses)",
					gates: ["R02"],
					conditions: conditions({
						workload:
							"Task joined to Account by region, matching Note on the task without binding it",
						schemaState: installed,
						data,
						parameters: fusedValues,
						semantics: "the ids of region 7's tasks that have at least one note",
						cache: warm
					}),
					phases: {},
					variants: [notedM.generated, notedM.conservative, notedHand],
					comparisons: [compareVariants(notedM.generated, notedHand)],
					transactions: {},
					loads: {},
					measures: {
						noteRowsReadGenerated: rowsReadFrom(notedPlan, note),
						noteRowsReadConservative: rowsReadFrom(planOf(notedM.conservative, 0), note)
					}
				},
				{
					name: "tasks of one region without a note",
					gates: ["R02"],
					conditions: conditions({
						workload: "Task joined to Account by region, with r.not(Note, { task })",
						schemaState: installed,
						data,
						parameters: fusedValues,
						semantics: "the ids of region 7's tasks that have no note",
						cache: warm
					}),
					phases: {},
					variants: [unnotedM.generated, unnotedM.conservative, unnotedHand],
					comparisons: [compareVariants(unnotedM.generated, unnotedHand)],
					transactions: {},
					loads: {},
					measures: { noteRowsReadGenerated: rowsReadFrom(unnotedPlan, note) }
				}
			)
			const r02: VerdictInput = {
				checks: [
					mechanism(
						"the unbound Note match reads one witness per delivered task",
						rowsReadFrom(notedPlan, note) <= notedM.delivered.generated.rows.length,
						`${rowsReadFrom(notedPlan, note)} note rows read for ${notedM.delivered.generated.rows.length} tasks; ` +
							`handwritten EXISTS reads ${rowsReadFrom(planOf(notedHand, 0), note)}\n${outline(notedPlan, 0)}`
					),
					mechanism(
						"absence plans as an anti join",
						Arr.some(joinTypes(unnotedPlan), (j) => j === "Anti" || j === "Right Anti"),
						outline(unnotedPlan, 0)
					),
					mechanism(
						"neither multiplies witnesses into a deduplication",
						dedupNodes(notedPlan).length === 0 && dedupNodes(unnotedPlan).length === 0,
						`${outline(notedPlan, 0)}\n${outline(unnotedPlan, 0)}`
					),
					agrees("existence agrees with the conservative join", notedM),
					equivalence(
						"existence agrees with handwritten EXISTS",
						compareVariants(notedM.generated, notedHand).sameResult,
						`${notedM.generated.result.rows} generated rows, ${notedHand.result.rows} handwritten`
					),
					agrees("absence agrees with the conservative form", unnotedM),
					equivalence(
						"absence agrees with handwritten NOT EXISTS",
						compareVariants(unnotedM.generated, unnotedHand).sameResult,
						`${unnotedM.generated.result.rows} generated rows, ${unnotedHand.result.rows} handwritten`
					),
					equivalence(
						"no repeated row",
						notedM.generated.result.repeated === 0 && unnotedM.generated.result.repeated === 0,
						`${notedM.generated.result.repeated} and ${unnotedM.generated.result.repeated} repeated`
					)
				]
			}

			const r03Values = { p: 3, below: BigInt(Math.floor(tasks / 4)) }
			const eliminated = compile(fx, tasksAt, reading)
			const eliminatedM = yield* measureQuery(runtime, raw, eliminated, r03Values, measure)
			const eliminatedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten, Task alone",
					[
						{
							sql: handwrittenRows(
								headingOf(eliminated),
								`SELECT t.${c("Task", "id")} AS id, t.${c("Task", "account")} AS account FROM ${T} AS t ` +
									`WHERE t.${c("Task", "priority")} = $1::int4 AND t.${c("Task", "id")} < $2::int8`
							),
							params: ["3", String(r03Values.below)]
						}
					],
					autocommit
				),
				handOptions
			)
			const inTransaction = compile(fx, tasksAt, { ...reading, context: "transaction" })
			const inTransactionM = yield* measureQuery(runtime, raw, inTransaction, r03Values, measure)
			const filtered = compile(fx, tasksAtInRegion, reading)
			const filteredM = yield* measureQuery(runtime, raw, filtered, { p: 3, region: 7 }, measure)
			const eliminatedPlan = planOf(eliminatedM.generated, 0)
			/**
			 * The deferred-law transaction state: inside one write transaction the writer deletes an Account its tasks still
			 * refer to, which the deferred Task -> Account foreign key admits until commit, so the containment the snapshot
			 * elimination relies on is false. In that same transaction the transaction-context template and the conservative
			 * lowering both leave the dangling tasks out (an absent witness), and the snapshot template's eliminated statement,
			 * which reads Task alone, keeps them: the counterexample is live. The transaction rolls back.
			 */
			const accountAt = columnAt(eliminated, "account")
			const snapshotRows = yield* textRowsOf(raw, eliminatedM.delivered.generated.statements)
			const danglingAccount = snapshotRows[0]?.[accountAt]
			if (danglingAccount === null || danglingAccount === undefined) {
				throw new GateSetupError({ what: "the snapshot read delivered no task with an account" })
			}
			const dangling = Arr.filter(snapshotRows, (r) => r[accountAt] === danglingAccount)
			const writer = yield* rawSession(fx, fx.world.app, "m15b fusion writer")
			yield* writer.begin
			const deleted = yield* writer.values(
				`DELETE FROM ${A} WHERE ${c("Account", "id")} = $1::int8 RETURNING ${c("Account", "id")}::text`,
				[danglingAccount]
			)
			const brokenTransaction = yield* textRowsOf(
				writer,
				inTransactionM.delivered.generated.statements
			)
			const brokenConservative = yield* textRowsOf(
				writer,
				inTransactionM.delivered.conservative.statements
			)
			const brokenSnapshot = yield* textRowsOf(writer, eliminatedM.delivered.generated.statements)
			yield* writer.rollback
			const transactionVsConservative = rowsAgree(brokenTransaction, brokenConservative)
			/** The snapshot elimination delivers exactly the conservative answer and the dangling tasks. */
			const snapshotVsDangling = rowsAgree(brokenSnapshot, [...brokenConservative, ...dangling])
			cases.push(
				{
					name: "tasks at a priority with a key-only Account match, snapshot context",
					gates: ["R03"],
					conditions: conditions({
						workload: "Task matched to Account by key only, filtered by priority and an id bound",
						schemaState: installed,
						data,
						parameters: { p: 3, below: String(r03Values.below) },
						semantics: "the (id, account) of tasks at priority 3 below the id bound",
						cache: warm
					}),
					phases: {},
					variants: [eliminatedM.generated, eliminatedM.conservative, eliminatedHand],
					comparisons: [compareVariants(eliminatedM.generated, eliminatedHand)],
					transactions: {},
					loads: {},
					measures: {
						accountScansGenerated: scansOf(eliminatedPlan, account).length,
						accountRowsReadConservative: rowsReadFrom(planOf(eliminatedM.conservative, 0), account)
					}
				},
				{
					name: "the same query compiled for a transaction, whose deferred containment can be false",
					gates: ["R03"],
					conditions: conditions({
						workload: "the same query, template context `transaction`",
						schemaState: installed,
						data,
						parameters: { p: 3, below: String(r03Values.below) },
						semantics: "the same set",
						cache: warm
					}),
					phases: {},
					variants: [inTransactionM.generated, inTransactionM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						accountScansTransaction: scansOf(planOf(inTransactionM.generated, 0), account).length
					}
				},
				{
					name: "the same reads inside a write transaction that deleted a referenced Account (the counterexample)",
					gates: ["R03"],
					conditions: conditions({
						workload:
							"as the writer, DELETE of an Account its tasks refer to under the deferred foreign key, then the " +
							"transaction template, the conservative lowering and the snapshot template's eliminated statement " +
							"in the same transaction, rolled back",
						schemaState: installed,
						data,
						parameters: { p: 3, below: String(r03Values.below), deletedAccount: danglingAccount },
						semantics:
							"the (id, account) of tasks at priority 3 below the bound whose account exists",
						cache: "each statement runs once"
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						danglingTasks: dangling.length,
						transactionRows: brokenTransaction.length,
						conservativeRows: brokenConservative.length,
						snapshotRows: brokenSnapshot.length
					}
				},
				{
					name: "tasks at a priority whose Account match also filters the region",
					gates: ["R03"],
					conditions: conditions({
						workload: "Task matched to Account by key and filtered by the account's region",
						schemaState: installed,
						data,
						parameters: { p: 3, region: 7 },
						semantics: "the (id, account) of region 7's tasks at priority 3",
						cache: warm
					}),
					phases: {},
					variants: [filteredM.generated],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						accountScansFiltered: scansOf(planOf(filteredM.generated, 0), account).length
					}
				}
			)
			const r03: VerdictInput = {
				checks: [
					mechanism(
						"the snapshot statement reads no Account row",
						scansOf(eliminatedPlan, account).length === 0,
						outline(eliminatedPlan, 0)
					),
					mechanism(
						"the transaction statement keeps the match of the deferred containment",
						scansOf(planOf(inTransactionM.generated, 0), account).length > 0,
						outline(planOf(inTransactionM.generated, 0), 0)
					),
					mechanism(
						"a match that filters the referenced relation is kept",
						scansOf(planOf(filteredM.generated, 0), account).length > 0,
						outline(planOf(filteredM.generated, 0), 0)
					),
					agrees("the eliminated form agrees with the conservative join", eliminatedM),
					equivalence(
						"the eliminated form agrees with handwritten Task alone",
						compareVariants(eliminatedM.generated, eliminatedHand).sameResult,
						`${eliminatedM.generated.result.rows} generated rows, ${eliminatedHand.result.rows} handwritten`
					),
					agrees("the transaction form agrees with the conservative join", inTransactionM),
					equivalence(
						"with the deferred containment broken, the transaction form agrees with the conservative join",
						deleted.length === 1 && Option.isNone(transactionVsConservative),
						`${deleted.length} account deleted; ${Option.getOrElse(transactionVsConservative, () => "agree")}`
					),
					equivalence(
						"the counterexample is live: the snapshot elimination delivers the dangling tasks",
						dangling.length > 0 && Option.isNone(snapshotVsDangling),
						`${dangling.length} tasks of account ${danglingAccount}; ${Option.getOrElse(snapshotVsDangling, () => "the conservative rows and exactly them")}`
					),
					agrees("the filtered form agrees with the conservative join", filteredM)
				]
			}

			/** R17. */
			const accountValues = { account: BigInt(Math.floor(options.accounts / 2)) }
			const keyed = compile(fx, accountTasks, reading)
			const keyedM = yield* measureQuery(runtime, raw, keyed, accountValues, measure)
			const page = compile(fx, firstAccountTasks, reading)
			const pageM = yield* measureQuery(runtime, raw, page, accountValues, measure)
			const dropped = compile(fx, accountPriorities, reading)
			const droppedM = yield* measureQuery(runtime, raw, dropped, accountValues, measure)
			const fanout = compile(fx, regionPriorities, reading)
			const fanoutM = yield* measureQuery(runtime, raw, fanout, fusedValues, measure)
			const pagePlan = planOf(pageM.generated, 0)
			const pageSql = (distinct: boolean) =>
				handwrittenRows(
					headingOf(page),
					`SELECT ${distinct ? "DISTINCT " : ""}t.${c("Task", "id")} AS id FROM ${T} AS t WHERE t.${c("Task", "account")} = $1::int8 ` +
						`ORDER BY t.${c("Task", "id")} LIMIT 10`
				)
			const pageHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten",
					[{ sql: pageSql(false), params: [String(accountValues.account)] }],
					autocommit
				),
				{ ...handOptions, warmup: 1 }
			)
			/**
			 * The redundant DISTINCT a key-blind lowering would emit, whose Unique node beside the Limit is what R17 removes: a
			 * baseline for the measures.
			 */
			const pageDistinct = yield* measureVariant(
				raw,
				handwritten(
					"handwritten redundant DISTINCT",
					[{ sql: pageSql(true), params: [String(accountValues.account)] }],
					autocommit
				),
				{ ...handOptions, warmup: 1 }
			)
			const pageDistinctPlan = planOf(pageDistinct, 0)
			/**
			 * firstAccountTasks' take(10), of an account's 25 tasks: a plan that reads them all to cut the first ten exceeds it.
			 */
			const pageBound = 10
			cases.push(
				{
					name: "an account's tasks with their key retained",
					gates: ["R17"],
					conditions: conditions({
						workload: "Task by account parameter, delivering (id, priority)",
						schemaState: installed,
						data,
						parameters: { account: String(accountValues.account) },
						semantics: "the set of the account's (id, priority)",
						cache: warm
					}),
					phases: {},
					variants: [keyedM.generated, keyedM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: { dedupNodesGenerated: dedupNodes(planOf(keyedM.generated, 0)).length }
				},
				{
					name: "the first ten of an account's tasks by id",
					gates: ["R17"],
					conditions: conditions({
						workload: "take(10) by id of an account's task ids",
						schemaState: installed,
						data,
						parameters: { account: String(accountValues.account) },
						semantics: "the ten least task ids of the account",
						cache: warm
					}),
					phases: {},
					variants: [pageM.generated, pageM.conservative, pageHand, pageDistinct],
					comparisons: [
						compareVariants(pageM.generated, pageHand),
						compareVariants(pageM.generated, pageDistinct)
					],
					transactions: {},
					loads: {},
					measures: {
						dedupNodesPage: dedupNodes(pagePlan).length,
						dedupNodesRedundantDistinct: dedupNodes(pageDistinctPlan).length
					}
				},
				{
					name: "an account's priorities, the task key dropped",
					gates: ["R17"],
					conditions: conditions({
						workload: "Task by account parameter, delivering priority only",
						schemaState: installed,
						data,
						parameters: { account: String(accountValues.account) },
						semantics: "the set of priorities among the account's tasks",
						cache: warm
					}),
					phases: {},
					variants: [droppedM.generated, droppedM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				},
				{
					name: "region priorities, parent-only fanout",
					gates: ["R17"],
					conditions: conditions({
						workload: "Task joined to Account by region, delivering (region, priority)",
						schemaState: installed,
						data,
						parameters: fusedValues,
						semantics: "the set of (region, priority) pairs of region 7",
						cache: warm
					}),
					phases: {},
					variants: [fanoutM.generated, fanoutM.conservative],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {}
				}
			)
			const r17: VerdictInput = {
				checks: [
					mechanism(
						"a retained-key projection has no duplicate-removing node",
						dedupNodes(planOf(keyedM.generated, 0)).length === 0,
						outline(planOf(keyedM.generated, 0), 0)
					),
					mechanism(
						"a retained-key bounded subset reads no more Task rows than its bound, with no Unique node",
						rowsReadFrom(pagePlan, task) <= pageBound && dedupNodes(pagePlan).length === 0,
						`${rowsReadFrom(pagePlan, task)} Task rows read for take(${pageBound})\n${outline(pagePlan, 0)}`
					),
					mechanism(
						"a projection that drops the key keeps exact deduplication",
						dedupNodes(planOf(droppedM.generated, 0)).length > 0,
						outline(planOf(droppedM.generated, 0), 0)
					),
					mechanism(
						"parent-only fanout keeps exact deduplication",
						dedupNodes(planOf(fanoutM.generated, 0)).length > 0,
						outline(planOf(fanoutM.generated, 0), 0)
					),
					agrees("the retained-key projection agrees with the conservative form", keyedM),
					agrees("the bounded subset agrees with the conservative form", pageM),
					equivalence(
						"the bounded subset agrees with the handwritten Limit",
						compareVariants(pageM.generated, pageHand).sameResult,
						`${pageM.generated.result.rows} generated rows, ${pageHand.result.rows} handwritten`
					),
					equivalence(
						"the bounded subset agrees with the handwritten redundant DISTINCT",
						compareVariants(pageM.generated, pageDistinct).sameResult,
						`${pageM.generated.result.rows} generated rows, ${pageDistinct.result.rows} handwritten`
					),
					agrees("the key-dropping projection agrees with the conservative form", droppedM),
					agrees("the fanout agrees with the conservative form", fanoutM),
					equivalence(
						"no delivered answer repeats",
						Arr.every([keyedM, pageM, droppedM, fanoutM], (m) => m.generated.result.repeated === 0),
						Arr.join(
							Arr.map([keyedM, pageM, droppedM, fanoutM], (m) =>
								String(m.generated.result.repeated)
							),
							", "
						)
					)
				]
			}
			return { cases, verdicts: { R01: r01, R02: r02, R03: r03, R17: r17 } }
		})
})
