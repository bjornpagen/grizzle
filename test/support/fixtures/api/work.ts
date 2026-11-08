import { closedId, uuid } from "#compiler/public/fields.ts"
import { arm, query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	derived,
	login,
	mutable,
	on,
	relation,
	role,
	type Schema,
	schema,
	type StatementsByName,
	wholeEntriesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Cents } from "#test/support/fixtures/api/contracts.ts"

export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Account = relation("Account", { id: uuid, name: str.regex("^.{1,200}$", "su") }, [
	"id"
])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const ManualTask = relation(
	"ManualTask",
	{ task: uuid, operator: str.regex("^.*$", "su") },
	["task"]
)

export const TaskNote = relation("TaskNote", { task: uuid, note: str.regex("^.*$", "su") }, [
	"task"
])

/**
 * The worked example, in public-API form: the Work schema, its Reports extension
 * and the Plans schema built by the real schema constructors, and the example's queries built by the real query
 * builder through the typed facade (packages/engine/src/public). Each value records a Description; the checker turns each
 * query into the IR test/support/fixtures/ir/work.ts states for it.
 *
 * The worlds exist only for the tests: each schema's are built over the schema they are given (the declared one, or the
 * one an installation rebuilds under its unique name), full roles all, so every program over the schema runs on them,
 * in one login. switchToManualDescribed's members are exported one query each, because a ChangeSet value is the write
 * package's.
 */
export const Work = schema("Work", { Kind, Account, Task, AutomaticTask, ManualTask, TaskNote }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(TaskNote, "task"), on(Task, "id")),
	alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask }),
	mutable(TaskNote)
])

/** The Work schema under another name, as an installation under a unique schema name opens it. */
export type WorkNamed<N extends string> = Schema<
	N,
	(typeof Work)["relations"],
	StatementsByName<(typeof Work)["statements"], (typeof Work)["relations"]>
>

/**
 * Work's worlds over the schema they are given: a reader, a writer of every stored relation but Account, and the login
 * holding both.
 */
export const workWorlds = (installed: WorkNamed<string>) => {
	const reader = role(installed, "reader", wholeEntriesOf(installed))
	const writer = role(installed, "writer", wholeEntriesOf(installed), {
		write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
	})
	return { reader, writer, server: login(installed, "server", [reader, writer]) }
}

/**
 * The reads over Work that open a database, built over the schema they are given: Work itself, or Work under the
 * name of its installation.
 */
export const workReads = <const N extends string>(installed: WorkNamed<N>) => {
	const automaticTasksFor = query(installed).rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, budget })
	})

	const automaticBudgetFor = query(installed).rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ account, tasks: r.count(), budget: r.sum(budget) })
	})

	const largestBudgets = query(installed)
		.rule((r) => {
			const { id } = v(Task, "task")
			const { budget } = v(AutomaticTask, "automaticTask")
			return r
				.match(Task, { id, account: r.param("account", Task.fields.account), kind: "Automatic" })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, budget })
		})
		.orderBy(["budget", "desc"])
		.take(3)

	const largestPerAccount = query(installed).rule((r) => {
		const { id: account } = v(Account, "account")
		const top = largestBudgets.bind({ account })
		const { id, budget } = v(top, "top")
		return r
			.match(Account, { id: account })
			.match(top, { id, budget })
			.find({ account, id, budget })
	})

	const taskCards = query(installed)
		.rule((r) => {
			const { id, account, kind } = v(Task, "task")
			return r
				.match(Task, { id, account, kind })
				.where(r.eq(account, r.param("account", uuid)))
				.find({ id, kind })
		})
		.attach(
			"note",
			(t) =>
				query(installed).rule((r) => {
					const { note } = v(TaskNote, "taskNote")
					return r.match(TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
		.attach(
			"automatic",
			(t) =>
				query(installed).rule((r) => {
					const { budget } = v(AutomaticTask, "automaticTask")
					return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
				}),
			arm("kind", "Automatic")
		)
	return {
		automaticTasksFor,
		automaticBudgetFor,
		largestBudgets,
		largestPerAccount,
		taskCards
	} as const
}

export const {
	automaticTasksFor,
	automaticBudgetFor,
	largestBudgets,
	largestPerAccount,
	taskCards
} = workReads(Work)

export const taskPayloads = query(Work)
	.rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, account, kind: Kind.handle("Automatic"), budget })
	})
	.rule((r) => {
		const { id, account } = v(Task, "task")
		const { operator } = v(ManualTask, "manualTask")
		return r
			.match(Task, { id, account, kind: "Manual" })
			.match(ManualTask, { task: id, operator })
			.find({ id, account, kind: Kind.handle("Manual"), operator })
	})

export const tasksById = query(Work).rule((r) => {
	const wanted = r.relation("ids", { id: uuid })
	const { id, kind } = v(Task, "task")
	return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
})

/**
 * The automatic tasks, a parameterless import matched directly. Exported because the compile profile
 * (scripts/dev/profile/phases.ts) lowers every query a fixture module exports.
 */
export const automaticTasks = query(Work)
	.rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, account, budget })
	})
	.named("automaticTasks")

export const labeledAutomaticTasks = query(Work).rule((r) => {
	const { id, account, budget } = v(automaticTasks, "automaticTasks")
	const { name } = v(Account, "account")
	return r
		.match(automaticTasks, { id, account, budget })
		.match(Account, { id: account, name })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, name, budget })
})

export const tasksWithoutNotes = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r
		.match(Task, { id })
		.where(r.not(TaskNote, { task: id }))
		.find({ id })
})

export const assignedTasks = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Automatic" }).find({ id })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Manual" }).find({ id })
	})

export const accountCards = query(Work)
	.rule((r) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})
	.attach(
		"tasks",
		(a) =>
			query(Work)
				.rule((r) => {
					const { id, kind } = v(Task, "task")
					return r.match(Task, { id, account: a.id, kind }).find({ id, kind })
				})
				.orderBy(["id", "asc"]),
		"array"
	)
	.attach(
		"automaticTasks",
		(a) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: a.id, kind: "Automatic" }).find({ count: r.count() })
			}),
		"option"
	)

export const accountsByPrefix = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r
		.match(Account, { id, name })
		.where(
			r.ge(name, r.param("lo", Account.fields.name)),
			r.lt(name, r.param("hi", Account.fields.name))
		)
		.find({ id, name })
})

export const automaticBudget = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

export const AccountBudget = derived.materialized("AccountBudget", automaticBudget)
export const Reports = schema.extend(Work, { AccountBudget }, [])

/** AccountBudget matched over Reports, as the reporter reads it. */
export const accountBudgets = query(Reports).rule((r) => {
	const { account, tasks, budget } = v(AccountBudget, "accountBudget")
	return r.match(AccountBudget, { account, tasks, budget }).find({ account, tasks, budget })
})

/**
 * switchToManualDescribed's members, each the query its member describes, with parameters
 * { task, operator }.
 */
export const switchToManualPutMember = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	return r
		.match(Task, { id: r.param("task", Task.fields.id), account, kind: "Automatic" })
		.find({ id: r.param("task", uuid), account, kind: "Manual" })
})

export const switchToManualDeleteMember = query(Work).rule((r) => {
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(AutomaticTask, { task: r.param("task", AutomaticTask.fields.task), budget })
		.find({ task: r.param("task", uuid), budget })
})

export const switchToManualInsertMember = query(Work).rule((r) =>
	r.match(Task, { id: r.param("task", Task.fields.id), kind: "Automatic" }).find({
		task: r.param("task", uuid),
		operator: r.param("operator", ManualTask.fields.operator)
	})
)

/** The Plans schema: a roster of tiers, each tier's budget a closed relation over it. */
const Tier = closed("Tier", ["Free", "Pro"])
const TierBudget = closed.relation(
	"TierBudget",
	{ tier: closedId(Tier), budget: Cents },
	["tier"],
	[
		{ tier: "Free", budget: Cents(100n) },
		{ tier: "Pro", budget: Cents(1000n) }
	]
)
const Subscription = relation("Subscription", { account: uuid, tier: closedId(Tier) }, ["account"])
export const Plans = schema("Plans", { Tier, TierBudget, Subscription }, [
	contained(on(Subscription, "tier"), on(Tier, "id"))
])

/** Plans under another name, as an installation under a unique schema name opens it. */
export type PlansNamed<N extends string> = Schema<
	N,
	(typeof Plans)["relations"],
	StatementsByName<(typeof Plans)["statements"], (typeof Plans)["relations"]>
>

/** Plans' world: a reader of its roster and its subscriptions, in its login; no role holds a closed relation. */
export const plansWorlds = (installed: PlansNamed<string>) => {
	const { Tier: tier, Subscription: subscription } = installed.relations
	const reader = role(installed, "reader", { Tier: tier, Subscription: subscription })
	return { reader, server: login(installed, "server", [reader]) }
}

export const budgets = query(Plans).rule((r) => {
	const { account, tier } = v(Subscription, "subscription")
	const { budget } = v(TierBudget, "tierBudget")
	return r
		.match(Subscription, { account, tier })
		.match(TierBudget, { tier, budget })
		.find({ account, budget })
})
