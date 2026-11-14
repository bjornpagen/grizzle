import { drawn, explore, type Kept } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { type Gen, subarray } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, Order, Record, Result } from "effect"
import { identifierOf, identity } from "#compiler/core/identity.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	derived,
	login,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { workload } from "#compiler/public/workload.ts"
import { quoteIdent, quoteString } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, noObservation } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"
import { withServedDb } from "#test/support/served-db.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { fixtureLogin, planOf } from "#test/unit/workload/fixtures.ts"

/** Extended statistics on derived relations on PostgreSQL 19.
 *
 * A workload program's correlated equality selections or group key on two columns of a derived relation justify extended
 * statistics on that relation as they do on a table's, and the installation creates them on
 * the relation's materialized view through the same path as a table's. The schema here stores
 * tasks and accounts and derives two views, each per-account totals and each task's region; its login owns a drawn
 * workload of its programs, installed by the real apply runner through its generated first migration, and the snapshot
 * is registered as the application's. The property, for every drawn workload:
 * - the catalog holds exactly the statistics the workload plan justifies, each on its relation (a materialized view for a
 *   derived relation, a table for a stored one) in that relation's level's PostgreSQL schema, over its columns, with all
 *   three kinds;
 * - `grizzle migrate apply` with nothing pending, its drift check, admits it, and so does Db.open;
 * - the view statistics object the case picks, dropped by hand, is drift the drift check refuses at stage drift,
 *   while Db.open, which compares no catalog, still opens; created again as it was, both admit it again.
 * The precondition is planted: kept workloads justify statistics on a view, one of them by two programs at once.
 *
 * Plants (main's test phase): derived-statistics-two-kinds.patch.
 */
const Code = str.regex("^[a-z]{1,8}$")

/** A catalog row's order: its fields' text, joined by spaces, in UTF-16 code-unit order. */
const byRowText: Order.Order<ReadonlyArray<string>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<string>) => Arr.join(row, " ")
)

/** The schema under the allocated name, its programs over it, and its login, owning the workload of `picked`. */
const build = (name: string, picked: ReadonlyArray<ProgramName>) => {
	const Kind = closed("Kind", ["A", "B"])
	const Account = relation("Account", { code: Code, region: Code }, ["code"])
	const Task = relation(
		"Task",
		{ id: uuid, account: Code, kind: closedId(Kind), weight: pg.integer },
		["id"]
	)
	const base = schema(
		name,
		[Kind, Account, Task],
		[contained(on(Task, "account"), on(Account, "code"))]
	)
	/** Per account and kind, the number of tasks and their total weight. */
	const Totals = derived.materialized(
		"Totals",
		query(base).rule((r) => {
			const { id, account, kind, weight } = v(Task, "task")
			return r
				.match(Task, { id, account, kind, weight })
				.find({ account, kind, tasks: r.count(), total: r.sum(weight) })
		})
	)
	/** Each task with its account's region. */
	const Placed = derived.materialized(
		"Placed",
		query(base).rule((r) => {
			const { id, account, kind } = v(Task, "task")
			const { region } = v(Account, "account")
			return r
				.match(Task, { id, account, kind })
				.match(Account, { code: account, region })
				.find({ id, region, kind })
		})
	)
	const value = schema.extend(base, `${name}_1`, [Totals, Placed], [])
	/** Its worlds, in one login: the writer of the base relations, a reader of every relation, and the refresher. */
	const writer = role(value, "writer", { Account, Task }, { write: ["Account", "Task"] })
	const reader = role(value, "reader", { Kind, Account, Task, Totals, Placed })
	const refresher = role(
		value,
		"refresher",
		{ Account, Task, Totals, Placed },
		{ refresh: ["Totals", "Placed"] }
	)
	const programs = {
		/** Totals selected by kind and task count, two equalities on the view: statistics on Totals (kind, tasks). */
		totalsOf: query(value).rule((r) => {
			const { account, total } = v(Totals, "totals")
			return r
				.match(Totals, {
					account,
					kind: r.param("kind", closedId(Kind)),
					tasks: r.param("tasks", pg.bigint),
					total
				})
				.find({ account, total })
		}),
		/** The accounts per kind and task count, a group key of two view columns: statistics on Totals (kind, tasks) too. */
		countsOf: query(value).rule((r) => {
			const { account, kind, tasks } = v(Totals, "totals")
			return r.match(Totals, { account, kind, tasks }).find({ kind, tasks, accounts: r.count() })
		}),
		/** Placed tasks selected by region and kind: statistics on Placed (kind, region). */
		placedIn: query(value).rule((r) => {
			const { id } = v(Placed, "placed")
			return r
				.match(Placed, {
					id,
					region: r.param("region", Code),
					kind: r.param("kind", closedId(Kind))
				})
				.find({ id })
		}),
		/** Tasks selected by account and kind: statistics on the Task table (account, kind). */
		tasksOf: query(value).rule((r) => {
			const { id, weight } = v(Task, "task")
			return r
				.match(Task, {
					id,
					account: r.param("account", Task.fields.account),
					kind: r.param("kind", Task.fields.kind),
					weight
				})
				.find({ id, weight })
		}),
		/** Totals above a weight, a range on one view column: an index, no statistics. */
		heavy: query(value).rule((r) => {
			const { account, kind, total } = v(Totals, "totals")
			return r
				.match(Totals, { account, kind, total })
				.where(r.ge(total, r.param("least", pg.numeric(29, 0))))
				.find({ account, kind })
		})
	}
	/** The drawn programs, under their names: the workload the login owns. */
	const owned = Record.fromEntries(Arr.map(picked, (n) => [n, programs[n]]))
	const server = login(value, "server", [writer, reader, refresher], {
		workload: [workload(value, owned)]
	})
	return { value, server, owned }
}
type ProgramName = "totalsOf" | "countsOf" | "placedIn" | "tasksOf" | "heavy"
const programNames: ReadonlyArray<ProgramName> = [
	"totalsOf",
	"countsOf",
	"placedIn",
	"tasksOf",
	"heavy"
]

interface WorkloadSketch {
	readonly workload: ReadonlyArray<ProgramName>
	/** Which of the view statistics the case drops. */
	readonly drop: number
}

const sketchGen: Gen<WorkloadSketch> = (source) => ({
	workload: source.draw(subarray(programNames)),
	drop: source.draw(pickGen)
})

type StatisticsFeature =
	| "statistics on a view"
	| "statistics on a table"
	| "view statistics two programs justify"
	| "a view's statistics dropped"

const kept: ReadonlyArray<Kept<WorkloadSketch, StatisticsFeature>> = [
	{
		note: "a view's statistics justified by a selection and a group key at once, beside a table's",
		sketch: { workload: ["totalsOf", "countsOf", "tasksOf", "heavy"], drop: 0 },
		draws: "",
		reaches: [
			"statistics on a view",
			"statistics on a table",
			"view statistics two programs justify",
			"a view's statistics dropped"
		]
	},
	{
		note: "statistics on two views",
		sketch: { workload: ["totalsOf", "placedIn"], drop: 1 },
		draws: "",
		reaches: ["statistics on a view", "a view's statistics dropped"]
	}
]

/** Each statistics object of the installation: its PostgreSQL schema, its name, its relation, the relation's kind (m for a
 * materialized view, r for a table), its columns in code point order joined by commas, its kinds, and the statement that
 * creates it. */
type StatisticsRow = readonly [string, string, string, string, string, string, string]

layer(Substrate.layer)("extended statistics on derived relations", (it) => {
	it.effect(
		"every statistics object a workload justifies is installed on its view or table and admitted, and a dropped one is drift",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "second-implementation",
							name: "the login's workload plan (planOf): the statistics it justifies, as PostgreSQL's catalog holds them, and the drift check's verdict on one dropped"
						},
						suite: "derived/statistics",
						draw: drawn(sketchGen),
						literal: Formatter.format,
						coverage: required<StatisticsFeature>(
							[
								"statistics on a view",
								"statistics on a table",
								"view statistics two programs justify",
								"a view's statistics dropped"
							],
							{ cases: 4, sense: notesOnly }
						),
						kept,
						runs: 4,
						shrink: { kind: "bounded", candidates: 20 },
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(sketch, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								const built: Array<ReturnType<typeof build>> = []
								const m = yield* migrated({
									label: "derived_stats",
									schemaName: { kind: "unique" },
									first: (name) => {
										const b = build(name, sketch.workload)
										built.push(b)
										return { schema: b.value, logins: [b.server] }
									},
									apply: { kind: "noPlaceholders" },
									later: [],
									observe: noObservation,
									declared: () => noDeclarations
								})
								const b = defined(built[0], "the schema")
								const derivedNames = new Set(["Totals", "Placed"])
								/** The login's workload, planned as its migration planned it. */
								const plan = planOf(b.value, b.owned)
								const statistics = plan.statistics
								const access = Record.values(
									defined(plan.access[fixtureLogin], "the login's programs' access")
								)
								/** Every level's PostgreSQL schema: a level's tables and materialized views live in its own. */
								const levels = Arr.join(
									Arr.map(m.installation.names.levels, (l) => quoteString(identifierOf(l))),
									", "
								)
								/** The catalog's statistics are exactly the plan's, each on its relation in that relation's
								 * level's schema, with all three kinds. */
								const installed = () =>
									Effect.map(
										m.owner.values(
											`SELECT n.nspname::text, x.stxname::text, c.relname::text, c.relkind::text,
													(SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text COLLATE "C")
													 FROM pg_catalog.pg_attribute AS a
													 WHERE a.attrelid = x.stxrelid AND a.attnum = ANY (x.stxkeys))::text,
													array_to_string(x.stxkind, ',')::text,
													pg_catalog.pg_get_statisticsobjdef(x.oid)::text
												 FROM pg_catalog.pg_statistic_ext AS x
												 JOIN pg_catalog.pg_class AS c ON c.oid = x.stxrelid
												 JOIN pg_catalog.pg_namespace AS n ON n.oid = x.stxnamespace
												 WHERE n.nspname IN (${levels})
												 ORDER BY 1, 2`,
											[]
										),
										(rows) => trusted<ReadonlyArray<StatisticsRow>>(rows)
									)
								const before = yield* installed()
								const expected = Arr.sort(
									Arr.map(statistics, (s) => {
										const on = m.installation.names.relation(s.relation)
										return [
											on.schema,
											on.name,
											derivedNames.has(s.relation) ? "m" : "r",
											Arr.join(
												Arr.sort(
													Arr.map(s.columns, (column) =>
														identifierOf(identity.column(parsedName(column)))
													),
													Order.String
												),
												","
											),
											"d,f,m"
										]
									}),
									byRowText
								)
								assert.deepEqual(
									Arr.sort(
										Arr.map(before, ([level, , table, kind, columns, kinds]) => [
											level,
											table,
											kind,
											columns,
											kinds
										]),
										byRowText
									),
									expected
								)
								for (const s of statistics) {
									if (!derivedNames.has(s.relation)) {
										c.note("statistics on a table")
									} else {
										c.note("statistics on a view")
										const requesting = Arr.filter(access, (a) =>
											Arr.some(
												a.statistics,
												(q) =>
													q.relation === s.relation &&
													Arr.join(q.columns, ",") === Arr.join(s.columns, ",")
											)
										)
										if (requesting.length > 1) {
											c.note("view statistics two programs justify")
										}
									}
								}
								/** Both paths admit the installed catalog. */
								const admitted = Effect.gen(function* () {
									const reapplied = yield* m.reapply
									assert.deepEqual(reapplied.applied, [])
									yield* withServedDb(m, b.server.roles.reader, {}, () => Effect.void)
								})
								yield* admitted
								const views = Arr.filter(before, ([, , , kind]) => kind === "m")
								if (views.length === 0) {
									return
								}
								const [level, dropped, , , , , definition] = pickFrom(
									[defined(views[0], "a view's statistics"), ...views.slice(1)],
									sketch.drop
								)
								yield* m.sql(`DROP STATISTICS ${quoteIdent(level)}.${quoteIdent(dropped)}`)
								c.note("a view's statistics dropped")
								const applied = yield* Effect.result(m.reapply)
								if (Result.isSuccess(applied)) {
									return assert.fail("migrate apply admits the dropped statistics")
								}
								assert.equal(applied.failure.stage, "drift")
								yield* withServedDb(m, b.server.roles.reader, {}, () => Effect.void)
								yield* m.sql(definition)
								yield* admitted
							})
						)
				)
			)
	)
})
