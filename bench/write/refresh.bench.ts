import {
	Array as Arr,
	Effect,
	Option,
	Order,
	pipe,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { dbContext } from "#adapter/db/context.ts"
import { refreshReport } from "#adapter/refresh/index.ts"
import { summarize } from "#bench/cold/stats.ts"
import { explain, planNodes } from "#bench/harness/explain.ts"
import {
	type CaseRecord,
	defineGate,
	equivalence,
	jsonText,
	mechanism,
	type VerdictInput
} from "#bench/harness/gate.ts"

import {
	measureTransaction,
	summarizeTransactions,
	type TransactionMeasure,
	type TransactionPlan
} from "#bench/harness/transaction.ts"
import { fill, GateSetupError, settle } from "#bench/query/support/kit.ts"
import {
	baselineSchema,
	decodeOne,
	installWrites,
	loadedByOwner,
	openDb,
	owner,
	plainStatement,
	timed,
	warmedOnce,
	writeConditions,
	writePhases,
	writerSession
} from "#bench/write/support/writes.ts"
import { Compute } from "#compiler/public/compute.ts"
import { pg } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { derived, login, relation, role, schema } from "#compiler/public/schema.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

import { regex } from "arkregex"
/**
 * R40: refresh with REFRESH MATERIALIZED VIEW CONCURRENTLY, and refreshes one level per call.
 *
 * R40: "refresh with no base change writes nothing, except where an order-dependent double-precision aggregate rounds
 * differently on recomputation; measure refresh time, rows written, WAL, and workers launched against a hand-written
 * materialized view of the same definition, and record the record-image churn on equal but not byte-identical values".
 * The lifetime gate: "refreshes that fit an 800 s function lifetime one level per call", which is how a long refresh
 * fits a serverless lifetime: its refresh runs one level, or one relation, per call. Its contract is structural: each
 * call refreshes exactly the relations of its level, one statement per relation, as the call's own report names them.
 * Each call's time is information.
 *
 * The fixture is the refresh suite's shape (test/pg/derived/refresh/refresh.test.ts): Sitting and Fee at level 0;
 * level 1 StudentWeekly (sittings and passes per student and week) and TopFee (each student's largest fee, an
 * unconstrained numeric whose equal values may differ in spelling); level 2 WeekBusy, which reads StudentWeekly. The
 * refresher role refreshes through the Db's own refresh (db.refresh, reporting the statements it ran), one level
 * per call. Rows written are the view rows whose tuple (ctid, xmin) the refresh replaced. The refresh statement the
 * runtime issued is also replayed on a direct session of the refresher role inside a measured SERIALIZABLE
 * transaction, for its own backend's WAL, beside one owner's REFRESH ... CONCURRENTLY of a hand-written materialized
 * view of the same definition with its unique index, whose rows the generated view must equal.
 */
const Sitting = relation(
	"Sitting",
	{ id: pg.bigint, student: pg.integer, week: pg.integer, passed: pg.boolean },
	["id"]
)
const Fee = relation("Fee", { id: pg.bigint, student: pg.integer, amount: pg.numeric }, ["id"])

const build = (name: string) => {
	const Edu = schema(name, { Sitting, Fee }, [])
	const StudentWeekly = derived(
		"StudentWeekly",
		query(Edu).rule((r) => {
			const { id, student, week, passed } = v(Sitting, "sitting")
			return r.match(Sitting, { id, student, week, passed }).find({
				student,
				week,
				sittings: r.count(),
				passes: r.sum(Compute.cond(passed, Compute.literal(pg.integer, 1), 0))
			})
		})
	)
	const TopFee = derived(
		"TopFee",
		query(Edu).rule((r) => {
			const { id, student, amount } = v(Fee, "fee")
			return r.match(Fee, { id, student, amount }).find({ student, top: r.max(amount) })
		})
	)
	const Level1 = schema.extend(Edu, { StudentWeekly, TopFee }, [])
	const WeekBusy = derived(
		"WeekBusy",
		query(Level1).rule((r) => {
			const { student, week } = v(StudentWeekly, "studentWeekly")
			return r.match(StudentWeekly, { student, week }).find({ week, students: r.count() })
		})
	)
	const Reports = schema.extend(Level1, { WeekBusy }, [])
	/** The refresher: a full role refreshing every view, in a login of its own. */
	const refresher = role(Reports, "refresher", Reports.relations, {
		refresh: ["StudentWeekly", "TopFee", "WeekBusy"]
	})
	return {
		Reports,
		StudentWeekly,
		TopFee,
		WeekBusy,
		refresher,
		refreshers: login(Reports, "refreshers", [refresher])
	}
}

interface Options extends Readonly<Record<string, unknown>> {
	readonly students: number
	readonly weeks: number
	/** Sittings per student and week. */
	readonly perWeek: number
	readonly samples: number
}

const CountRow = Schema.Tuple([Schema.FiniteFromString])
const TextRow = Schema.Tuple([Schema.String])
const FeeRow = Schema.Tuple([Schema.String, Schema.String])
const ViewRows = Schema.Tuple([
	Schema.FiniteFromString,
	Schema.FiniteFromString,
	Schema.FiniteFromString
])

/** A SERIALIZABLE transaction of one refresh statement, with its backend's WAL read around it. */
const refreshTransaction = (sql: string): TransactionPlan => ({
	readOnly: false,
	statements: [plainStatement("refresh", sql, [])],
	end: "plain",
	deferredEvents: false,
	wal: true
})

/** @internal */
export default defineGate({
	name: "write-refresh",
	gates: ["R40", "refresh-lifetime"],
	title:
		"db.refresh: rows written, WAL and workers against a hand-written view, and one level per call",
	scope:
		"Two levels of derived relations over Sitting and Fee: each level's db.refresh, one level per call, by the " +
		"statements it reports; a refresh with no base change, after a small change, and after an equal but differently " +
		"spelled numeric; the refresh statement's WAL and the definition's workers against a hand-written view.",
	phases: [...writePhases, "refreshMs"],
	options: {
		full: { students: 200000, weeks: 20, perWeek: 2, samples: 5 },
		quick: { students: 500, weeks: 4, perWeek: 2, samples: 2 }
	} satisfies { readonly full: Options; readonly quick: Options },
	run: ({ options }) =>
		Effect.gen(function* () {
			const s = yield* Substrate
			const declared = build("Edu")
			const fx = yield* installWrites(declared.Reports, "benchrefresh", {
				programs: {},
				logins: [declared.refreshers]
			})
			const R = build(fx.installed.declared)
			const sittings = options.students * options.weeks * options.perWeek
			const c = (rel: string, f: string) => fx.column(rel, f)
			yield* fill(fx, "Sitting", sittings, {
				id: "g::int8",
				student: `(1 + (g - 1) % ${options.students})::int4`,
				week: `(1 + ((g - 1) / ${options.students}) % ${options.weeks})::int4`,
				passed: "(pg_catalog.hashint8(g) % 3 <> 0)"
			})
			yield* fill(fx, "Fee", options.students * 2, {
				id: "g::int8",
				student: `(1 + (g - 1) % ${options.students})::int4`,
				amount: "((pg_catalog.hashint8(g) & 1023)::numeric / 4)"
			})
			yield* settle(fx)
			const view = (rel: string) => fx.table(rel)
			const db = yield* openDb(fx, R.refreshers.roles.refresher)
			const context = dbContext(db)
			if (context === undefined) {
				throw GateSetupError.make({ what: "the refresher's Db has no context" })
			}
			/** db.refresh of `relations`, reporting the statements its one transaction ran. */
			const refreshed = (relations: Arr.NonEmptyReadonlyArray<{ readonly name: string }>) =>
				refreshReport(context, relations)
			const level1 = [R.StudentWeekly, R.TopFee] as const
			const level2 = [R.WeekBusy] as const

			/** The lifetime: the first refresh of each level, one level per call, then a later one. */
			const level1First = yield* timed(refreshed(level1))
			const level2First = yield* timed(refreshed(level2))
			const level1Again = yield* timed(refreshed(level1))
			const level2Again = yield* timed(refreshed(level2))
			const calls = [
				{ call: "level 1, first", relations: level1, run: level1First },
				{ call: "level 2, first", relations: level2, run: level2First },
				{ call: "level 1, again", relations: level1, run: level1Again },
				{ call: "level 2, again", relations: level2, run: level2Again }
			]
			const levelMs = Arr.map(calls, (x) => x.run.ms)
			const sameNames = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
				const left = Arr.sort(a, Order.String)
				const right = Arr.sort(b, Order.String)
				return left.length === right.length && Arr.every(left, (name, i) => name === right[i])
			}
			/** Each call refreshed exactly its level's relations, one statement per relation, as its report names them. */
			const exactlyItsLevel = Arr.every(calls, (x) =>
				sameNames(
					Arr.map(x.run.value.statements, (statement) => statement.relation),
					Arr.map(x.relations, (r) => r.name)
				)
			)
			const reportsText = Arr.join(
				Arr.map(
					calls,
					(x) =>
						`${x.call}: ${Arr.join(
							Arr.map(x.run.value.statements, (statement) => statement.relation),
							", "
						)}`
				),
				"; "
			)

			/** Rows written: the view rows whose (ctid, xmin) a refresh replaced. */
			const snapshotViews = ["StudentWeekly", "TopFee", "WeekBusy"]
			const takeSnapshot = Effect.gen(function* () {
				for (const rel of snapshotViews) {
					yield* s.admin.query(
						`CREATE TEMPORARY TABLE IF NOT EXISTS ${fx.relationName(rel)}_before (t tid NOT NULL, x xid NOT NULL)`,
						[]
					)
				}
				for (const rel of snapshotViews) {
					yield* s.admin.query(`TRUNCATE pg_temp.${fx.relationName(rel)}_before`, [])
					yield* s.admin.query(
						`INSERT INTO pg_temp.${fx.relationName(rel)}_before SELECT ctid, xmin FROM ${view(rel)}`,
						[]
					)
				}
			})
			const rewrittenOf = (rel: string) =>
				Effect.map(
					s.admin.queryValues(
						`SELECT pg_catalog.count(*)::text FROM ${view(rel)} AS v WHERE NOT EXISTS (SELECT 1 FROM pg_temp.${fx.relationName(rel)}_before AS b WHERE b.t = v.ctid AND b.x = v.xmin)`,
						[]
					),
					(rows) => decodeOne(CountRow, rows)[0]
				)
			const rewritten = Effect.gen(function* () {
				return {
					StudentWeekly: yield* rewrittenOf("StudentWeekly"),
					TopFee: yield* rewrittenOf("TopFee"),
					WeekBusy: yield* rewrittenOf("WeekBusy")
				}
			})
			const refreshAll = Effect.andThen(refreshed(level1), refreshed(level2))
			yield* takeSnapshot
			const unchanged = yield* timed(refreshAll)
			const unchangedRows = yield* rewritten
			yield* owner(
				`INSERT INTO ${fx.table("Sitting")} (${Arr.join(
					Arr.map(["id", "student", "week", "passed"], (f) => c("Sitting", f)),
					", "
				)}) VALUES (${sittings + 1}, 1, 1, true)`
			)
			yield* takeSnapshot
			const smallChange = yield* timed(refreshAll)
			const smallChangeRows = yield* rewritten
			/** An equal but differently spelled numeric: student 1's largest fee, rewritten with one more trailing zero. */
			const topFee = yield* s.admin.queryValues(
				`SELECT ${c("Fee", "id")}::text, ${c("Fee", "amount")}::text FROM ${fx.table("Fee")} WHERE ${c("Fee", "student")} = 1 ORDER BY ${c("Fee", "amount")} DESC, ${c("Fee", "id")} LIMIT 1`,
				[]
			)
			const [topId, topAmount] = decodeOne(FeeRow, topFee)
			yield* owner(
				`UPDATE ${fx.table("Fee")} SET ${c("Fee", "amount")} = (${c("Fee", "amount")}::text || '0')::numeric WHERE ${c("Fee", "id")} = ${topId}`
			)
			yield* takeSnapshot
			const churn = yield* timed(refreshAll)
			const churnRows = yield* rewritten

			/**
			 * The refresh statement's WAL and the definition's workers, generated and hand-written. The generated statement is
			 * the one the runtime issued for StudentWeekly in a populated view's refresh.
			 */
			const generatedStatement = Option.getOrThrowWith(
				Arr.findFirst(
					level1Again.value.statements,
					(statement) => statement.relation === R.StudentWeekly.name
				),
				() =>
					GateSetupError.make({
						what: "the second refresh of level 1 reports no statement for StudentWeekly"
					})
			)
			const refresher = yield* writerSession(fx, R.refresher, "m15c refresh refresher")
			const B = yield* baselineSchema("benchrefreshhand")
			const handDefinition = `SELECT s.${c("Sitting", "student")} AS student, s.${c("Sitting", "week")} AS week, pg_catalog.count(*) AS sittings, pg_catalog.count(*) FILTER (WHERE s.${c("Sitting", "passed")}) AS passes FROM ${fx.table("Sitting")} AS s GROUP BY 1, 2`
			yield* owner(
				`CREATE MATERIALIZED VIEW ${B}.student_weekly AS ${handDefinition}`,
				`CREATE UNIQUE INDEX ON ${B}.student_weekly (student, week)`
			)
			const hand = yield* s.session({ ...ownerSession(), label: "m15c refresh hand-written" })
			const replayed: Array<TransactionMeasure> = []
			for (let i = 0; i < options.samples; i++) {
				const replayedRun = yield* measureTransaction(
					refresher,
					refreshTransaction(generatedStatement.sql)
				)
				replayed.push(replayedRun)
			}
			const handwritten = yield* measureTransaction(
				hand,
				refreshTransaction(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${B}.student_weekly`)
			)
			const definitionOf = (qualified: string) =>
				Effect.map(
					s.admin.queryValues(`SELECT pg_catalog.pg_get_viewdef($1::regclass, true)`, [qualified]),
					(rows) => pipe(decodeOne(TextRow, rows)[0], Str.replace(regex(";\\s*$"), ""))
				)
			const generatedDefinition = yield* definitionOf(view("StudentWeekly"))
			const captureOptions = { wal: true, serialize: { kind: "off" as const } }
			const generatedPlan = yield* explain(hand, generatedDefinition, [], captureOptions)
			const handPlan = yield* explain(hand, handDefinition, [], captureOptions)
			/** PostgreSQL reports Workers Launched only on a Gather node, so every other node launched none. */
			const workers = (p: typeof generatedPlan) =>
				planNodes(p.plan).reduce((sum, n) => sum + Option.getOrElse(n.workersLaunched, () => 0), 0)
			const viewCounts = yield* s.admin.queryValues(
				`SELECT (SELECT pg_catalog.count(*) FROM ${view("StudentWeekly")})::text, (SELECT pg_catalog.count(*) FROM ${B}.student_weekly)::text, (SELECT pg_catalog.count(*) FROM (SELECT student, week, sittings, passes FROM ${B}.student_weekly EXCEPT SELECT ${c("StudentWeekly", "student")}, ${c("StudentWeekly", "week")}, ${c("StudentWeekly", "sittings")}, ${c("StudentWeekly", "passes")} FROM ${view("StudentWeekly")}) AS d)::text`,
				[]
			)
			const [generatedCount, handCount, differing] = decodeOne(ViewRows, viewCounts)

			const data = `${sittings} sittings of ${options.students} students over ${options.weeks} weeks; ${options.students * 2} fees`
			const cases: Array<CaseRecord<"R40" | "refresh-lifetime">> = [
				{
					name: "one level per call",
					gates: ["refresh-lifetime"],
					conditions: writeConditions({
						workload:
							"db.refresh of level 1 (StudentWeekly, TopFee), then of level 2 (WeekBusy), each its own call: first refreshes, then later ones",
						schemaState: loadedByOwner,
						data,
						parameters: { students: options.students, weeks: options.weeks },
						semantics: "each call refreshes exactly its level's relations, one statement each",
						cache: "the first refreshes populate the views; the later ones refresh CONCURRENTLY"
					}),
					phases: { refreshMs: summarize(levelMs) },
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						levelMs,
						refreshed: reportsText
					}
				},
				{
					name: "rows written by a refresh",
					gates: ["R40"],
					conditions: writeConditions({
						workload:
							"db.refresh of both levels with no base change, after one new sitting, and after one fee rewritten as an equal numeric with another spelling",
						schemaState: loadedByOwner,
						data,
						parameters: {},
						semantics: "a refresh writes exactly the rows whose record image changed",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {},
					loads: {},
					measures: {
						unchangedRefreshMs: unchanged.ms,
						unchangedRowsWritten: jsonText(unchangedRows),
						smallChangeRefreshMs: smallChange.ms,
						smallChangeRowsWritten: jsonText(smallChangeRows),
						churnRefreshMs: churn.ms,
						churnRowsWritten: jsonText(churnRows),
						churnValue: `${topAmount} rewritten as ${topAmount}0`
					}
				},
				{
					name: "the refresh statement against a hand-written materialized view",
					gates: ["R40"],
					conditions: writeConditions({
						workload:
							"the REFRESH MATERIALIZED VIEW CONCURRENTLY of StudentWeekly the runtime issued, replayed as the refresher role, and one of a hand-written view of the same definition as the owner, each in a measured SERIALIZABLE transaction with no base change",
						schemaState: loadedByOwner,
						data,
						parameters: {},
						semantics: "the same rows; nothing to write",
						cache: warmedOnce
					}),
					phases: {},
					variants: [],
					comparisons: [],
					transactions: {
						generated: summarizeTransactions(replayed),
						handwritten: summarizeTransactions([handwritten])
					},
					loads: {},
					measures: {
						generatedWorkersLaunched: workers(generatedPlan),
						handwrittenWorkersLaunched: workers(handPlan),
						generatedDefinitionExecutionMs: generatedPlan.executionMs,
						handwrittenDefinitionExecutionMs: handPlan.executionMs,
						viewRows: `${generatedCount} generated, ${handCount} hand-written, ${differing} differing`
					}
				}
			]
			const allZero = (rows: Readonly<Record<string, number>>) =>
				Arr.every(Rec.values(rows), (n) => n === 0)
			const r40: VerdictInput = {
				checks: [
					mechanism(
						"a refresh with no base change writes nothing",
						allZero(unchangedRows),
						jsonText(unchangedRows)
					),
					mechanism(
						"one new sitting of a student already in its week rewrites exactly its group's StudentWeekly row",
						smallChangeRows.StudentWeekly === 1 &&
							smallChangeRows.WeekBusy === 0 &&
							smallChangeRows.TopFee === 0,
						jsonText(smallChangeRows)
					),
					mechanism(
						"an equal numeric with another spelling rewrites at most its one TopFee row (record-image churn)",
						churnRows.TopFee <= 1 && churnRows.StudentWeekly === 0 && churnRows.WeekBusy === 0,
						jsonText(churnRows)
					),
					equivalence(
						"the generated view holds exactly the hand-written view's rows",
						generatedCount === handCount && differing === 0,
						`${generatedCount} ${handCount} ${differing}`
					),
					equivalence(
						"every replayed refresh committed",
						Arr.every(replayed, (m) => m.outcome.kind === "committed"),
						Arr.join(
							Arr.map(replayed, (m) => jsonText(m.outcome)),
							", "
						)
					)
				]
			}
			const lifetime: VerdictInput = {
				checks: [
					mechanism(
						"each db.refresh call refreshes exactly its level, one statement per relation",
						exactlyItsLevel,
						reportsText
					)
				]
			}
			return { cases, verdicts: { R40: r40, "refresh-lifetime": lifetime } }
		})
})
