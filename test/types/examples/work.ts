import type { Brand, Option, Stream } from "effect"
import { Effect, Option as Opt } from "effect"
import {
	type ApplyOutcome,
	alternatives,
	arm,
	ChangeSet,
	closed,
	closedId,
	contained,
	contract,
	workload,
	Db,
	derived,
	type HeadOf,
	login,
	mutable,
	on,
	type ParamsOf,
	type ParamType,
	pg,
	query,
	relation,
	role,
	schema,
	str,
	type Uuid,
	uuid,
	v
} from "#index.ts"
import { prefixBounds } from "#test/support/prefix.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * The worked example (the Work schema, its queries, ChangeSets and the Reports level) against the public API
 * (packages/grizzle/src/index.ts), with no type assertion anywhere; its prefix search's interval is test support's
 * (test/support/prefix.ts). It typechecks under the repository's tsc with Effect diagnostics as
 * errors, and every heading, parameter map and outcome is pinned below exactly.
 *
 * The program is a function of the schema's declared name, because a query carries its schema invariantly, name
 * included: workExample("Work") is the worked example's program, and workExample(installed) the same program over an
 * installation. The ids a ChangeSet writes are its inputs, as the document's free variables taskId, accountId,
 * previousBudget and operatorName are.
 */
type Equals<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

export type Cents = bigint & Brand.Brand<"Cents">

/** The ids and values a ChangeSet of the worked example writes. */
export interface SwitchInputs {
	readonly taskId: Uuid
	readonly accountId: Uuid
	readonly previousBudget: Cents
	readonly operatorName: string
}

export const workExample = <const N extends string>(schemaName: N) => {
	const Kind = closed("Kind", ["Automatic", "Manual"])
	const Cents = contract("Cents", pg.bigint, (cents) => cents.ge(0n))

	const Account = relation("Account", { id: uuid, name: str.regex("^.{1,200}$", "su") }, ["id"])
	const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
	const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
	const ManualTask = relation("ManualTask", { task: uuid, operator: str.regex("^.*$", "su") }, [
		"task"
	])
	const TaskNote = relation("TaskNote", { task: uuid, note: str.regex("^.*$", "su") }, ["task"])

	const Work = schema(schemaName, { Kind, Account, Task, AutomaticTask, ManualTask, TaskNote }, [
		contained(on(Task, "account"), on(Account, "id")),
		contained(on(TaskNote, "task"), on(Task, "id")),
		alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask }),
		mutable(TaskNote)
	])

	const automaticTasksFor = query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, budget })
	})

	const taskPayloads = query(Work)
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

	const tasksById = query(Work).rule((r) => {
		const wanted = r.relation("ids", { id: uuid })
		const { id, kind } = v(Task, "task")
		return r.match(wanted, { id }).match(Task, { id, kind }).find({ id, kind })
	})

	const automaticBudgetFor = query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ account, tasks: r.count(), budget: r.sum(budget) })
	})

	const largestBudgets = query(Work)
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

	const largestPerAccount = query(Work).rule((r) => {
		const { id: account } = v(Account, "account")
		const top = largestBudgets.bind({ account })
		const { id, budget } = v(top, "top")
		return r
			.match(Account, { id: account })
			.match(top, { id, budget })
			.find({ account, id, budget })
	})

	const automaticTasks = query(Work)
		.rule((r) => {
			const { id, account } = v(Task, "task")
			const { budget } = v(AutomaticTask, "automaticTask")
			return r
				.match(Task, { id, account, kind: "Automatic" })
				.match(AutomaticTask, { task: id, budget })
				.find({ id, account, budget })
		})
		.named("automaticTasks")

	const labeledAutomaticTasks = query(Work).rule((r) => {
		const { id, account, budget } = v(automaticTasks, "automaticTasks")
		const { name } = v(Account, "account")
		return r
			.match(automaticTasks, { id, account, budget })
			.match(Account, { id: account, name })
			.where(r.eq(account, r.param("account", uuid)))
			.find({ id, name, budget })
	})

	const tasksWithoutNotes = query(Work).rule((r) => {
		const { id } = v(Task, "task")
		return r
			.match(Task, { id })
			.where(r.not(TaskNote, { task: id }))
			.find({ id })
	})

	const assignedTasks = query(Work)
		.rule((r) => {
			const { id } = v(Task, "task")
			return r.match(Task, { id, kind: "Automatic" }).find({ id })
		})
		.rule((r) => {
			const { id } = v(Task, "task")
			return r.match(Task, { id, kind: "Manual" }).find({ id })
		})

	const taskCards = query(Work)
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

	const accountCards = query(Work)
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

	const accountsByPrefix = query(Work).rule((r) => {
		const { id, name } = v(Account, "account")
		return r
			.match(Account, { id, name })
			.where(
				r.ge(name, r.param("lo", Account.fields.name)),
				r.lt(name, r.param("hi", Account.fields.name))
			)
			.find({ id, name })
	})

	const automaticBudget = query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, account, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ account, tasks: r.count(), budget: r.sum(budget) })
	})

	const AccountBudget = derived("AccountBudget", automaticBudget)
	const Reports = schema.extend(Work, { AccountBudget }, [])

	/**
	 * The worlds: full roles over Reports, so every program over Work runs on each, in one login. The reader reads, the
	 * writer writes every stored relation but Account, and the refresher refreshes AccountBudget.
	 */
	const Reader = role(Reports, "reader", Reports.relations)
	const Writer = role(Reports, "writer", Reports.relations, {
		write: ["Task", "AutomaticTask", "ManualTask", "TaskNote"]
	})
	const Refresher = role(Reports, "refresher", Reports.relations, { refresh: ["AccountBudget"] })
	const Server = login(Reports, "server", [Reader, Writer, Refresher])

	/** The reporter's read of the derived relation the refresher maintains. */
	const accountBudgets = query(Reports).rule((r) => {
		const { account, tasks, budget } = v(AccountBudget, "accountBudget")
		return r.match(AccountBudget, { account, tasks, budget }).find({ account, tasks, budget })
	})

	const switchToManual = (input: SwitchInputs) =>
		ChangeSet.empty(Work)
			.put(Task, [{ id: input.taskId, account: input.accountId, kind: "Manual" }])
			.delete(AutomaticTask, [{ task: input.taskId, budget: input.previousBudget }])
			.insert(ManualTask, [{ task: input.taskId, operator: input.operatorName }])

	const switchToManualDescribed = ChangeSet.empty(Work)
		.put(
			Task,
			query(Work).rule((r) => {
				const { account } = v(Task, "task")
				return r
					.match(Task, { id: r.param("task", Task.fields.id), account, kind: "Automatic" })
					.find({ id: r.param("task", Task.fields.id), account, kind: "Manual" })
			})
		)
		.delete(
			AutomaticTask,
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r
					.match(AutomaticTask, { task: r.param("task", AutomaticTask.fields.task), budget })
					.find({ task: r.param("task", AutomaticTask.fields.task), budget })
			})
		)
		.insert(
			ManualTask,
			query(Work).rule((r) =>
				r.match(Task, { id: r.param("task", Task.fields.id), kind: "Automatic" }).find({
					task: r.param("task", ManualTask.fields.task),
					operator: r.param("operator", ManualTask.fields.operator)
				})
			)
		)
		.read("previous", (delta) =>
			query(Work).rule((r) => {
				const { task, budget } = v(delta.removed(AutomaticTask), "removedAutomaticTask")
				return r.match(delta.removed(AutomaticTask), { task, budget }).find({ task, budget })
			})
		)

	const WorkWorkload = workload(Work, {
		automaticTasksFor,
		taskPayloads,
		tasksById,
		automaticBudgetFor,
		largestPerAccount,
		labeledAutomaticTasks,
		tasksWithoutNotes,
		assignedTasks,
		taskCards,
		accountCards,
		accountsByPrefix,
		switchToManualDescribed
	})

	return {
		Kind,
		Cents,
		Account,
		Task,
		AutomaticTask,
		ManualTask,
		TaskNote,
		Work,
		automaticTasksFor,
		taskPayloads,
		tasksById,
		automaticBudgetFor,
		largestBudgets,
		largestPerAccount,
		automaticTasks,
		labeledAutomaticTasks,
		tasksWithoutNotes,
		assignedTasks,
		taskCards,
		accountCards,
		accountsByPrefix,
		automaticBudget,
		AccountBudget,
		Reports,
		accountBudgets,
		switchToManual,
		switchToManualDescribed,
		WorkWorkload,
		Reader,
		Writer,
		Refresher,
		Server
	}
}

/**
 * The document's programs, Effects over the Work it is given, each opening its role through the login, whose layer
 * holds the committed snapshot.
 */
export const workPrograms = <const N extends string>(W: ReturnType<typeof workExample<N>>) => {
	const refreshed = Effect.scoped(
		Effect.gen(function* () {
			const db = yield* Db.open(W.Server.roles.refresher, {})
			yield* db.refresh(W.AccountBudget)
		})
	)

	const readBudget = (validatedAccountId: Uuid) =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* Db.open(W.Server.roles.reader, {})
				const result = yield* db.execute(W.automaticBudgetFor, {
					account: validatedAccountId
				})
				return yield* result.collect
			})
		)

	const applied = (input: SwitchInputs) =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* Db.open(W.Server.roles.writer, {})
				return yield* db.apply(W.switchToManual(input), {})
			})
		)

	const appliedDescribed = (taskId: Uuid, operatorName: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				const db = yield* Db.open(W.Server.roles.writer, {})
				return yield* db.apply(W.switchToManualDescribed, { task: taskId, operator: operatorName })
			})
		)

	/** The prefix search: absent when the typed prefix has no upper bound. */
	const byPrefix = (typed: string) =>
		Effect.scoped(
			Effect.gen(function* () {
				const bounds = prefixBounds(typed)
				if (bounds === undefined) {
					return Opt.none()
				}
				const db = yield* Db.open(W.Server.roles.reader, {})
				return Opt.some(yield* (yield* db.execute(W.accountsByPrefix, bounds)).collect)
			})
		)

	return { refreshed, readBudget, applied, appliedDescribed, byPrefix }
}

/** The exact types of the program's results, pinned on the program under its own name. */
type W = ReturnType<typeof workExample<"Work">>

/** One variant per rule, the discriminant a literal. */
export type TaskPayloads = Expect<
	Equals<
		HeadOf<W["taskPayloads"]>,
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

export type AutomaticTasksForParams = Expect<
	Equals<ParamsOf<W["automaticTasksFor"]>, { readonly account: ParamType<Uuid, "uuid"> }>
>

export type AutomaticTasksForHead = Expect<
	Equals<HeadOf<W["automaticTasksFor"]>, { readonly id: Uuid; readonly budget: Cents }>
>

/** A relation parameter is a list or a stream of its rows. */
export type TasksByIdParams = Expect<
	Equals<
		ParamsOf<W["tasksById"]>,
		{
			readonly ids: ReadonlyArray<{ readonly id: Uuid }> | Stream.Stream<{ readonly id: Uuid }>
		}
	>
>
/** Count is bigint, and the sum of a bigint contract is numeric. */
export type AutomaticBudgetForHead = HeadOf<W["automaticBudgetFor"]>
export type AutomaticBudgetForTasks = Expect<Equals<AutomaticBudgetForHead["tasks"], bigint>>
export type LargestPerAccountParams = Expect<Equals<ParamNamesOf<W["largestPerAccount"]>, never>>
export type TasksWithoutNotesHead = Expect<
	Equals<HeadOf<W["tasksWithoutNotes"]>, { readonly id: Uuid }>
>
/** An Automatic task's automatic attachment is Some, a Manual task's None. */
export type TaskCardsHead = HeadOf<W["taskCards"]>
export type AutomaticCard = Extract<TaskCardsHead, { readonly kind: "Automatic" }>
export type ManualCard = Extract<TaskCardsHead, { readonly kind: "Manual" }>
export type AutomaticCardSome = Expect<
	Equals<AutomaticCard["automatic"], Option.Some<{ readonly budget: Cents }>>
>

export type ManualCardNone = Expect<
	Equals<ManualCard["automatic"], Option.None<{ readonly budget: Cents }>>
>

export type CardNote = Expect<
	Equals<AutomaticCard["note"], Option.Option<{ readonly note: string }>>
>
/** A list attachment is a list, an aggregate attachment an Option. */
export type AccountCardsHead = HeadOf<W["accountCards"]>
export type AccountCardTasks = Expect<
	Equals<
		AccountCardsHead["tasks"],
		ReadonlyArray<{ readonly id: Uuid; readonly kind: "Automatic" | "Manual" }>
	>
>

export type AccountCardCount = Expect<
	Equals<AccountCardsHead["automaticTasks"], Option.Option<{ readonly count: bigint }>>
>

export type AccountsByPrefixParams = Expect<
	Equals<
		ParamsOf<W["accountsByPrefix"]>,
		{ readonly lo: ParamType<string, "text">; readonly hi: ParamType<string, "text"> }
	>
>

/** The read-back is delivered under its name, typed by immediate evidence. */
export type DescribedParams = Expect<
	Equals<
		ParamsOf<W["switchToManualDescribed"]>,
		{ readonly task: ParamType<Uuid, "uuid">; readonly operator: ParamType<string, "text"> }
	>
>

export type DescribedOutcome = ApplyOutcome<{
	readonly previous: ReadonlyArray<{ readonly task: Uuid; readonly budget: Cents }>
}>

export type DescribedApplied = Expect<
	Equals<
		Effect.Success<ReturnType<ReturnType<typeof workPrograms<"Work">>["appliedDescribed"]>>,
		DescribedOutcome
	>
>
