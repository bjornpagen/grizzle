import type { WorkloadPlan } from "#compiler/program/workload/compile.ts"
import { workload } from "#compiler/program/workload/value.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { compileTestWorkload, testCompile } from "#test/support/compile.ts"
import * as Sp from "#test/support/fixtures/api/spans.ts"
import * as W from "#test/support/fixtures/api/work.ts"

/**
 * Workloads for the workload tests, over the real builders and the public-API fixtures (test/support/fixtures/api).
 *
 * The schemas beyond the examples are marked: Board is the pagination example's Task with the account filter, ordered by priority,
 * and a bounded title, so its prefix search is representable.
 */

export { Sp, W }

/** The worked example's described arm switch. */
export const switchToManualDescribed = ChangeSet.empty(W.Work)
	.put(
		W.Task,
		query(W.Work).rule((r) => {
			const { account } = v(W.Task, "task")
			return r
				.match(W.Task, { id: r.param("task", W.Task.fields.id), account, kind: "Automatic" })
				.find({ id: r.param("task", W.Task.fields.id), account, kind: "Manual" })
		})
	)
	.delete(
		W.AutomaticTask,
		query(W.Work).rule((r) => {
			const { budget } = v(W.AutomaticTask, "automaticTask")
			return r
				.match(W.AutomaticTask, { task: r.param("task", W.AutomaticTask.fields.task), budget })
				.find({ task: r.param("task", W.AutomaticTask.fields.task), budget })
		})
	)
	.insert(
		W.ManualTask,
		query(W.Work).rule((r) =>
			r.match(W.Task, { id: r.param("task", W.Task.fields.id), kind: "Automatic" }).find({
				task: r.param("task", W.ManualTask.fields.task),
				operator: r.param("operator", W.ManualTask.fields.operator)
			})
		)
	)
	.read("previous", (delta) =>
		query(W.Work).rule((r) => {
			const { task, budget } = v(delta.removed(W.AutomaticTask), "removedAutomaticTask")
			return r.match(delta.removed(W.AutomaticTask), { task, budget }).find({ task, budget })
		})
	)

/** The worked example's programs, as the fixtures export them. */
export const workPrograms = {
	automaticTasksFor: W.automaticTasksFor,
	taskPayloads: W.taskPayloads,
	tasksById: W.tasksById,
	automaticBudgetFor: W.automaticBudgetFor,
	largestPerAccount: W.largestPerAccount,
	labeledAutomaticTasks: W.labeledAutomaticTasks,
	tasksWithoutNotes: W.tasksWithoutNotes,
	assignedTasks: W.assignedTasks,
	taskCards: W.taskCards,
	accountCards: W.accountCards,
	accountsByPrefix: W.accountsByPrefix,
	switchToManualDescribed
} as const

/**
 * The Board schema's Task (beyond the pagination example: a bounded title and a priority floor query for the range
 * path).
 */
const Title = str.regex("^[A-Za-z0-9 ]{1,64}$")
const BoardTask = relation(
	"Task",
	{ id: uuid, account: uuid, priority: pg.integer, title: Title },
	["id"]
)
export const Board = schema("Board", { Task: BoardTask }, [])

export const tasksForAccount = query(Board).rule((r) => {
	const { id, account, priority, title } = v(BoardTask, "boardTask")
	return r
		.match(BoardTask, { id, account, priority, title })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, priority, title })
})

/** The compiler appends the retained, proved id key in ascending order. */
export const orderedTasks = tasksForAccount.orderBy(["priority", "desc"])

/** A take bound per group requests the same shape with the group key as the equality prefix. */
export const topThree = query(Board)
	.rule((r) => {
		const { id, priority } = v(BoardTask, "boardTask")
		return r
			.match(BoardTask, { id, account: r.param("account", BoardTask.fields.account), priority })
			.find({ id, priority })
	})
	.orderBy(["priority", "desc"])
	.take(3)

export const urgentAtLeast = query(Board).rule((r) => {
	const { id, account, priority } = v(BoardTask, "boardTask")
	return r
		.match(BoardTask, { id, account, priority })
		.where(r.eq(account, r.param("account", uuid)), r.ge(priority, r.param("floor", pg.integer)))
		.find({ id, priority })
})

export const titlesByPrefix = query(Board).rule((r) => {
	const { id, title } = v(BoardTask, "boardTask")
	return r
		.match(BoardTask, { id, title })
		.where(
			r.ge(title, r.param("lo", BoardTask.fields.title)),
			r.lt(title, r.param("hi", BoardTask.fields.title))
		)
		.find({ id, title })
})

/** The login the workload tests' workloads are owned by, which a plan records their programs' access under. */
export const fixtureLogin = "server"

/**
 * The plan of one workload of `programs` over `schemaValue`, owned by `fixtureLogin`, as the generator plans a
 * login's workloads.
 */
export const planOf = (
	schemaValue: unknown,
	programs: Readonly<Record<string, unknown>>
): WorkloadPlan => {
	const r = compileTestWorkload(
		[{ login: fixtureLogin, workloads: [workload(schemaValue, programs)] }],
		schemaValue,
		testCompile
	)
	if (!r.ok) {
		throw new Error(r.error.message)
	}
	return r.value
}
