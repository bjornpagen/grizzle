/**
 * The worked example's plans, read as a tenant through its world: every selective workload read is planned through its
 * indexes, judged by PostgreSQL's planner with the scans that need no index disabled, over relations it plans
 * unanalyzed, which no data size moves.
 *
 * Work installs through its first migration with one login holding a tenant role, as `grizzle generate` drafts it, the
 * access paths planned from the tenant's workload (test/support/installed.ts migrated). The tenant reads every relation
 * through a query entry its token's account claim filters (tenantWorld): the accounts it is, their tasks, and each
 * task's automatic, manual and note facts through the task's account, so every view of its world is a security-barrier
 * view, and it writes every relation but Account through those entries, so each of them is under row-level security, a
 * policy filtering it for the tenant. Each case draws small sizes and loads Work at them over emptied tables in one
 * SERIALIZABLE transaction, every law judged at COMMIT: accounts, tasks alternating automatic and manual over them,
 * each automatic task's budget and each manual task's operator, and a note on every third task; then leaves every
 * relation unanalyzed (test/support/plans.ts unanalyzed), since analyzed statistics of a small load decide a plan by
 * its rows. It draws which account, which tasks and which range of names the selective reads ask about, opens the
 * tenant's Db with a token naming that account through its login's served file, runs every selective read of its
 * workload as a served member through a counting executor, and EXPLAINs each statement it sent with its parameters
 * (test/support/plans.ts): planned with sequential and index scans disabled and index-only scans never considered, so
 * that a bitmap scan, which reads only by an index condition, is the one scan left, every scan of a relation a
 * statement restricts reads by an index condition on an index the installation planned. The oracle is PostgreSQL's
 * planner. That every created index is needed is test/pg/physical/serving.test.ts's: a free plan's choice of index is
 * the cost model's, which only volume decides, so it is judged nowhere here.
 *
 * Features: a read by a busy account and by another.
 *
 * Plants: ~/.cache/grizzle-release/PLANIDX/plants/plans-requests-unplanned.patch (the index engine planning no
 * requested index, access or law).
 */
import { layer } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { type Gen, int } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, pipe, String as Str } from "effect"
import type { TestContext } from "vitest"
import { appendAll } from "#compiler/core/array.ts"
import { trusted } from "#compiler/core/trusted.ts"
import { codeOf } from "#compiler/ir/codes.ts"
import type { ParamMap } from "#compiler/plan/common.ts"
import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { context, login, role } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { printObjectName, quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { readOnce } from "#test/support/calls.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { migrated, noObservation, rebuild } from "#test/support/installed.ts"
import { parsedName } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"
import {
	plannedIndexes,
	recordingMembers,
	sentProblems,
	spread,
	unanalyzed
} from "#test/support/plans.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { beginSerializable } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

interface Sizes {
	readonly accounts: number
	/** Even; each task's kind alternates, and every third task has a note. */
	readonly tasks: number
}

/**
 * A case's sizes, drawn small: the property is PostgreSQL's planner with the scans that need no index disabled, which no
 * size moves.
 */
const sizesGen: Gen<Sizes> = (source) => ({
	accounts: source.draw(int(1, 30)),
	tasks: 2 * source.draw(int(1, 40))
})

/** A case: its sizes, and the pick of the account, tasks and names its reads ask about. */
const caseGen: Gen<{ readonly sizes: Sizes; readonly pick: number }> = (source) => ({
	sizes: source.draw(sizesGen),
	pick: source.draw(pickGen)
})

/** The entities a case asks about: accounts busiest first, and task ids. */
interface Entities {
	readonly accounts: ReadonlyArray<string>
	readonly tasks: ReadonlyArray<string>
}

type WorkFeature = "a read by a busy account" | "a read by another account"

/** The rows numbered 0 to `rows - 1`, as a FROM clause. */
const series = (rows: number): string => `FROM pg_catalog.generate_series(0, ${rows - 1}) AS s(g)`

/** The name the load gives the account numbered `n`. */
const accountName = (n: number): string => `account ${pipe(String(n), Str.padStart(6, "0"))}`

/**
 * Work's tenant world over the schema built under `name`: a token's Tenant claim names one account, and the tenant reads
 * that account, its tasks, and each of its tasks' automatic, manual and note facts, each a query entry its claim
 * filters, writing all but the account; and the tenant's selective reads over its world, its login's workload.
 */
const tenantWorld = (name: string) => {
	const base = rebuild(W.Work, name)
	const Tenant = context("Tenant", { account: uuid })
	const { Account, Task, AutomaticTask, ManualTask, TaskNote } = W
	const accounts = query(base).rule((r) => {
		const { id, name: label } = v(Account, "account")
		return r
			.match(Account, { id, name: label })
			.match(Tenant, { account: id })
			.find({ id, name: label })
	})
	const tasks = query(base).rule((r) => {
		const { id, account, kind } = v(Task, "task")
		return r
			.match(Task, { id, account, kind })
			.match(Tenant, { account })
			.find({ id, account, kind })
	})
	const automatic = query(base).rule((r) => {
		const { task, budget } = v(AutomaticTask, "automaticTask")
		const { account } = v(Task, "task")
		return r
			.match(AutomaticTask, { task, budget })
			.match(Task, { id: task, account })
			.match(Tenant, { account })
			.find({ task, budget })
	})
	const manual = query(base).rule((r) => {
		const { task, operator } = v(ManualTask, "manualTask")
		const { account } = v(Task, "task")
		return r
			.match(ManualTask, { task, operator })
			.match(Task, { id: task, account })
			.match(Tenant, { account })
			.find({ task, operator })
	})
	const notes = query(base).rule((r) => {
		const { task, note } = v(TaskNote, "taskNote")
		const { account } = v(Task, "task")
		return r
			.match(TaskNote, { task, note })
			.match(Task, { id: task, account })
			.match(Tenant, { account })
			.find({ task, note })
	})
	const tenant = role(
		base,
		"tenant",
		{
			Kind: W.Kind,
			Account: accounts,
			Task: tasks,
			AutomaticTask: automatic,
			ManualTask: manual,
			TaskNote: notes
		},
		{ write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"] }
	)
	const own = tenant.relations
	const automaticTasksFor = query(tenant).rule((r) => {
		const { id, account } = v(own.Task, "task")
		const { budget } = v(own.AutomaticTask, "automaticTask")
		return r
			.match(own.Task, { id, account, kind: "Automatic" })
			.match(own.AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, budget })
	})
	const automaticBudgetFor = query(tenant).rule((r) => {
		const { id, account } = v(own.Task, "task")
		const { budget } = v(own.AutomaticTask, "automaticTask")
		return r
			.match(own.Task, { id, account, kind: "Automatic" })
			.match(own.AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ account, tasks: r.count(), budget: r.sum(budget) })
	})
	const labeledAutomaticTasks = query(tenant).rule((r) => {
		const { id, account } = v(own.Task, "task")
		const { budget } = v(own.AutomaticTask, "automaticTask")
		const { name: label } = v(own.Account, "account")
		return r
			.match(own.Task, { id, account, kind: "Automatic" })
			.match(own.AutomaticTask, { task: id, budget })
			.match(own.Account, { id: account, name: label })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, name: label, budget })
	})
	const taskCards = query(tenant)
		.rule((r) => {
			const { id, account, kind } = v(own.Task, "task")
			return r
				.match(own.Task, { id, account, kind })
				.where(r.eq(account, r.param("account", uuid)))
				.find({ id, kind })
		})
		.attach(
			"note",
			(t) =>
				query(tenant).rule((r) => {
					const { note } = v(own.TaskNote, "taskNote")
					return r.match(own.TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
		.attach(
			"automatic",
			(t) =>
				query(tenant).rule((r) => {
					const { budget } = v(own.AutomaticTask, "automaticTask")
					return r.match(own.AutomaticTask, { task: t.id, budget }).find({ budget })
				}),
			"option"
		)
	const tasksById = query(tenant).rule((r) => {
		const wanted = r.relation("ids", { id: uuid })
		const { id, kind } = v(own.Task, "task")
		return r.match(wanted, { id }).match(own.Task, { id, kind }).find({ id, kind })
	})
	const accountsByPrefix = query(tenant).rule((r) => {
		const { id, name: label } = v(own.Account, "account")
		return r
			.match(own.Account, { id, name: label })
			.where(
				r.ge(label, r.param("lo", Account.fields.name)),
				r.lt(label, r.param("hi", Account.fields.name))
			)
			.find({ id, name: label })
	})
	const reads = {
		automaticTasksFor,
		automaticBudgetFor,
		labeledAutomaticTasks,
		taskCards,
		tasksById,
		accountsByPrefix
	} as const
	const server = login(base, "server", [tenant], { workload: [workload(tenant, reads)] })
	return { base, server, reads }
}

type TenantWorld = ReturnType<typeof tenantWorld>

/** The account a case asks about: the busiest a quarter of the time, otherwise any account with tasks. */
const accountOf = (e: Entities, pick: number): string =>
	defined(
		e.accounts[pickIndex(pick, 4) === 0 ? 0 : pickIndex(pick, e.accounts.length)],
		"an account with tasks"
	)

/** A selective read of the tenant's workload, by its member's name, with its parameters. */
interface SelectiveRead {
	readonly name: keyof TenantWorld["reads"]
	readonly params: ParamMap
}

/** Every selective read of the tenant's workload with its parameters for one pick, about `account`. */
const selectiveReads = (
	e: Entities,
	sizes: Sizes,
	pick: number,
	account: string
): ReadonlyArray<SelectiveRead> => {
	const first = pickIndex(pick, Math.max(1, e.tasks.length - 8))
	const range = pickIndex(pick, Math.max(1, Math.ceil(sizes.accounts / 10)))
	return [
		{ name: "automaticTasksFor", params: { account } },
		{ name: "automaticBudgetFor", params: { account } },
		{ name: "labeledAutomaticTasks", params: { account } },
		{ name: "taskCards", params: { account } },
		{
			name: "tasksById",
			params: { ids: Arr.map(e.tasks.slice(first, first + 8), (id) => ({ id })) }
		},
		{
			name: "accountsByPrefix",
			params: { lo: accountName(range * 10), hi: accountName(range * 10 + 10) }
		}
	]
}

/** The rotating stream's cases; the floor runs a quarter of them. */
const runs = 8

const planSuite = (ctx: TestContext) =>
	searched(
		ctx,
		Effect.gen(function* () {
			const s = yield* Substrate
			const built: Array<TenantWorld> = []
			const m = yield* migrated({
				label: "work_plans",
				schemaName: { kind: "unique" },
				first: (name) => {
					const world = tenantWorld(name)
					built.push(world)
					return { schema: world.base, logins: [world.server] }
				},
				later: [],
				apply: { kind: "noPlaceholders" },
				declared: () => noDeclarations,
				observe: noObservation
			})
			const world = defined(built[0], "the installed version")
			const names = m.names
			const table = (relation: string): string => printObjectName(names.relation(relation))
			const columns = (relation: string, fields: ReadonlyArray<string>): string =>
				Arr.join(
					Arr.map(fields, (f) => quoteIdent(names.column(relation, f))),
					", "
				)
			const column = (relation: string, field: string): string =>
				quoteIdent(names.column(relation, field))
			const kind = defined(names.codes.rosters.get(parsedName("Kind")), "the codes of Kind")
			const relations = ["Account", "Task", "AutomaticTask", "ManualTask", "TaskNote"] as const
			/** Work at `sizes`, written whole in one SERIALIZABLE transaction over emptied tables, then left unanalyzed. */
			const loadAt = (sizes: Sizes) =>
				Effect.gen(function* () {
					const load = [
						`TRUNCATE ${Arr.join(Arr.map(relations, table), ", ")}`,
						`INSERT INTO ${table("Account")} (${columns("Account", ["id", "name"])}) ` +
							`SELECT md5('account:' || g)::uuid, 'account ' || lpad(g::text, 6, '0') ${series(sizes.accounts)}`,
						`INSERT INTO ${table("Task")} (${columns("Task", ["id", "account", "kind"])}) ` +
							`SELECT md5('task:' || g)::uuid, md5('account:' || ${spread(1, sizes.accounts)})::uuid, ` +
							`(CASE WHEN g % 2 = 0 THEN ${codeOf(kind, "Automatic")} ELSE ${codeOf(kind, "Manual")} END)::smallint ${series(sizes.tasks)}`,
						`INSERT INTO ${table("AutomaticTask")} (${columns("AutomaticTask", ["task", "budget"])}) ` +
							`SELECT md5('task:' || (2 * g))::uuid, ${spread(2, 10_000)} ${series(sizes.tasks / 2)}`,
						`INSERT INTO ${table("ManualTask")} (${columns("ManualTask", ["task", "operator"])}) ` +
							`SELECT md5('task:' || (2 * g + 1))::uuid, 'operator ' || g ${series(sizes.tasks / 2)}`,
						`INSERT INTO ${table("TaskNote")} (${columns("TaskNote", ["task", "note"])}) ` +
							`SELECT md5('task:' || (3 * g))::uuid, 'note ' || g ${series(Math.floor((sizes.tasks - 1) / 3) + 1)}`
					]
					yield* Effect.onError(
						Effect.gen(function* () {
							yield* s.admin.query(beginSerializable, [])
							for (const statement of load) {
								yield* s.admin.query(statement, [])
							}
							yield* s.admin.query("COMMIT", [])
						}),
						() => Effect.ignore(s.admin.query("ROLLBACK", []))
					)
					yield* unanalyzed(
						s.admin,
						Arr.map(relations, (r) => names.relation(r))
					)
					const busiest = yield* s.admin.queryValues(
						`SELECT ${column("Task", "account")}::text FROM ${table("Task")} GROUP BY 1 ORDER BY count(*) DESC, 1`,
						[]
					)
					const tasks = yield* s.admin.queryValues(
						`SELECT ${column("Task", "id")}::text FROM ${table("Task")} ORDER BY 1`,
						[]
					)
					const e: Entities = {
						accounts: Arr.map(trusted<ReadonlyArray<readonly [string]>>(busiest), ([a]) => a),
						tasks: Arr.map(trusted<ReadonlyArray<readonly [string]>>(tasks), ([id]) => id)
					}
					return e
				})
			const planned = plannedIndexes(m.installation)
			return yield* explore(
				{
					oracle: {
						kind: "postgresql",
						name: "PostgreSQL's plans with sequential and index scans disabled"
					},
					suite: "pg/e2e-work/plans",
					draw: drawn(caseGen),
					literal: Formatter.format,
					coverage: required<WorkFeature>(
						["a read by a busy account", "a read by another account"],
						{ cases: runs, sense: notesOnly }
					),
					kept: [],
					runs,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ sizes, pick }, cx) =>
					Effect.gen(function* () {
						cx.note(
							pickIndex(pick, 4) === 0 ? "a read by a busy account" : "a read by another account"
						)
						const e = yield* loadAt(sizes)
						const account = accountOf(e, pick)
						yield* withServedDb(m, world.server.roles.tenant, { account }, ({ ctx, load }) =>
							Effect.gen(function* () {
								const loaded = yield* load(world.reads)
								const { calls, counts } = recordingMembers(ctx)
								const problems: Array<string> = []
								for (const read of selectiveReads(e, sizes, pick, account)) {
									const before = counts.sent.length
									yield* readOnce(calls(member(loaded, read.name)))({
										params: read.params,
										facts: {}
									})
									const judged = yield* sentProblems(
										s.admin,
										read.name,
										counts.sent.slice(before),
										planned
									)
									appendAll(problems, judged)
								}
								assert.deepEqual(
									problems,
									[],
									"every selective read is planned through its indexes"
								)
							})
						)
					}).pipe(Effect.scoped)
			)
		})
	)

layer(Substrate.layer)("the worked example's plans", (it) => {
	it.effect("every selective read through its indexes, on drawn small loads", planSuite)
})
