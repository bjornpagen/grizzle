/** What the properties of statistics.test.ts read: its spaces, models and helpers. */

import { type Reached } from "@bjornpagen/testing/features"
import { type Gen, subarray, constant } from "@bjornpagen/testing/gen"
import { Array as Arr, Order, Record } from "effect"
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
import { pickGen } from "#test/support/pick.ts"

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
 */
const Code = str.regex("^[a-z]{1,8}$")

/** A catalog row's order: its fields' text, joined by spaces, in UTF-16 code-unit order. */
export const byRowText: Order.Order<ReadonlyArray<string>> = Order.mapInput(
	Order.String,
	(row: ReadonlyArray<string>) => Arr.join(row, " ")
)

/** The schema under the allocated name, its programs over it, and its login, owning the workload of `picked`. */
export const build = (name: string, picked: ReadonlyArray<ProgramName>) => {
	const Kind = closed.ordered("Kind", ["A", "B"])
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

export const sketchGen: Gen<WorkloadSketch> = (source) => ({
	workload: source.draw(subarray(programNames)),
	drop: source.draw(pickGen)
})

export type StatisticsFeature =
	| "statistics on a view"
	| "statistics on a table"
	| "view statistics two programs justify"
	| "a view's statistics dropped"

/** Each statistics object of the installation: its PostgreSQL schema, its name, its relation, the relation's kind (m for a
 * materialized view, r for a table), its columns in code point order joined by commas, its kinds, and the statement that
 * creates it. */
export type StatisticsRow = readonly [string, string, string, string, string, string, string]

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const workloadCases: ReadonlyArray<{
	readonly why: string
	readonly value: WorkloadSketch
	readonly reaches: ReadonlyArray<StatisticsFeature>
}> = [
	{
		why: "a view's statistics justified by a selection and a group key at once, beside a table's",
		value: { workload: ["totalsOf", "countsOf", "tasksOf", "heavy"], drop: 0 },
		reaches: [
			"statistics on a view",
			"statistics on a table",
			"view statistics two programs justify",
			"a view's statistics dropped"
		]
	},
	{
		why: "statistics on two views",
		value: { workload: ["totalsOf", "placedIn"], drop: 1 },
		reaches: ["statistics on a view", "a view's statistics dropped"]
	}
]

/** The property's aims (workload): each kept case's value at every situation it reaches. */
export const workloadAims: ReadonlyArray<
	readonly [Reached<StatisticsFeature>, Gen<WorkloadSketch>]
> = Arr.flatMap(workloadCases, (c) =>
	Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
)
