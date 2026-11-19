/** What the properties of plans.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, pipe, String as Str } from "effect"
import type { ParamMap } from "#compiler/plan/common.ts"

import { query, v } from "#compiler/public/query.ts"
import { context, login, role } from "#compiler/public/schema.ts"
import { workload } from "#compiler/public/workload.ts"
import { defined } from "#test/support/assert.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { Id } from "#test/support/ids.ts"
import { migratedOnceTemplate, rebuild } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { pickGen, pickIndex } from "#test/support/pick.ts"

export interface Sizes {
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
export const caseGen: Gen<{ readonly sizes: Sizes; readonly pick: number }> = (source) => ({
	sizes: source.draw(sizesGen),
	pick: source.draw(pickGen)
})

/** The entities a case asks about: accounts busiest first, and task ids. */
export interface Entities {
	readonly accounts: ReadonlyArray<string>
	readonly tasks: ReadonlyArray<string>
}

export type WorkFeature = "a read by a busy account" | "a read by another account"

/** The rows numbered 0 to `rows - 1`, as a FROM clause. */
export const series = (rows: number): string =>
	`FROM pg_catalog.generate_series(0, ${rows - 1}) AS s(g)`

/** The name the load gives the account numbered `n`. */
const accountName = (n: number): string => `account ${pipe(String(n), Str.padStart(6, "0"))}`

/**
 * Work's tenant world over the schema built under `name`: a token's Tenant claim names one account, and the tenant reads
 * that account, its tasks, and each of its tasks' automatic, manual and note facts, each a query entry its claim
 * filters, writing all but the account; and the tenant's selective reads over its world, its login's workload.
 */
export const tenantWorld = (name: string) => {
	const base = rebuild(W.Work, name)
	const Tenant = context("Tenant", { account: Id })
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
			.where(r.eq(account, r.param("account", Id)))
			.find({ id, budget })
	})
	const automaticBudgetFor = query(tenant).rule((r) => {
		const { id, account } = v(own.Task, "task")
		const { budget } = v(own.AutomaticTask, "automaticTask")
		return r
			.match(own.Task, { id, account, kind: "Automatic" })
			.match(own.AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", Id)))
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
			.where(r.eq(account, r.param("account", Id)))
			.find({ id, name: label, budget })
	})
	const taskCards = query(tenant)
		.rule((r) => {
			const { id, account, kind } = v(own.Task, "task")
			return r
				.match(own.Task, { id, account, kind })
				.where(r.eq(account, r.param("account", Id)))
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
		const wanted = r.relation("ids", { id: Id })
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
export const accountOf = (e: Entities, pick: number): string =>
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
export const selectiveReads = (
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
export const runs = 8

export const relations = ["Account", "Task", "AutomaticTask", "ManualTask", "TaskNote"] as const

/**
 * The worked example installed once through its generated migration, as migrated drafts and applies it
 * (support/installed.ts migratedOnceTemplate), where each case installed it: a case rebuilds the version under the
 * installed name (tenantWorld).
 */
export const workPlansTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "work plans",
	options: {
		label: "work_plans",
		first: (name) => {
			const world = tenantWorld(name)
			return { schema: world.base, logins: [world.server] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})
