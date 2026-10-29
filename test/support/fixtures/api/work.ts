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
	schema
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
	(typeof Work)["statements"]
>

/**
 * Work's worlds over the schema they are given: a reader, a writer of every stored relation but Account, and the login
 * holding both.
 */
export const workWorlds = (installed: WorkNamed<string>) => {
	const reader = role(installed, "reader", installed.relations)
	const writer = role(installed, "writer", installed.relations, {
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
		const { id, account } = v(Task)
		const { budget } = v(AutomaticTask)
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, budget })
	})

	const automaticBudgetFor = query(installed).rule((r) => {
		const { id, account } = v(Task)
		const { budget } = v(AutomaticTask)
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ account, tasks: r.count(), budget: r.sum(budget) })
	})

	const largestBudgets = query(installed)
		.rule((r) => {
			const { id } = v(Task)
			const { budget } = v(AutomaticTask)
			return r
				.match(Task, { id, account: r.param("account", Task.fields.account), kind: "Automatic" })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, budget })
		})
		.orderBy(["budget", "desc"])
		.take(3)

	const largestPerAccount = query(installed).rule((r) => {
		const { id: account } = v(Account)
		const top = largestBudgets.bind({ account })
		const { id, budget } = v(top)
		return r
			.match(Account, { id: account })
			.match(top, { id, budget })
			.find({ account, id, budget })
	})

	const taskCards = query(installed)
		.rule((r) => {
			const { id, account, kind } = v(Task)
			return r
				.match(Task, { id, account, kind })
				.where(r.eq(account, r.param("account", uuid)))
				.find({ id, kind })
		})
		.attach(
			"note",
			(t) =>
				query(installed).rule((r) => {
					const { note } = v(TaskNote)
					return r.match(TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
		.attach(
			"automatic",
			(t) =>
				query(installed).rule((r) => {
					const { budget } = v(AutomaticTask)
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
		const { id, account } = v(Task)
		const { budget } = v(AutomaticTask)
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, account, kind: Kind.handle("Automatic"), budget })
	})
	.rule((r) => {
		const { id, account } = v(Task)
		const { operator } = v(ManualTask)
		return r
			.match(Task, { id, account, kind: "Manual" })
			.match(ManualTask, { task: id, operator })
			.find({ id, account, kind: Kind.handle("Manual"), operator })
	})

export const tasksById = query(Work).rule((r) => {
	const wanted = r.relation("ids", { id: uuid })
	const { id, kind } = v(Task)
	return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
})

/**
 * The automatic tasks, a parameterless import matched directly. Exported because the compile profile
 * (scripts/dev/profile/phases.ts) lowers every query a fixture module exports.
 */
export const automaticTasks = query(Work)
	.rule((r) => {
		const { id, account } = v(Task)
		const { budget } = v(AutomaticTask)
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, account, budget })
	})
	.named("automaticTasks")

export const labeledAutomaticTasks = query(Work).rule((r) => {
	const { id, account, budget } = v(automaticTasks)
	const { name } = v(Account)
	return r
		.match(automaticTasks, { id, account, budget })
		.match(Account, { id: account, name })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, name, budget })
})

export const tasksWithoutNotes = query(Work).rule((r) => {
	const { id } = v(Task)
	return r
		.match(Task, { id })
		.where(r.not(TaskNote, { task: id }))
		.find({ id })
})

export const assignedTasks = query(Work)
	.rule((r) => {
		const { id } = v(Task)
		return r.match(Task, { id, kind: "Automatic" }).find({ id })
	})
	.rule((r) => {
		const { id } = v(Task)
		return r.match(Task, { id, kind: "Manual" }).find({ id })
	})

export const accountCards = query(Work)
	.rule((r) => {
		const { id, name } = v(Account)
		return r.match(Account, { id, name }).find({ id, name })
	})
	.attach(
		"tasks",
		(a) =>
			query(Work)
				.rule((r) => {
					const { id, kind } = v(Task)
					return r.match(Task, { id, account: a.id, kind }).find({ id, kind })
				})
				.orderBy(["id", "asc"]),
		"array"
	)
	.attach(
		"automaticTasks",
		(a) =>
			query(Work).rule((r) => {
				const { id } = v(Task)
				return r.match(Task, { id, account: a.id, kind: "Automatic" }).find({ count: r.count() })
			}),
		"option"
	)

export const accountsByPrefix = query(Work).rule((r) => {
	const { id, name } = v(Account)
	return r
		.match(Account, { id, name })
		.where(
			r.ge(name, r.param("lo", Account.fields.name)),
			r.lt(name, r.param("hi", Account.fields.name))
		)
		.find({ id, name })
})

export const automaticBudget = query(Work).rule((r) => {
	const { id, account } = v(Task)
	const { budget } = v(AutomaticTask)
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

export const AccountBudget = derived("AccountBudget", automaticBudget)
export const Reports = schema.extend(Work, { AccountBudget }, [])

/** AccountBudget matched over Reports, as the reporter reads it. */
export const accountBudgets = query(Reports).rule((r) => {
	const { account, tasks, budget } = v(AccountBudget)
	return r.match(AccountBudget, { account, tasks, budget }).find({ account, tasks, budget })
})

/**
 * switchToManualDescribed's members, each the query its member describes, with parameters
 * { task, operator }.
 */
export const switchToManualPutMember = query(Work).rule((r) => {
	const { account } = v(Task)
	return r
		.match(Task, { id: r.param("task", Task.fields.id), account, kind: "Automatic" })
		.find({ id: r.param("task", uuid), account, kind: r.literal("Manual") })
})

export const switchToManualDeleteMember = query(Work).rule((r) => {
	const { budget } = v(AutomaticTask)
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

/** The Plans schema. */
const Tier = closed("Tier", ["Free", "Pro"]).with(
	{ budget: Cents },
	{ Free: { budget: Cents(100n) }, Pro: { budget: Cents(1000n) } }
)
const Subscription = relation("Subscription", { account: uuid, tier: closedId(Tier) }, ["account"])
export const Plans = schema("Plans", { Tier, Subscription }, [
	contained(on(Subscription, "tier"), on(Tier, "id"))
])

/** Plans under another name, as an installation under a unique schema name opens it. */
export type PlansNamed<N extends string> = Schema<
	N,
	(typeof Plans)["relations"],
	(typeof Plans)["statements"]
>

/** Plans' world: a reader, in its login. */
export const plansWorlds = (installed: PlansNamed<string>) => {
	const reader = role(installed, "reader", installed.relations)
	return { reader, server: login(installed, "server", [reader]) }
}

export const budgets = query(Plans).rule((r) => {
	const { account, tier } = v(Subscription)
	const { budget } = v(Tier)
	return r
		.match(Subscription, { account, tier })
		.match(Tier, { id: tier, budget })
		.find({ account, budget })
})
