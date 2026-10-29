import type { Brand, Effect, Option, Stream } from "effect"
import { Array as Arr } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DbOf } from "#adapter/types/db.ts"
import { closedId, contract, type Decimal, pg, uuid } from "#compiler/public/fields.ts"
import {
	arm,
	type EvidenceOfQuery,
	type HeadOf,
	type ImmediateHeadOf,
	type ParamsOf,
	query,
	v
} from "#compiler/public/query.ts"

import {
	alternatives,
	closed,
	contained,
	derived,
	mutable,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Equals, Expect } from "#test/types/query/support.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * The worked example through the public facade: the Work schema, its queries, the derived AccountBudget
 * and the Plans schema, each built by the real builders (query/api.ts over query/build) and typed by types/query.
 * Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line; refusals sit inside
 * functions the runtime check never calls, because the fixtures also run.
 */
type Cents = bigint & Brand.Brand<"Cents">

export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
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

export const Work = schema("Work", { Kind, Account, Task, AutomaticTask, ManualTask, TaskNote }, [
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(TaskNote, "task"), on(Task, "id")),
	alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask }),
	mutable(TaskNote)
])
export const Reader = role(Work, "reader", Work.relations)
export const Writer = role(Work, "writer", Work.relations, {
	write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
})

/** The shared id variable is the join; the parameter is typed by its use. */
export const automaticTasksFor = query(Work).rule((r) => {
	const { id, account } = v(Task)
	const { budget } = v(AutomaticTask)
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, budget })
})

export type AutomaticTasksForParams = Expect<
	Equals<ParamsOf<typeof automaticTasksFor>, { readonly account: string }>
>

export type AutomaticTasksForHead = Expect<
	Equals<HeadOf<typeof automaticTasksFor>, { readonly id: string; readonly budget: Cents }>
>

/** Two arms of different headings share the discriminant kind, so the element type is the tagged union. */
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

export type TaskPayloadsHead = Expect<
	Equals<
		HeadOf<typeof taskPayloads>,
		| {
				readonly id: string
				readonly account: string
				readonly kind: "Automatic"
				readonly budget: Cents
		  }
		| {
				readonly id: string
				readonly account: string
				readonly kind: "Manual"
				readonly operator: string
		  }
	>
>

/** Binding the discriminant selects one arm, whose fields may then be bound. */
export const manualOperators = query(Work).rule((r) => {
	const { id, operator } = v(taskPayloads)
	return r.match(taskPayloads, { kind: "Manual", id, operator }).find({ id, operator })
})

export type ManualOperatorsHead = Expect<
	Equals<HeadOf<typeof manualOperators>, { readonly id: string; readonly operator: string }>
>

/**
 * Without the discriminant only the fields common to every arm may be bound, and a bound discriminant admits only the
 * fields of the arm it selects.
 */
export const refusedArmBindings = () => [
	query(Work).rule((r) => {
		const { id, operator } = v(taskPayloads)
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(taskPayloads, { id, operator }).find({ id })
	}),
	query(Work).rule((r) => {
		const { id, budget } = v(taskPayloads)
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(taskPayloads, { kind: "Manual", id, budget }).find({ id })
	})
]

/** A relation parameter is a set-valued source, an array or a Stream of facts. */
export const tasksById = query(Work).rule((r) => {
	const wanted = r.relation("ids", { id: uuid })
	const { id, kind } = v(Task)
	return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
})

export type TasksByIdParams = Expect<
	Equals<
		ParamsOf<typeof tasksById>,
		{
			readonly ids: ReadonlyArray<{ readonly id: string }> | Stream.Stream<{ readonly id: string }>
		}
	>
>

/**
 * SUM over a Cents column is SUM(bigint), numeric, an exact Decimal; COUNT is bigint. The only group
 * term is bound to the parameter, so the aggregate is at most one row per binding.
 */
export const automaticBudgetFor = query(Work).rule((r) => {
	const { id, account } = v(Task)
	const { budget } = v(AutomaticTask)
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

export type AutomaticBudgetForHead = Expect<
	Equals<
		HeadOf<typeof automaticBudgetFor>,
		{ readonly account: string; readonly tasks: bigint; readonly budget: Decimal }
	>
>

/** take closes an ordered query into a set; bind imports it per account. */
export const largestBudgets = query(Work)
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

export const largestPerAccount = query(Work).rule((r) => {
	const { id: account } = v(Account)
	const top = largestBudgets.bind({ account })
	const { id, budget } = v(top)
	return r.match(Account, { id: account }).match(top, { id, budget }).find({ account, id, budget })
})
export type LargestPerAccountParams = Expect<Equals<ParamNamesOf<typeof largestPerAccount>, never>>
export type LargestPerAccountHead = Expect<
	Equals<
		HeadOf<typeof largestPerAccount>,
		{ readonly account: string; readonly id: string; readonly budget: Cents }
	>
>

/** A parameterless import, matched directly; the outer query introduces the parameter. */
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

export type LabeledParams = Expect<
	Equals<ParamsOf<typeof labeledAutomaticTasks>, { readonly account: string }>
>

/** Relational negation and a same-heading union. */
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

/** Each arm's records: a union of arms of one heading is that heading in either arm. */
export type AssignedTasksHead = Expect<
	Equals<HeadOf<typeof assignedTasks>, { readonly id: string } | { readonly id: string }>
>

/**
 * Attachments. The note is an Option by its key. The automatic arm is Some when kind is "Automatic"
 * and None otherwise, because the alternatives law proves it, so the heading is a union discriminated by kind and
 * narrowing on kind narrows the attachment. Inside a write transaction the arm's
 * mirrors may be false before COMMIT, so the immediate heading keeps an Option. The task list is a set in
 * its completed order, and the count an Option, because an aggregate over nothing is no row.
 */
export const taskCards = query(Work)
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
			query(Work).rule((r) => {
				const { note } = v(TaskNote)
				return r.match(TaskNote, { task: t.id, note }).find({ note })
			}),
		"option"
	)
	.attach(
		"automatic",
		(t) =>
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask)
				return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
			}),
		arm("kind", "Automatic")
	)

export type TaskCardsHead = Expect<
	Equals<
		HeadOf<typeof taskCards>,
		| {
				readonly id: string
				readonly kind: "Automatic"
				readonly note: Option.Option<{ readonly note: string }>
				readonly automatic: Option.Some<{ readonly budget: Cents }>
		  }
		| {
				readonly id: string
				readonly kind: "Manual"
				readonly note: Option.Option<{ readonly note: string }>
				readonly automatic: Option.None<{ readonly budget: Cents }>
		  }
	>
>

export type TaskCardsImmediateHead = Expect<
	Equals<
		ImmediateHeadOf<typeof taskCards>,
		{
			readonly id: string
			readonly kind: "Automatic" | "Manual"
			readonly note: Option.Option<{ readonly note: string }>
			readonly automatic: Option.Option<{ readonly budget: Cents }>
		}
	>
>

/** Narrowing on the handle narrows the attachment: the Automatic arm's budget is read without a match on the Option. */
export const automaticBudgets = (
	cards: ReadonlyArray<HeadOf<typeof taskCards>>
): ReadonlyArray<Cents> =>
	Arr.flatMap(cards, (card) => (card.kind === "Automatic" ? [card.automatic.value.budget] : []))

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

export type AccountCardsHead = Expect<
	Equals<
		HeadOf<typeof accountCards>,
		{
			readonly id: string
			readonly name: string
			readonly tasks: ReadonlyArray<{ readonly id: string; readonly kind: "Automatic" | "Manual" }>
			readonly automaticTasks: Option.Option<{ readonly count: bigint }>
		}
	>
>

/** A prefix search is two ordering comparisons against parameters typed by the name field. */
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

export type AccountsByPrefixParams = Expect<
	Equals<ParamsOf<typeof accountsByPrefix>, { readonly lo: string; readonly hi: string }>
>

/** The derived summary is keyed by its group term, account. */
export const automaticBudget = query(Work).rule((r) => {
	const { id, account } = v(Task)
	const { budget } = v(AutomaticTask)
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

export type AutomaticBudgetKeys = Expect<
	Equals<EvidenceOfQuery<typeof automaticBudget>["keys"], readonly [ReadonlyArray<"account">]>
>
export const AccountBudget = derived("AccountBudget", automaticBudget)
export const Reports = schema.extend(Work, { AccountBudget }, [])
export const Reporter = role(Reports, "reporter", Reports.relations)
/** A query over Work is a query over Reports, and AccountBudget is matchable there by its inherited key. */
export const budgetOf = query(Reports).rule((r) => {
	const { tasks, budget } = v(AccountBudget)
	return r
		.match(AccountBudget, { account: r.param("account", uuid), tasks, budget })
		.find({ tasks, budget })
})
export type BudgetOfCard = Expect<Equals<EvidenceOfQuery<typeof budgetOf>["card"], "atMostOne">>

/** Reads through Effect, each typed by the query it runs. Never called: Db is the adapter's. */
export const reads = (
	db: DbOf<typeof Reader, unknown>,
	reports: DbOf<typeof Reporter, unknown>
) => {
	const budgetRow = db.get(automaticBudgetFor, { account: "a" })
	const task = db.get(Task, { id: "t" })
	const payloads = db.execute(taskPayloads, {})
	const overBase = reports.execute(automaticTasksFor, { account: "a" })
	const summary = reports.get(budgetOf, { account: "a" })
	return { budgetRow, task, payloads, overBase, summary }
}
type Reads = ReturnType<typeof reads>
export type BudgetRow = Expect<
	Equals<
		Reads["budgetRow"],
		Effect.Effect<
			Option.Option<{ readonly account: string; readonly tasks: bigint; readonly budget: Decimal }>,
			ReadError
		>
	>
>

export const refusedReads = (db: DbOf<typeof Reader, unknown>) => {
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	const many = db.get(automaticTasksFor, { account: "a" })
	// @ts-expect-error -- TS2322: the parameters are the ones the query's uses inferred
	const wrong = db.execute(automaticTasksFor, { account: 1 })
	// @ts-expect-error -- TS2345: a query over the Reports extension is not a query over Work
	const above = db.execute(budgetOf, { account: "a" })
	return [many, wrong, above]
}

/** Closed facts with payloads stay queryable; budget is the payload's contract. */
export const Tier = closed("Tier", ["Free", "Pro"]).with(
	{ budget: Cents },
	{ Free: { budget: Cents(100n) }, Pro: { budget: Cents(1000n) } }
)

export const Subscription = relation("Subscription", { account: uuid, tier: closedId(Tier) }, [
	"account"
])

export const Plans = schema("Plans", { Tier, Subscription }, [
	contained(on(Subscription, "tier"), on(Tier, "id"))
])

export const budgets = query(Plans).rule((r) => {
	const { account, tier } = v(Subscription)
	const { budget } = v(Tier)
	return r
		.match(Subscription, { account, tier })
		.match(Tier, { id: tier, budget })
		.find({ account, budget })
})

export type BudgetsHead = Expect<
	Equals<HeadOf<typeof budgets>, { readonly account: string; readonly budget: Cents }>
>
