import { exact, ordered, set } from "@grizzle/testing/oracle"
import { Array as Arr, Effect, Option, Order, Predicate } from "effect"
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
	type TextRow,
	type VariantOptions
} from "#bench/harness/variant.ts"

import {
	agrees,
	autocommit,
	type Compiled,
	compile,
	conditions,
	deliveredAgree,
	fill,
	GateSetupError,
	handwritten,
	handwrittenRows,
	headingOf,
	installFixture,
	judged,
	type MeasureOptions,
	measureQuery,
	optimizedStatement,
	plainExplain,
	queryPhases,
	rawSession,
	readSnapshot,
	textRowsOf,
	runtimeSession,
	settle
} from "#bench/query/support/kit.ts"
import { dedupNodes, plansOf, summaryOf } from "#bench/query/support/plans.ts"
import * as Engine from "#compiler/core/result.ts"
import { flight } from "#compiler/lower/conservative/types.ts"
import { queryInput } from "#compiler/program/compile.ts"
import { templateFor } from "#compiler/program/template.ts"
import { closedId, pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, contained, key, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { schemaInputOf, testArtifacts } from "#test/support/compile.ts"
import { has, shapeOf } from "#test/support/kernel/shape.ts"

/**
 * R21 and R25: heterogeneous unions by heading group, and sub-queries shared across the statements of one snapshot
 * (R25).
 *
 * - R21 (:255): "for a delivered union, round trips equal one per union regardless of group count and each group's
 *   plan is the plan the group would have alone; for a consumed union, the result equals the merge of the per-group
 *   bounded statements." A union of open tasks (id, kind, title) and done tasks with their memo (id, kind, text), a
 *   task having at most one memo, is delivered as one statement per heading group, each compared with the same arm
 *   compiled alone; bounded by take(10) it is delivered per group and merged by the runtime, and consumed by another
 *   query it is lowered in SQL as a UNION ALL of the common fields, a LIMIT and a join back. Never one padded
 *   statement. The groups go in one flight of one SERIALIZABLE READ ONLY transaction, so a delivered union is one
 *   round trip whatever its group count (packages/grizzle/src/adapter/wire/batch.ts).
 *   The order of a heterogeneous union is on its common fields, the discriminant completing ties across arms, and "if
 *   the fields common to every arm hold no key, completion is refused with UnsupportedOperation": the
 *   bounded union is over memos, so (id, kind) is a key of every arm, and the same union over notes, of which a task
 *   may have several, is the take the compiler must refuse.
 * - R25 (contract): the feeding rule computes identical sub-queries over the same feeding statements once, by
 *   the first statement, and feeds the others; two identical pipelined attachments of one parent are such a pair. The
 *   statements the runtime sends and their cost are measured against the shared form.
 * The handwritten baselines: the delivered union as one statement per heading group, each the
 * arm's direct keyed scan; the consumed bound as the union's own tuples, one per (id, 'Open', title) and one per (id,
 * 'Done', text), ordered by the completed order (the common id, then the discriminant in roster order), limited to ten, then their ids; and the shared attachments as the parent statement and one child
 * statement joined to the parent's predicate, whose rows feed both names. Every even task has a memo, so some done
 * tasks have one and some none. Notes are spread pseudo-randomly over the tasks, so some tasks have several: the
 * union over notes has no key in its common fields.
 */
const Kind = closed("Kind", ["Open", "Done", "Held"])
const Account = relation("Account", { id: pg.bigint, region: pg.integer }, ["id"])
const Task = relation(
	"Task",
	{
		id: pg.bigint,
		account: pg.bigint,
		kind: closedId(Kind),
		title: str.regex("^.{1,80}$", "su"),
		priority: pg.integer,
		due: pg.integer
	},
	["id"]
)

const Note = relation(
	"Note",
	{ id: pg.bigint, task: pg.bigint, text: str.regex("^.{1,200}$", "su") },
	["id"]
)

/** At most one memo per task: `task` is a key. */
const Memo = relation(
	"Memo",
	{ id: pg.bigint, task: pg.bigint, text: str.regex("^.{1,200}$", "su") },
	["id"]
)

const Unions = schema("Unions", { Kind, Account, Task, Note, Memo }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Note, "task"), on(Task, "id")),
	contained(on(Memo, "task"), on(Task, "id")),
	key(on(Memo, "task"))
])

const openArm = query(Unions).rule((r) => {
	const { id, account, title } = v(Task, "task")
	return r
		.match(Task, { id, account, kind: "Open", title })
		.where(r.eq(account, r.param("account", pg.bigint)))
		.find({ id, kind: Kind.handle("Open"), title })
})

const doneArm = query(Unions).rule((r) => {
	const { id, account } = v(Task, "task")
	const { text } = v(Memo, "memo")
	return r
		.match(Task, { id, account, kind: "Done" })
		.match(Memo, { task: id, text })
		.where(r.eq(account, r.param("account", pg.bigint)))
		.find({ id, kind: Kind.handle("Done"), text })
})

/** The heterogeneous union of the two arms, discriminated by kind. */
const activity = query(Unions)
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, kind: "Open", title })
			.where(r.eq(account, r.param("account", pg.bigint)))
			.find({ id, kind: Kind.handle("Open"), title })
	})
	.rule((r) => {
		const { id, account } = v(Task, "task")
		const { text } = v(Memo, "memo")
		return r
			.match(Task, { id, account, kind: "Done" })
			.match(Memo, { task: id, text })
			.where(r.eq(account, r.param("account", pg.bigint)))
			.find({ id, kind: Kind.handle("Done"), text })
	})
const firstActivity = activity.orderBy(["id", "asc"]).take(10)
/**
 * The same bound over notes: a done task with several notes is several tuples with one (id, kind), so the common fields
 * hold no key and completion is refused. Not in the workload: it must not compile.
 */
const noteActivity = query(Unions)
	.rule((r) => {
		const { id, account, title } = v(Task, "task")
		return r
			.match(Task, { id, account, kind: "Open", title })
			.where(r.eq(account, r.param("account", pg.bigint)))
			.find({ id, kind: Kind.handle("Open"), title })
	})
	.rule((r) => {
		const { id, account } = v(Task, "task")
		const { text } = v(Note, "note")
		return r
			.match(Task, { id, account, kind: "Done" })
			.match(Note, { task: id, text })
			.where(r.eq(account, r.param("account", pg.bigint)))
			.find({ id, kind: Kind.handle("Done"), text })
	})
	.orderBy(["id", "asc"])
	.take(10)

/** The bounded union consumed by another query: the ids of the first ten. */
const firstIds = query(Unions).rule((r) => {
	const first = firstActivity.bind({ account: r.param("account", pg.bigint) })
	const { id } = v(first, "first")
	return r.match(first, { id }).find({ id })
})

/** R25: two identical pipelined attachments of one parent. */
const twice = query(Unions)
	.rule((r) => {
		const { id, region } = v(Account, "account")
		return r
			.match(Account, { id, region })
			.where(r.eq(region, r.param("region", pg.integer)))
			.find({ id })
	})
	.attach(
		"tasks",
		(a) =>
			query(Unions).rule((r) => {
				const { id, kind, title, priority, due } = v(Task, "task")
				return r
					.match(Task, { id, account: a.id, kind, title, priority, due })
					.find({ id, kind, title, priority, due })
			}),
		"array"
	)
	.attach(
		"again",
		(a) =>
			query(Unions).rule((r) => {
				const { id, kind, title, priority, due } = v(Task, "task")
				return r
					.match(Task, { id, account: a.id, kind, title, priority, due })
					.find({ id, kind, title, priority, due })
			}),
		"array"
	)

const programs = { openArm, doneArm, activity, firstActivity, firstIds, twice } as const

interface Options extends Readonly<Record<string, unknown>> {
	readonly accounts: number
	readonly tasksPerAccount: number
	readonly samples: number
}

type Gates = "R21" | "R25"

/** The heading-group statements of a compiled read's optimized artifact. */
const groupStatements = (compiled: Compiled) =>
	Arr.filter(
		flight(compiled.compiled.template.programs.optimized.roots),
		(s) => s.role.kind === "headingGroup"
	)

/** A heading's column names, sorted: what a statement delivers, whatever the column order. */
const headingNames = (heading: ReadonlyArray<{ readonly name: string }>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(heading, (c) => c.name),
		Order.String
	)

/** The ids of delivered rows, each as its decimal text. */
const idsOf = (rows: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.map(rows, (row) => {
		if (!Predicate.hasProperty(row, "id") || typeof row.id !== "bigint") {
			throw new GateSetupError({ what: "a delivered row without its bigint id" })
		}
		return String(row.id)
	})

const asRows = (ids: ReadonlyArray<string>): ReadonlyArray<TextRow> => Arr.map(ids, (id) => [id])

/** @internal */
export default defineGate({
	name: "query-union",
	gates: ["R21", "R25"],
	title: "Heterogeneous unions by heading group and sub-queries shared in one snapshot",
	scope:
		"A two-group heterogeneous union delivered, bounded and consumed (R21), each group against its arm alone; two " +
		"identical pipelined attachments of one parent (R25). Reads are one flight.",
	phases: queryPhases,
	options: {
		full: { accounts: 2000, tasksPerAccount: 40, samples: 15 },
		quick: { accounts: 300, tasksPerAccount: 40, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const fx = yield* installFixture(Unions, programs, "benchunion", [])
			const tasks = options.accounts * options.tasksPerAccount
			const kind = (handle: string) => fx.handle("Kind", handle)
			yield* fill(fx, "Account", options.accounts, { id: "g::int8", region: "(g % 50)::int4" })
			yield* fill(fx, "Task", tasks, {
				id: "g::int8",
				account: `(1 + (g - 1) / ${options.tasksPerAccount})::int8`,
				kind: `(ARRAY[${kind("Open")}, ${kind("Done")}, ${kind("Held")}])[1 + g % 3]`,
				title: "'task ' || g",
				priority: "(g % 10)::int4",
				due: "(g % 365)::int4"
			})
			yield* fill(fx, "Note", tasks, {
				id: "g::int8",
				task: `(1 + (pg_catalog.hashint8(g) & 2147483647) % ${tasks})::int8`,
				text: "'note ' || g"
			})
			yield* fill(fx, "Memo", Math.floor(tasks / 2), {
				id: "g::int8",
				task: "(2 * g)::int8",
				text: "'memo ' || g"
			})
			yield* settle(fx)
			const runtime = yield* runtimeSession(fx, fx.world.app)
			const raw = yield* rawSession(fx, fx.world.app, "m15b union raw")
			const data = `${options.accounts} accounts in 50 regions, ${options.tasksPerAccount} tasks each cycling Open, Done, Held, a memo for every even task, ${tasks} notes spread pseudo-randomly over the tasks (some tasks with several, some with none)`
			const account = BigInt(Math.floor(options.accounts / 2))
			const reading = { role: fx.world.app, context: "snapshot", warm: 3, read: "rows" } as const
			const measure: MeasureOptions = {
				samples: options.samples,
				explainSamples: 1,
				serverPlans: [],
				explain: plainExplain,
				conservativeSamples: 1
			}
			const handOptions: VariantOptions = {
				samples: options.samples,
				warmup: 1,
				explainSamples: 1,
				explain: plainExplain,
				serverPlans: []
			}
			const installed =
				"fresh install of Unions with its workload's access paths; facts loaded, then VACUUM (ANALYZE) of every table"
			const warm = "warm: each variant runs once before its timed samples"
			const cases: Array<CaseRecord<Gates>> = []
			const T = fx.table("Task")
			const M = fx.table("Memo")
			const A = fx.table("Account")
			const tc = (f: string) => fx.column("Task", f)
			const mc = (f: string) => fx.column("Memo", f)
			const ac = (f: string) => fx.column("Account", f)
			const openSql = `SELECT t.${tc("id")} AS id, ${kind("Open")} AS kind, t.${tc("title")} AS title FROM ${T} AS t WHERE t.${tc("account")} = $1::bigint AND t.${tc("kind")} = ${kind("Open")}`
			const doneSql = `SELECT t.${tc("id")} AS id, ${kind("Done")} AS kind, m.${mc("text")} AS text FROM ${T} AS t JOIN ${M} AS m ON m.${mc("task")} = t.${tc("id")} WHERE t.${tc("account")} = $1::bigint AND t.${tc("kind")} = ${kind("Done")}`

			/** R21, delivered. */
			const union = compile(fx, activity, reading)
			const unionM = yield* measureQuery(runtime, raw, union, { account }, measure)
			const open = compile(fx, openArm, reading)
			const openM = yield* measureQuery(runtime, raw, open, { account }, { ...measure, samples: 1 })
			const done = compile(fx, doneArm, reading)
			const doneM = yield* measureQuery(runtime, raw, done, { account }, { ...measure, samples: 1 })
			const groupShapes = Arr.map(unionM.generated.plans, (p) => p.shape)
			const aloneShapes = [summaryOf(openM.generated, 0).shape, summaryOf(doneM.generated, 0).shape]
			const groupRows = yield* textRowsOf(raw, unionM.delivered.generated.statements)
			const unionHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten: one keyed scan per heading group",
					[
						{ sql: handwrittenRows(headingOf(open), openSql), params: [String(account)] },
						{ sql: handwrittenRows(headingOf(done), doneSql), params: [String(account)] }
					],
					readSnapshot
				),
				handOptions
			)
			const unionVersusHand = compareVariants(unionM.generated, unionHand)
			/**
			 * Each heading group's statement delivers exactly its arm's heading, as the arm compiled alone does: no group
			 * carries another's columns.
			 */
			const groupHeadings = Arr.map(groupStatements(union), (g) => headingNames(g.heading))
			const armHeadings = Arr.map([open, done], (arm) =>
				headingNames(optimizedStatement(arm, 0).heading)
			)
			const unpadded = set(ordered(exact))(groupHeadings, armHeadings)
			/** R21, bounded and consumed. */
			const bounded = compile(fx, firstActivity, reading)
			const boundedM = yield* measureQuery(runtime, raw, bounded, { account }, measure)
			const consumed = compile(fx, firstIds, reading)
			const consumedM = yield* measureQuery(runtime, raw, consumed, { account }, measure)
			const mergedIds = asRows([...new Set(idsOf(boundedM.delivered.generated.rows))])
			const consumedIds = asRows(idsOf(consumedM.delivered.generated.rows))
			const boundedGroups = Arr.map(groupStatements(bounded), (g) => shapeOf(g.ast))
			const consumedStatements = flight(consumed.compiled.template.programs.optimized.roots)
			const consumedShape = shapeOf(optimizedStatement(consumed, 0).ast)
			const consumedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten: the union's first ten tuples, then their ids",
					[
						{
							sql: handwrittenRows(
								headingOf(consumed),
								`SELECT DISTINCT f.id FROM (SELECT u.id FROM (` +
									`SELECT t.${tc("id")} AS id, t.${tc("kind")} AS kind, t.${tc("title")} AS own FROM ${T} AS t ` +
									`WHERE t.${tc("account")} = $1::bigint AND t.${tc("kind")} = ${kind("Open")} ` +
									`UNION ALL SELECT t.${tc("id")}, t.${tc("kind")}, m.${mc("text")} FROM ${T} AS t ` +
									`JOIN ${M} AS m ON m.${mc("task")} = t.${tc("id")} ` +
									`WHERE t.${tc("account")} = $1::bigint AND t.${tc("kind")} = ${kind("Done")}` +
									`) AS u ORDER BY u.id, u.kind LIMIT 10) AS f`
							),
							params: [String(account)]
						}
					],
					autocommit
				),
				handOptions
			)
			const consumedVersusHand = compareVariants(consumedM.generated, consumedHand)
			/** A bound over a union whose common fields hold no key is refused. */
			const appInput = schemaInputOf(fx.world.app)
			const noteBound = Engine.flatMap(testArtifacts(appInput, fx.naming), (artifacts) =>
				Engine.flatMap(queryInput(noteActivity), (input) =>
					templateFor(input, appInput, artifacts, {
						context: "snapshot",
						read: "rows"
					})
				)
			)
			cases.push(
				{
					name: "an account's open tasks and done tasks with notes, delivered by heading group",
					gates: ["R21"],
					conditions: conditions({
						workload: "a union of two arms of different headings, discriminated by kind",
						schemaState: installed,
						data,
						parameters: { account: String(account) },
						semantics: "the account's open tasks with their titles and done tasks with each note",
						cache: warm
					}),
					phases: {},
					variants: [
						unionM.generated,
						unionM.conservative,
						openM.generated,
						doneM.generated,
						unionHand
					],
					comparisons: [unionVersusHand],
					transactions: {},
					loads: {},
					measures: {
						statements: unionM.delivered.generated.statements.length,
						groups: groupHeadings.length,
						groupRows: groupRows.length
					}
				},
				{
					name: "the first ten of the union by id, delivered and consumed",
					gates: ["R21"],
					conditions: conditions({
						workload:
							"take(10) by id of the union, delivered per group and merged; and matched by another query",
						schemaState: installed,
						data,
						parameters: { account: String(account) },
						semantics: "the activity rows of the first ten (id, kind, ...) tuples, and their ids",
						cache: warm
					}),
					phases: {},
					variants: [
						boundedM.generated,
						boundedM.conservative,
						consumedM.generated,
						consumedM.conservative,
						consumedHand
					],
					comparisons: [consumedVersusHand],
					transactions: {},
					loads: {},
					measures: { boundedStatements: boundedM.delivered.generated.statements.length }
				}
			)
			const r21: VerdictInput = {
				checks: [
					mechanism(
						"a delivered union is one round trip, its groups in one flight, bounded or not",
						unionM.delivered.generated.flights === 1 && boundedM.delivered.generated.flights === 1,
						`${unionM.delivered.generated.flights} and ${boundedM.delivered.generated.flights} flights`
					),
					mechanism(
						"one statement per heading group, none padded",
						unionM.delivered.generated.statements.length === 2 &&
							groupHeadings.length === 2 &&
							Option.isNone(unpadded),
						`${unionM.delivered.generated.statements.length} statements; ${Option.getOrElse(unpadded, () => "each group's heading is its arm's")}`
					),
					mechanism(
						"each group's plan is the plan its arm has alone",
						groupShapes.length === 2 && Arr.every(groupShapes, (s, i) => s === aloneShapes[i]),
						`${Arr.join(groupShapes, " | ")} vs ${Arr.join(aloneShapes, " | ")}`
					),
					mechanism(
						"a delivered bound takes k per group",
						boundedM.delivered.generated.statements.length === 2 &&
							boundedGroups.length === 2 &&
							Arr.every(
								boundedGroups,
								(shape) => has(shape, "limit param") || has(shape, "limit literal")
							),
						`${boundedGroups.length} group statements`
					),
					mechanism(
						"a take over a union whose common fields hold no key is refused with UnsupportedOperation",
						!noteBound.ok && noteBound.error.reason._tag === "UnsupportedOperation",
						!noteBound.ok ? noteBound.error.message : "compiled"
					),
					mechanism(
						"a consumed bound is one UNION ALL statement with a limit",
						consumedM.delivered.generated.statements.length === 1 &&
							consumedStatements.length === 1 &&
							has(consumedShape, "union all") &&
							(has(consumedShape, "limit param") || has(consumedShape, "limit literal")),
						Arr.join([...consumedShape.counts.keys()], ", ")
					),
					agrees("the delivered union agrees with the conservative lowering", unionM),
					agrees("the bounded union agrees with the conservative lowering", boundedM),
					agrees("the consumed union agrees with the conservative lowering", consumedM),
					equivalence(
						"the delivered union agrees with the handwritten group statements",
						unionVersusHand.sameResult,
						`${unionM.generated.result.rows} generated rows, ${unionHand.result.rows} handwritten`
					),
					equivalence(
						"the consumed union agrees with the handwritten first ten tuples",
						consumedVersusHand.sameResult,
						`${consumedM.generated.result.rows} generated ids, ${consumedHand.result.rows} handwritten`
					),
					judged(
						"the consumed bound equals the merge of the per-group bounded statements",
						rowsAgree,
						consumedIds,
						mergedIds
					),
					equivalence(
						"no repeated row",
						unionM.generated.result.repeated === 0 &&
							boundedM.generated.result.repeated === 0 &&
							consumedM.generated.result.repeated === 0,
						`${unionM.generated.result.repeated}, ${boundedM.generated.result.repeated} and ${consumedM.generated.result.repeated} repeated`
					)
				]
			}

			/** R25. */
			const shared = compile(fx, twice, reading)
			const region = 7
			const sharedM = yield* measureQuery(runtime, raw, shared, { region }, measure)
			const sent = sharedM.delivered.generated.statements
			const [parentSent, ...children] = sent
			const [childSent] = children
			if (childSent === undefined) {
				throw new GateSetupError({ what: "the shared attachments sent no child statement" })
			}
			/** The shared form: the parent and one attachment statement, whose rows feed both attachments. */
			const once = yield* measureVariant(
				raw,
				{
					role: "generated",
					label: "shared: the representative only",
					statements: [parentSent, childSent],
					transaction: readSnapshot,
					decode: { kind: "none" },
					outside: {}
				},
				{ ...handOptions, warmup: 0 }
			)
			/** What an expert writes: the parent statement and one child statement over the parent's own predicate. */
			const sharedHand = yield* measureVariant(
				raw,
				handwritten(
					"handwritten: the parent and one child statement",
					[
						{
							sql: `SELECT a.${ac("id")}::text AS id FROM ${A} AS a WHERE a.${ac("region")} = $1::integer`,
							params: [String(region)]
						},
						{
							sql:
								`SELECT t.${tc("account")}::text AS id, t.${tc("account")}::text AS account, t.${tc("due")}::text AS due, ` +
								`t.${tc("id")}::text AS id, t.${tc("kind")}::text AS kind, t.${tc("priority")}::text AS priority, ` +
								`t.${tc("title")}::text AS title FROM ${T} AS t JOIN ${A} AS a ON a.${ac("id")} = t.${tc("account")} ` +
								`WHERE a.${ac("region")} = $1::integer`,
							params: [String(region)]
						}
					],
					readSnapshot
				),
				handOptions
			)
			const onceVersusHand = compareVariants(once, sharedHand)
			cases.push({
				name: "a region's accounts with the same tasks attached twice",
				gates: ["R25"],
				conditions: conditions({
					workload:
						"two identical pipelined attachments (five fields each) of one parent statement",
					schemaState: installed,
					data,
					parameters: { region },
					semantics: "each account of the region with its tasks, delivered under two names",
					cache: warm
				}),
				phases: {},
				variants: [sharedM.generated, sharedM.conservative, once, sharedHand],
				comparisons: [
					compareVariants(sharedM.generated, once),
					compareVariants(sharedM.generated, sharedHand)
				],
				transactions: {},
				loads: {},
				measures: {
					statementsSent: sent.length,
					childStatements: children.length,
					childDedupNodes: Arr.reduce(
						plansOf(sharedM.generated).slice(1),
						0,
						(n, p) => n + dedupNodes(p).length
					)
				}
			})
			const r25: VerdictInput = {
				checks: [
					mechanism(
						"identical sub-queries over the same feeding statement are computed once and fed to the others",
						sent.length === 2,
						`${sent.length} statements sent`
					),
					judged(
						"the delivered result agrees with the conservative lowering",
						deliveredAgree("set"),
						sharedM.delivered.generated.rows,
						sharedM.delivered.conservative.rows
					),
					equivalence(
						"the shared form's rows agree with the handwritten parent and child statements",
						onceVersusHand.sameResult,
						`${once.result.rows} generated rows, ${sharedHand.result.rows} handwritten`
					)
				]
			}
			return { cases, verdicts: { R21: r21, R25: r25 } }
		})
})
