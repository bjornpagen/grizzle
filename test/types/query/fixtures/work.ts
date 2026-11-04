import type { Brand, Effect, Option, Stream } from "effect"
import { Array as Arr } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DbOf } from "#adapter/types/db.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, type Decimal, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import {
	arm,
	type EvidenceOfQuery,
	type HeadOf,
	type ImmediateHeadOf,
	type ParamsOf,
	type ParamType,
	query,
	v
} from "#compiler/public/query.ts"

import {
	alternatives,
	check,
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
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, budget })
})

export type AutomaticTasksForParams = Expect<
	Equals<ParamsOf<typeof automaticTasksFor>, { readonly account: ParamType<Uuid, "uuid"> }>
>

export type AutomaticTasksForHead = Expect<
	Equals<HeadOf<typeof automaticTasksFor>, { readonly id: Uuid; readonly budget: Cents }>
>

declare const anyScopeName: string
/**
 * v names its scope with one literal, which its variables' origins carry: a bare v(R) and a name typed string, which
 * would give two scopes one type, are refused.
 */
export const unnamedScopes = () =>
	query(Work).rule((r) => {
		// @ts-expect-error -- TS2554: v takes the scope's name beside its source
		const { id } = v(Task)
		// @ts-expect-error -- TS2345 refusal: one literal name
		const { account } = v(Task, anyScopeName)
		return r.match(Task, { id, account }).find({ id })
	})

/**
 * A scope's name is a declared name in its type as in the builder: ASCII letters, digits and underscores, a letter
 * first. A name that starts with a digit or an underscore, or holds a hyphen or a character outside ASCII, is refused
 * where it is written; a valid one names its variables' scope.
 */
export const declaredScopes = () =>
	query(Work).rule((r) => {
		const task = v(Task, "task_2B")
		// @ts-expect-error -- TS2345 refusal: a declared name: ASCII letters, digits and underscores, a letter first
		const digit = v(Task, "2task")
		// @ts-expect-error -- TS2345 refusal: a declared name: ASCII letters, digits and underscores, a letter first
		const underscore = v(Task, "_task")
		// @ts-expect-error -- TS2345 refusal: a declared name: ASCII letters, digits and underscores, a letter first
		const hyphen = v(Task, "task-peer")
		// @ts-expect-error -- TS2345 refusal: a declared name: ASCII letters, digits and underscores, a letter first
		const accented = v(Task, "tâche")
		return r
			.match(Task, { id: task.id, account: digit.account, kind: underscore.kind })
			.match(Task, { id: hyphen.id, account: accented.account })
			.find({ id: task.id })
	})
/** Two arms of different headings share the discriminant kind, so the element type is the tagged union. */
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

export type TaskPayloadsHead = Expect<
	Equals<
		HeadOf<typeof taskPayloads>,
		| {
				readonly id: Uuid
				readonly account: Uuid
				readonly kind: "Automatic"
				readonly budget: Cents
		  }
		| {
				readonly id: Uuid
				readonly account: Uuid
				readonly kind: "Manual"
				readonly operator: string
		  }
	>
>

/** Binding the discriminant selects one arm, whose fields may then be bound. */
export const manualOperators = query(Work).rule((r) => {
	const { id, operator } = v(taskPayloads, "taskPayloads")
	return r.match(taskPayloads, { kind: "Manual", id, operator }).find({ id, operator })
})

export type ManualOperatorsHead = Expect<
	Equals<HeadOf<typeof manualOperators>, { readonly id: Uuid; readonly operator: string }>
>

/**
 * Without the discriminant only the fields common to every arm may be bound, and a bound discriminant admits only the
 * fields of the arm it selects.
 */
export const refusedArmBindings = () => [
	query(Work).rule((r) => {
		const { id, operator } = v(taskPayloads, "taskPayloads")
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(taskPayloads, { id, operator }).find({ id })
	}),
	query(Work).rule((r) => {
		const { id, budget } = v(taskPayloads, "taskPayloads")
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(taskPayloads, { kind: "Manual", id, budget }).find({ id })
	})
]

/** A relation parameter is a set-valued source, an array or a Stream of facts. */
export const tasksById = query(Work).rule((r) => {
	const wanted = r.relation("ids", { id: uuid })
	const { id, kind } = v(Task, "task")
	return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
})

export type TasksByIdParams = Expect<
	Equals<
		ParamsOf<typeof tasksById>,
		{
			readonly ids: ReadonlyArray<{ readonly id: Uuid }> | Stream.Stream<{ readonly id: Uuid }>
		}
	>
>

/**
 * SUM over a Cents column is SUM(bigint), numeric, an exact Decimal; COUNT is bigint. The only group
 * term is bound to the parameter, so the aggregate is at most one row per binding.
 */
export const automaticBudgetFor = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})

export type AutomaticBudgetForHead = Expect<
	Equals<
		HeadOf<typeof automaticBudgetFor>,
		{ readonly account: Uuid; readonly tasks: bigint; readonly budget: Decimal }
	>
>

/** take closes an ordered query into a set; bind imports it per account. */
export const largestBudgets = query(Work)
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

export const largestPerAccount = query(Work).rule((r) => {
	const { id: account } = v(Account, "account")
	const top = largestBudgets.bind({ account })
	const { id, budget } = v(top, "top")
	return r.match(Account, { id: account }).match(top, { id, budget }).find({ account, id, budget })
})
export type LargestPerAccountParams = Expect<Equals<ParamNamesOf<typeof largestPerAccount>, never>>
export type LargestPerAccountHead = Expect<
	Equals<
		HeadOf<typeof largestPerAccount>,
		{ readonly account: Uuid; readonly id: Uuid; readonly budget: Cents }
	>
>

/** A parameterless import, matched directly; the outer query introduces the parameter. */
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

export type LabeledParams = Expect<
	Equals<ParamsOf<typeof labeledAutomaticTasks>, { readonly account: ParamType<Uuid, "uuid"> }>
>

/** Relational negation and a same-heading union. */
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

/** Each arm's records: a union of arms of one heading is that heading in either arm. */
export type AssignedTasksHead = Expect<
	Equals<HeadOf<typeof assignedTasks>, { readonly id: Uuid } | { readonly id: Uuid }>
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
		const { id, account, kind } = v(Task, "task")
		return r
			.match(Task, { id, account, kind })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, kind })
	})
	.attach(
		"note",
		(t) =>
			query(Work).rule((r) => {
				const { note } = v(TaskNote, "taskNote")
				return r.match(TaskNote, { task: t.id, note }).find({ note })
			}),
		"option"
	)
	.attach(
		"automatic",
		(t) =>
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
			}),
		arm("kind", "Automatic")
	)

export type TaskCardsHead = Expect<
	Equals<
		HeadOf<typeof taskCards>,
		| {
				readonly id: Uuid
				readonly kind: "Automatic"
				readonly note: Option.Option<{ readonly note: string }>
				readonly automatic: Option.Some<{ readonly budget: Cents }>
		  }
		| {
				readonly id: Uuid
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
			readonly id: Uuid
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

export type AccountCardsHead = Expect<
	Equals<
		HeadOf<typeof accountCards>,
		{
			readonly id: Uuid
			readonly name: string
			readonly tasks: ReadonlyArray<{ readonly id: Uuid; readonly kind: "Automatic" | "Manual" }>
			readonly automaticTasks: Option.Option<{ readonly count: bigint }>
		}
	>
>

/** A prefix search is two ordering comparisons against parameters typed by the name field. */
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

export type AccountsByPrefixParams = Expect<
	Equals<
		ParamsOf<typeof accountsByPrefix>,
		{ readonly lo: ParamType<string, "text">; readonly hi: ParamType<string, "text"> }
	>
>

/** The derived summary is keyed by its group term, account. */
export const automaticBudget = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
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
	const { tasks, budget } = v(AccountBudget, "accountBudget")
	return r
		.match(AccountBudget, { account: r.param("account", uuid), tasks, budget })
		.find({ tasks, budget })
})
export type BudgetOfCard = Expect<Equals<EvidenceOfQuery<typeof budgetOf>["card"], "atMostOne">>

const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"
const taskId = "0193d8f2-7c1e-7000-8000-0000000000a2"

/** Reads through Effect, each typed by the query it runs. Never called: Db is the adapter's. */
export const reads = (
	db: DbOf<typeof Reader, unknown>,
	reports: DbOf<typeof Reporter, unknown>
) => {
	const budgetRow = db.get(automaticBudgetFor, { account: accountId })
	const task = db.get(Task, { id: taskId })
	const payloads = db.execute(taskPayloads, {})
	const overBase = reports.execute(automaticTasksFor, { account: accountId })
	const summary = reports.get(budgetOf, { account: accountId })
	return { budgetRow, task, payloads, overBase, summary }
}
type Reads = ReturnType<typeof reads>
export type BudgetRow = Expect<
	Equals<
		Reads["budgetRow"],
		Effect.Effect<
			Option.Option<{ readonly account: Uuid; readonly tasks: bigint; readonly budget: Decimal }>,
			ReadError
		>
	>
>

export const refusedReads = (db: DbOf<typeof Reader, unknown>) => {
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	const many = db.get(automaticTasksFor, { account: accountId })
	// @ts-expect-error -- TS2322: the parameters are the ones the query's uses inferred
	const wrong = db.execute(automaticTasksFor, { account: 1 })
	// @ts-expect-error -- TS2345: a query over the Reports extension is not a query over Work
	const above = db.execute(budgetOf, { account: accountId })
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
	const { account, tier } = v(Subscription, "subscription")
	const { budget } = v(Tier, "tier")
	return r
		.match(Subscription, { account, tier })
		.match(Tier, { id: tier, budget })
		.find({ account, budget })
})

export type BudgetsHead = Expect<
	Equals<HeadOf<typeof budgets>, { readonly account: Uuid; readonly budget: Cents }>
>

/**
 * A constant has a domain and a value: X.handle(member) is a term of X's enum whose column delivers the member, so it
 * stands wherever a term of the enum stands, in a check, a match, a filter, either side of a comparison and a
 * conditional, and a head keeps its member.
 */
export const Status = closed("Status", ["Draft", "Published"])
export const Stage = closed("Stage", ["Open", "Published", "Shut"])
/** A roster of Status's very members: its identity is its own, so neither's handle meets the other's column. */
export const Mirror = closed("Mirror", ["Draft", "Published"])
export const Post = relation(
	"Post",
	{ id: uuid, status: closedId(Status), stage: closedId(Stage), amount: pg.bigint, cents: Cents },
	["id"]
)
export const PublishedOnly = check("PublishedOnly", Post, (p) =>
	p.status.eq(Status.handle("Published"))
)
export const Blog = schema("Blog", { Status, Stage, Post }, [PublishedOnly])

export const published = query(Blog).rule((r) => {
	const { id } = v(Post, "post")
	return r
		.match(Post, { id, status: Status.handle("Published") })
		.find({ id, status: Status.handle("Published") })
})

export type PublishedHead = Expect<
	Equals<HeadOf<typeof published>, { readonly id: Uuid; readonly status: "Published" }>
>

/** A handle stands opposite a variable and first, where a JavaScript value never stands. */
export const draftsNotPublished = query(Blog).rule((r) => {
	const { id, status } = v(Post, "post")
	return r
		.match(Post, { id, status })
		.where(r.eq(status, Status.handle("Draft")), r.ne(Status.handle("Published"), status))
		.find({ id, status })
})

/** A conditional over two handles is a term of their enum, either member in its rows. */
export const shownAs = query(Blog).rule((r) => {
	const { id, status } = v(Post, "post")
	return r.match(Post, { id, status }).find({
		id,
		shown: Compute.cond(
			r.eq(status, Status.handle("Published")),
			Status.handle("Draft"),
			Status.handle("Published")
		)
	})
})

export type ShownAsHead = Expect<
	Equals<HeadOf<typeof shownAs>, { readonly id: Uuid; readonly shown: "Draft" | "Published" }>
>

/** A query's constant column is of its constant's domain: a handle of that roster binds there. */
export const publishedAgain = query(Blog).rule((r) => {
	const { id } = v(published, "published")
	return r.match(published, { id, status: Status.handle("Published") }).find({ id })
})

/** A handle selects the union arm whose field admits its member, as the member's JavaScript value does. */
export const manualByHandle = query(Work).rule((r) => {
	const { id, operator } = v(taskPayloads, "taskPayloads")
	return r.match(taskPayloads, { kind: Kind.handle("Manual"), id, operator }).find({ id, operator })
})

export type ManualByHandleHead = Expect<
	Equals<HeadOf<typeof manualByHandle>, { readonly id: Uuid; readonly operator: string }>
>

/**
 * A variable minted over a union of two of a three-member roster's handles has the roster's domain, so it joins the
 * roster's column, and its values are the two members.
 */
export const openOrShut = query(Blog)
	.rule((r) => {
		const { id } = v(Post, "post")
		return r
			.match(Post, { id, stage: Stage.handle("Open") })
			.find({ id, stage: Stage.handle("Open") })
	})
	.rule((r) => {
		const { id } = v(Post, "post")
		return r
			.match(Post, { id, stage: Stage.handle("Shut") })
			.find({ id, stage: Stage.handle("Shut") })
	})

export const openOrShutPosts = query(Blog).rule((r) => {
	const { id, stage } = v(openOrShut, "openOrShut")
	return r.match(openOrShut, { id, stage }).match(Post, { id, stage }).find({ id, stage })
})

export type OpenOrShutPostsHead = Expect<
	Equals<HeadOf<typeof openOrShutPosts>, { readonly id: Uuid; readonly stage: "Open" | "Shut" }>
>

/** A contract's typed constant binds at the contract's column. */
export const fiveCents = query(Blog).rule((r) => {
	const { id } = v(Post, "post")
	return r.match(Post, { id, cents: Compute.literal(Cents, 5n) }).find({ id })
})

/** The keys a union keeps when handles tell its arms apart: each arm's key with the field they fix apart. */
type TaskKeys = readonly [
	ReadonlyArray<"id" | "account" | "kind">,
	...ReadonlyArray<ReadonlyArray<"id" | "account" | "kind"> | ReadonlyArray<"id" | "kind">>
]

/** Handle discriminants in the arms' heads. */
export const taggedTasks = query(Work)
	.rule((r) => {
		const { id, account } = v(Task, "task")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.find({ id, account, kind: Kind.handle("Automatic") })
	})
	.rule((r) => {
		const { id, account } = v(Task, "task")
		return r
			.match(Task, { id, account, kind: "Manual" })
			.find({ id, account, kind: Kind.handle("Manual") })
	})

export type TaggedTasksKeys = Expect<Equals<EvidenceOfQuery<typeof taggedTasks>["keys"], TaskKeys>>

/** Handles fixing each arm's kind in a filter: r.eq with a handle fixes its variable to the member. */
export const filteredTasks = query(Work)
	.rule((r) => {
		const { id, account, kind } = v(Task, "task")
		return r
			.match(Task, { id, account, kind })
			.where(r.eq(kind, Kind.handle("Automatic")))
			.find({ id, account, kind })
	})
	.rule((r) => {
		const { id, account, kind } = v(Task, "task")
		return r
			.match(Task, { id, account, kind })
			.where(r.eq(kind, Kind.handle("Manual")))
			.find({ id, account, kind })
	})

export type FilteredTasksKeys = Expect<
	Equals<EvidenceOfQuery<typeof filteredTasks>["keys"], TaskKeys>
>

/**
 * A typed constant is of its own roster or descriptor alone: another roster's handle never meets a column, a member's
 * own value included, nor does a roster's of the very same members; a contract's constant never meets its base;
 * Compute.literal refuses a roster, whose member is X.handle(member); a handle selects the arms its member admits, so
 * another arm's field is no binding of it. Every position meets by domain and SQL type (Meets): a text term never binds
 * a uuid column, and a union's arms deliver each shared field at one type.
 */
export const refusedConstants = () => [
	query(Blog).rule((r) => {
		const { id } = v(Post, "post")
		// @ts-expect-error -- TS2322: Mirror's handle is no Status, though the two rosters hold the same members
		return r.match(Post, { id, status: Mirror.handle("Draft") }).find({ id })
	}),
	query(Work).rule((r) => {
		const { task, operator } = v(ManualTask, "manualTask")
		// @ts-expect-error -- TS2322: a text term never meets a uuid column
		return r.match(ManualTask, { task, operator }).match(Task, { id: operator }).find({ task })
	}),
	query(Blog)
		.rule((r) => {
			const { id } = v(Post, "post")
			return r.match(Post, { id }).find({ id, s: Status.handle("Draft") })
		})
		// @ts-expect-error -- TS2345 refusal: a union's arms deliver each field at one type
		.rule((r) => {
			const { id } = v(Post, "post")
			return r.match(Post, { id }).find({ id, s: Stage.handle("Open") })
		}),
	query(Work)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			const { budget } = v(AutomaticTask, "automaticTask")
			return r
				.match(Task, { id, account })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, budget })
		})
		// @ts-expect-error -- TS2345 refusal: arms of different headings share a field that holds a different constant in each
		.rule((r) => {
			const { id, account } = v(Task, "task")
			const { operator } = v(ManualTask, "manualTask")
			return r
				.match(Task, { id, account })
				.match(ManualTask, { task: id, operator })
				.find({ id, operator })
		}),
	query(Blog).rule((r) => {
		const { id } = v(Post, "post")
		// @ts-expect-error -- TS2322: a Status handle is no Stage, though both rosters hold Published
		return r.match(Post, { id, stage: Status.handle("Published") }).find({ id })
	}),
	query(Blog).rule((r) => {
		const { id } = v(Post, "post")
		// @ts-expect-error -- TS2322: a Cents constant never meets a bare bigint
		return r.match(Post, { id, amount: Compute.literal(Cents, 5n) }).find({ id })
	}),
	// @ts-expect-error -- TS2345: a roster's member is X.handle(member), never Compute.literal
	Compute.literal(closedId(Kind), "Manual"),
	query(Work).rule((r) => {
		const { id, operator } = v(taskPayloads, "taskPayloads")
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(taskPayloads, { kind: Kind.handle("Automatic"), id, operator }).find({ id })
	})
]

/**
 * An attached arm shares its heading with no other arm of its union, whether it comes first, joins later, or is a
 * query's attachment, as the checker refuses it: a fact both arms deliver would carry one arm's attachment and not the
 * other's.
 */
export const attachedArms = () => [
	query(Work)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r
				.match(Task, { id, account, kind: "Automatic" })
				.find({ id, account })
				.attach(
					"note",
					(t) =>
						query(Work).rule((q) => {
							const { note } = v(TaskNote, "taskNote")
							return q.match(TaskNote, { task: t.id, note }).find({ note })
						}),
					"option"
				)
		})
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r.match(Task, { id, account, kind: "Manual" }).find({ id, account })
		}),
	query(Work)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r.match(Task, { id, account, kind: "Manual" }).find({ id, account })
		})
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r
				.match(Task, { id, account, kind: "Automatic" })
				.find({ id, account })
				.attach(
					"note",
					(t) =>
						query(Work).rule((q) => {
							const { note } = v(TaskNote, "taskNote")
							return q.match(TaskNote, { task: t.id, note }).find({ note })
						}),
					"option"
				)
		}),
	query(Work)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r.match(Task, { id, account, kind: "Automatic" }).find({ id, account })
		})
		.attach(
			"note",
			(t) =>
				query(Work).rule((q) => {
					const { note } = v(TaskNote, "taskNote")
					return q.match(TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r.match(Task, { id, account, kind: "Manual" }).find({ id, account })
		})
]

/** The automatic tasks, each with its kind and its note: an attached query of its own heading. */
const notedAutomatic = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.find({ id, account, kind: Kind.handle("Automatic") })
		.attach(
			"note",
			(t) =>
				query(Work).rule((q) => {
					const { note } = v(TaskNote, "taskNote")
					return q.match(TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
})

/**
 * An arm's attachment is its records', so every stage that keeps them keeps it: a take and the order it closes, a
 * name, and the two in turn. Under each the arm shares its heading with no other arm, as the checker reads the
 * attachment off the arm's rows.
 */
export const wrappedAttachedArms = () => [
	notedAutomatic
		.orderBy(["id", "asc"])
		.take(5)
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r
				.match(Task, { id, account, kind: "Manual" })
				.find({ id, account, kind: Kind.handle("Manual") })
		}),
	notedAutomatic
		.named("notedAutomatic")
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r
				.match(Task, { id, account, kind: "Manual" })
				.find({ id, account, kind: Kind.handle("Manual") })
		}),
	notedAutomatic
		.named("notedAutomatic")
		.orderBy(["account", "desc"])
		.take("batch")
		// @ts-expect-error -- TS2345 refusal: an attachment on an arm of a union whose heading several arms share
		.rule((r) => {
			const { id, account } = v(Task, "task")
			return r
				.match(Task, { id, account, kind: "Manual" })
				.find({ id, account, kind: Kind.handle("Manual") })
		})
]

/** Under each stage, an attached arm still joins an arm of another heading its constants tell apart. */
export const wrappedAttachedArmsApart = () => [
	notedAutomatic
		.orderBy(["id", "asc"])
		.take(5)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			const { operator } = v(ManualTask, "manualTask")
			return r
				.match(Task, { id, account, kind: "Manual" })
				.match(ManualTask, { task: id, operator })
				.find({ id, account, kind: Kind.handle("Manual"), operator })
		}),
	notedAutomatic.named("notedAutomatic").rule((r) => {
		const { id, account } = v(Task, "task")
		const { operator } = v(ManualTask, "manualTask")
		return r
			.match(Task, { id, account, kind: "Manual" })
			.match(ManualTask, { task: id, operator })
			.find({ id, account, kind: Kind.handle("Manual"), operator })
	}),
	notedAutomatic
		.named("notedAutomatic")
		.orderBy(["account", "desc"])
		.take("batch")
		.rule((r) => {
			const { id, account } = v(Task, "task")
			const { operator } = v(ManualTask, "manualTask")
			return r
				.match(Task, { id, account, kind: "Manual" })
				.match(ManualTask, { task: id, operator })
				.find({ id, account, kind: Kind.handle("Manual"), operator })
		})
]
