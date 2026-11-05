import type { Brand, Effect, Option } from "effect"
import { Array as Arr } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DbOf, QueryResult } from "#adapter/types/db.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import {
	arm,
	type EvidenceOfQuery,
	type HeadOf,
	type ImmediateHeadOf,
	type Origin,
	type ParamsOf,
	type ParamType,
	query,
	v
} from "#compiler/public/query.ts"

import {
	alternatives,
	closed,
	contained,
	derived,
	type KeysOf,
	key,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ChangeSet, ReadsOf } from "#compiler/types/changeset/changeset.ts"
import type { TakeOneEvidence } from "#compiler/types/evidence/evidence.ts"
import type { Equals, Expect } from "#test/types/evidence/support.ts"

/**
 * Evidence through the public facade: the
 * cardinality and keys a query's type proves relative to its inputs, the filters that fix a variable to an input, the
 * keys a plain head retains, and the deliveries it licenses every attachment to state, read back as an Option inside a
 * write transaction where a snapshot read delivers the one child or an arm.
 * Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line; refusals sit inside
 * functions the runtime check never calls, because the fixtures also run.
 *
 * A bounded pattern, so a key over a text field is representable and every fixture query also compiles (the agreement
 * test of ../evidence.test.ts runs them through the checker and the logical analysis).
 */
const text = str.regex("^[a-z][a-z0-9-]{0,62}$")
type Cents = bigint & Brand.Brand<"Cents">
type Card<Q> = EvidenceOfQuery<Q>["card"]
type Keys<Q> = EvidenceOfQuery<Q>["keys"]

export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Plan = closed("Plan", ["Free", "Pro"]).with(
	{ budget: Cents },
	{ Free: { budget: Cents(1n) }, Pro: { budget: Cents(2n) } }
)
export const Account = relation("Account", { id: uuid, name: text, plan: closedId(Plan) }, ["id"])
export const Task = relation(
	"Task",
	{ id: uuid, account: uuid, kind: closedId(Kind), title: text },
	["id"]
)
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const ManualTask = relation("ManualTask", { task: uuid, operator: text }, ["task"])
export const TaskNote = relation("TaskNote", { task: uuid, note: text }, ["task"])
export const Label = relation("Label", { account: uuid, label: text, color: text }, [
	"account",
	"label"
])

export const TaskLabel = relation("TaskLabel", { task: uuid, account: uuid, label: text }, [
	"task",
	"label"
])
export const Sitting = relation("Sitting", { id: uuid, student: uuid, score: pg.integer }, ["id"])
export const Upgrade = relation("Upgrade", { account: uuid, target: closedId(Plan) }, ["account"])
export const byName = key(on(Account, "name"))
export const Work = schema(
	"Work",
	{
		Kind,
		Plan,
		Account,
		Task,
		AutomaticTask,
		ManualTask,
		TaskNote,
		Label,
		TaskLabel,
		Sitting,
		Upgrade
	},
	[
		byName,
		contained(on(Task, "account"), on(Account, "id")),
		contained(on(Account, "plan"), on(Plan, "id")),
		contained(on(TaskNote, "task"), on(Task, "id")),
		contained(on(TaskLabel, "account", "label"), on(Label, "account", "label")),
		alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask })
	]
)
export const Reader = role(Work, "reader", Work.relations)

/** Pinning by match bindings: a key bound entirely to inputs pins its occurrence. */
export const taskById = query(Work).rule((r) => {
	const { account, kind } = v(Task, "task")
	return r.match(Task, { id: r.param("id", Task.fields.id), account, kind }).find({ account, kind })
})
export type TaskByIdCard = Expect<Equals<Card<typeof taskById>, "atMostOne">>
export const accountByName = query(Work).rule((r) => {
	const { id } = v(Account, "account")
	return r.match(Account, { id, name: r.param("name", Account.fields.name) }).find({ id })
})
export type AccountByNameCard = Expect<Equals<Card<typeof accountByName>, "atMostOne">>
export const labelsOf = query(Work).rule((r) => {
	const { label } = v(Label, "label")
	return r
		.match(Label, { account: r.param("account", Label.fields.account), label })
		.find({ label })
})
export type LabelsOfCard = Expect<Equals<Card<typeof labelsOf>, "many">>
export const labelLookup = query(Work).rule((r) => {
	const { color } = v(Label, "label")
	return r
		.match(Label, { account: r.param("account", Label.fields.account), label: "urgent", color })
		.find({ color })
})
export type LabelLookupCard = Expect<Equals<Card<typeof labelLookup>, "atMostOne">>
export const taskAndAccount = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	const { name } = v(Account, "account")
	return r
		.match(Task, { id: r.param("id", Task.fields.id), account })
		.match(Account, { id: account, name })
		.find({ name })
})
/** The pinned Task determines its account, the join variable, which pins the Account it joins: at most one row. */
export type TaskAndAccountCard = Expect<Equals<Card<typeof taskAndAccount>, "atMostOne">>

/**
 * Pinning by filters: r.eq between a variable and an input fixes the variable per binding,
 * so a key bound to it pins the occurrence as an input binding would. A conjunction fixes what its conjuncts fix; a
 * disjunction fixes nothing; a fixed field that is no key pins nothing.
 */
export const taskByFilter = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r
		.match(Task, { id, title })
		.where(r.eq(id, r.param("id", uuid)))
		.find({ title })
})
export type TaskByFilterCard = Expect<Equals<Card<typeof taskByFilter>, "atMostOne">>
export const taskByLiteral = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r
		.match(Task, { id, title })
		.where(r.eq(id, "00000000-0000-0000-0000-000000000000"))
		.find({ title })
})
export type TaskByLiteralCard = Expect<Equals<Card<typeof taskByLiteral>, "atMostOne">>
export const labelByConjunction = query(Work).rule((r) => {
	const { account, label, color } = v(Label, "label")
	return r
		.match(Label, { account, label, color })
		.where(r.and(r.eq(account, r.param("account", uuid)), r.eq(label, "urgent")))
		.find({ color })
})
export type LabelByConjunctionCard = Expect<Equals<Card<typeof labelByConjunction>, "atMostOne">>
export const labelByDisjunction = query(Work).rule((r) => {
	const { account, label, color } = v(Label, "label")
	return r
		.match(Label, { account, label, color })
		.where(r.or(r.eq(account, r.param("account", uuid)), r.eq(label, "urgent")))
		.find({ color })
})
export type LabelByDisjunctionCard = Expect<Equals<Card<typeof labelByDisjunction>, "many">>
export const tasksByTitle = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r
		.match(Task, { id, title })
		.where(r.eq(title, r.param("title", Task.fields.title)))
		.find({ id })
})
export type TasksByTitleCard = Expect<Equals<Card<typeof tasksByTitle>, "many">>
/**
 * A self-join's two scopes are two types, so its evidence is a join's of two relations: a filter fixing the task
 * scope's key determines that scope's fields alone, and the peer scope's key keys the head, below its heading.
 */
export const selfJoin = query(Work).rule((r) => {
	const task = v(Task, "task")
	const peer = v(Task, "peer")
	return r
		.match(Task, { id: task.id, account: task.account })
		.match(Task, { id: peer.id, account: task.account })
		.where(r.eq(task.id, r.param("id", uuid)))
		.find({ peer: peer.id, account: task.account })
})
export type SelfJoinCard = Expect<Equals<Card<typeof selfJoin>, "many">>
export type SelfJoinKeys = Expect<
	Equals<
		Keys<typeof selfJoin>,
		readonly [ReadonlyArray<"peer" | "account">, ...ReadonlyArray<ReadonlyArray<"peer">>]
	>
>
/**
 * Both scopes' keys bound to inputs pin the self-join, which get reads; each scope keeps its origins, the fields of its
 * own fact: the task scope's account, which both matches bind, and the peer scope's title.
 */
export const pairOf = query(Work).rule((r) => {
	const task = v(Task, "task")
	const peer = v(Task, "peer")
	return r
		.match(Task, { id: r.param("task", Task.fields.id), account: task.account })
		.match(Task, { id: r.param("peer", Task.fields.id), account: task.account, title: peer.title })
		.find({ account: task.account, title: peer.title })
})
export type PairOfCard = Expect<Equals<Card<typeof pairOf>, "atMostOne">>
export type PairOfOrigins = Expect<
	Equals<
		EvidenceOfQuery<typeof pairOf>["origins"],
		{
			readonly account: Origin<"Task", "account", "task">
			readonly title: Origin<"Task", "title", "peer">
		}
	>
>
export const readsPairOf = (db: DbOf<typeof Reader, unknown>) =>
	db.get(pairOf, { task: taskId, peer: taskId })
/** The join variable bound in both matches is one variable, so fixing it pins both: at most one row. */
export const joinedFilter = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(id, r.param("id", uuid)))
		.find({ budget })
})
export type JoinedFilterCard = Expect<Equals<Card<typeof joinedFilter>, "atMostOne">>

/**
 * Aggregates: aggregate-only is at most one row, a grouped aggregate is keyed by its group terms, and group terms that
 * are inputs, bound or fixed, are one group per binding.
 */
export const taskCount = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id }).find({ tasks: r.count() })
})

export type TaskCountEvidence = Expect<
	Equals<
		EvidenceOfQuery<typeof taskCount>,
		{
			readonly keys: readonly [ReadonlyArray<never>]
			readonly card: "atMostOne"
			readonly origins: {}
		}
	>
>

export const perAccount = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ account, tasks: r.count() })
})

export type PerAccountEvidence = Expect<
	Equals<
		EvidenceOfQuery<typeof perAccount>,
		{
			readonly keys: readonly [ReadonlyArray<"account">]
			readonly card: "many"
			readonly origins: { readonly account: Origin<"Task", "account", "task"> }
		}
	>
>

export const perFixedAccount = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})
export type PerFixedAccountCard = Expect<Equals<Card<typeof perFixedAccount>, "atMostOne">>
const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"
const taskId = "0193d8f2-7c1e-7000-8000-0000000000a2"
const sittingId = "0193d8f2-7c1e-7000-8000-0000000000a3"
const studentId = "0193d8f2-7c1e-7000-8000-0000000000a4"
export const readsPerFixedAccount = (db: DbOf<typeof Reader, unknown>) =>
	db.get(perFixedAccount, { account: accountId })

/**
 * Keys a plain head retains from its only match: the head holding the variable minted at
 * each key field, or the key fixed to inputs. Filters keep the retention; a second match drops it.
 */
export const tasks = query(Work).rule((r) => {
	const { id, account, title } = v(Task, "task")
	return r.match(Task, { id, account, title }).where(r.ne(title, "x")).find({ id, account, title })
})

export type TasksKeys = Expect<
	Equals<
		Keys<typeof tasks>,
		readonly [ReadonlyArray<"id" | "account" | "title">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>

export const renamed = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r.match(Account, { id, name }).find({ accountId: id, accountName: name })
})

export type RenamedKeys = Expect<
	Equals<
		Keys<typeof renamed>,
		readonly [
			ReadonlyArray<"accountId" | "accountName">,
			...ReadonlyArray<ReadonlyArray<"accountId"> | ReadonlyArray<"accountName">>
		]
	>
>

export const labelColors = query(Work).rule((r) => {
	const { label, color } = v(Label, "label")
	return r
		.match(Label, { account: r.param("account", Label.fields.account), label, color })
		.find({ label, color })
})

/** The composite key's account is fixed to the parameter, so label alone keys the result. */
export type LabelColorsKeys = Expect<
	Equals<
		Keys<typeof labelColors>,
		readonly [ReadonlyArray<"label" | "color">, ...ReadonlyArray<ReadonlyArray<"label">>]
	>
>

export const accountLookup = query(Work).rule((r) => {
	const { name } = v(Account, "account")
	return r.match(Account, { id: r.param("id", Account.fields.id), name }).find({ name })
})

/** A key fixed entirely to inputs is the empty key: at most one row. */
export type AccountLookupKeys = Expect<
	Equals<
		Keys<typeof accountLookup>,
		readonly [ReadonlyArray<"name">, ...ReadonlyArray<ReadonlyArray<never>>]
	>
>

export const joined = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r.match(Task, { id }).match(AutomaticTask, { task: id, budget }).find({ id, budget })
})

/** A key survives the projection through the join: id determines its AutomaticTask, so it determines budget. */
export type JoinedKeys = Expect<
	Equals<
		Keys<typeof joined>,
		readonly [ReadonlyArray<"id" | "budget">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>

/**
 * The owner's example: R(id key, v) joined to S(r, x) keyed (r, x), head {id, v}: {id} is a key, since id determines v
 * under R's key whatever S binds. Here Task(id key, title) joins Label keyed (account, label) on account.
 */
export const throughJoin = query(Work).rule((r) => {
	const { id, account, title } = v(Task, "task")
	const { label } = v(Label, "label")
	return r.match(Task, { id, account, title }).match(Label, { account, label }).find({ id, title })
})

export type ThroughJoinKeys = Expect<
	Equals<
		Keys<typeof throughJoin>,
		readonly [ReadonlyArray<"id" | "title">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>

/** A key field held by no head field is lost. */
export const titlesOnly = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r.match(Task, { id, title }).find({ title })
})

export type TitlesOnlyKeys = Expect<
	Equals<Keys<typeof titlesOnly>, readonly [ReadonlyArray<"title">]>
>

/** A derived relation inherits the keys its definition proves, so the retained key types matches over it. */
export const accountNames = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r.match(Account, { id, name }).find({ id, name })
})
export const AccountNames = derived("AccountNames", accountNames)
export const Reports = schema.extend(Work, { AccountNames }, [])
export const Reporter = role(Reports, "reporter", Reports.relations)
export type AccountNamesKeys = Expect<
	Equals<
		KeysOf<typeof Reports, typeof AccountNames>,
		ReadonlyArray<"id" | "name"> | ReadonlyArray<"id"> | ReadonlyArray<"name">
	>
>

export const nameOf = query(Reports).rule((r) => {
	const { name } = v(AccountNames, "accountNames")
	return r.match(AccountNames, { id: r.param("id", uuid), name }).find({ name })
})
export type NameOfCard = Expect<Equals<Card<typeof nameOf>, "atMostOne">>
export const reportsGet = (db: DbOf<typeof Reporter, unknown>) => db.get(nameOf, { id: accountId })

/** take(1) is at most one row, and keeps the keys. */
export const newest = tasks.orderBy(["id", "desc"]).take(1)
export type NewestEvidence = Expect<
	Equals<EvidenceOfQuery<typeof newest>, TakeOneEvidence<EvidenceOfQuery<typeof tasks>>>
>
export type NewestCard = Expect<Equals<Card<typeof newest>, "atMostOne">>
/**
 * A union of one heading is what the engine proves of it: two arms can each return a row, so it is keyed by its whole
 * heading; a key of both arms joined with a field they fix to different literals tells their rows apart; and a field
 * every arm fixes to one value is fixed, so a union whose every field is, is at most one row.
 */
export const both = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Automatic" }).find({ id })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Manual" }).find({ id })
	})

export type BothEvidence = Expect<
	Equals<
		EvidenceOfQuery<typeof both>,
		{ readonly keys: readonly [ReadonlyArray<"id">]; readonly card: "many" }
	>
>

export const byKind = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Automatic" }).find({ id, kind: "automatic" })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Manual" }).find({ id, kind: "manual" })
	})

export type ByKindKeys = Expect<
	Equals<
		Keys<typeof byKind>,
		readonly [ReadonlyArray<"id" | "kind">, ...ReadonlyArray<ReadonlyArray<"id" | "kind">>]
	>
>

/** Whether some task of either kind exists: one row, which both arms state alike. */
export const anyTask = query(Work)
	.rule((r) => r.match(Task, { kind: "Automatic" }).find({ found: true }))
	.rule((r) => r.match(Task, { kind: "Manual" }).find({ found: true }))

export const eitherFound = query(Work)
	.rule((r) => r.match(Task, { kind: "Automatic" }).find({ found: true }))
	.rule((r) => r.match(Task, { kind: "Manual" }).find({ found: false }))

export const accounts = query(Work).rule((r) => {
	const { id, name, plan } = v(Account, "account")
	return r.match(Account, { id, name, plan }).find({ id, name, plan })
})

/**
 * Attachment delivery:
 * - a child whose binding on the parent's variable covers its key is an Option;
 * - a child keyed by the parent through a declared containment, with no further predicate, is the bare fact. Into
 *   closed facts whose source field is of the roster's type, enum membership is immediate, so it holds in a read-back
 *   too; into an ordinary relation it may lower to a deferred foreign key, so the immediate heading, which read-backs
 *   deliver, keeps the Option;
 * - an aggregate grouped only by parent variables is an Option, and the bare row when a reflexive self-match on the
 *   relation the parent's fact was read from proves its group nonempty;
 * - an alternatives arm keyed by the parent's key is Some in the arm the parent's handle selects and None in the
 *   others, and an Option in the immediate heading;
 * - a take(1) is an Option, an ordered child an array in its completed order, any other child a set.
 */
export const accountCards = accounts
	.attach(
		"planFact",
		(a) =>
			query(Work).rule((r) => {
				const { budget } = v(Plan, "plan")
				return r.match(Plan, { id: a.plan, budget }).find({ budget })
			}),
		"one"
	)
	.attach(
		"tasks",
		(a) =>
			query(Work)
				.rule((r) => {
					const { id, title } = v(Task, "task")
					return r.match(Task, { id, account: a.id, title }).find({ id, title })
				})
				.orderBy(["title", "asc"]),
		"array"
	)
	.attach(
		"labels",
		(a) =>
			query(Work).rule((r) => {
				const { label } = v(Label, "label")
				return r.match(Label, { account: a.id, label }).find({ label })
			}),
		"array"
	)
	.attach(
		"firstTask",
		(a) =>
			query(Work)
				.rule((r) => {
					const { id } = v(Task, "task")
					return r.match(Task, { id, account: a.id }).find({ id })
				})
				.orderBy(["id", "asc"])
				.take(1),
		"option"
	)
	.attach(
		"taskCount",
		(a) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: a.id }).find({ account: a.id, n: r.count() })
			}),
		"option"
	)

export type AccountCardsHead = Expect<
	Equals<
		HeadOf<typeof accountCards>,
		{
			readonly id: Uuid
			readonly name: string
			readonly plan: "Free" | "Pro"
			readonly planFact: { readonly budget: Cents }
			readonly tasks: ReadonlyArray<{ readonly id: Uuid; readonly title: string }>
			readonly labels: ReadonlyArray<{ readonly label: string }>
			readonly firstTask: Option.Option<{ readonly id: Uuid }>
			readonly taskCount: Option.Option<{ readonly account: Uuid; readonly n: bigint }>
		}
	>
>

export const taskCards = query(Work)
	.rule((r) => {
		const { id, account, kind } = v(Task, "task")
		return r.match(Task, { id, account, kind }).find({ id, account, kind })
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
		"owner",
		(t) =>
			query(Work).rule((r) => {
				const { name } = v(Account, "account")
				return r.match(Account, { id: t.account, name }).find({ name })
			}),
		"one"
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
	.attach(
		"siblings",
		(t) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: t.account }).find({ account: t.account, n: r.count() })
			}),
		"one"
	)

export type TaskCardsHead = Expect<
	Equals<
		HeadOf<typeof taskCards>,
		| {
				readonly id: Uuid
				readonly account: Uuid
				readonly kind: "Automatic"
				readonly note: Option.Option<{ readonly note: string }>
				readonly owner: { readonly name: string }
				readonly automatic: Option.Some<{ readonly budget: Cents }>
				readonly siblings: { readonly account: Uuid; readonly n: bigint }
		  }
		| {
				readonly id: Uuid
				readonly account: Uuid
				readonly kind: "Manual"
				readonly note: Option.Option<{ readonly note: string }>
				readonly owner: { readonly name: string }
				readonly automatic: Option.None<{ readonly budget: Cents }>
				readonly siblings: { readonly account: Uuid; readonly n: bigint }
		  }
	>
>

/**
 * Inside a write transaction a read-back reads the one child and an arm as an Option: the foreign key into Account and
 * the arm's mirrors may be false before COMMIT, and a stated one child is an Option there whatever proves it.
 */
export type TaskCardsImmediateHead = Expect<
	Equals<
		ImmediateHeadOf<typeof taskCards>,
		{
			readonly id: Uuid
			readonly account: Uuid
			readonly kind: "Automatic" | "Manual"
			readonly note: Option.Option<{ readonly note: string }>
			readonly owner: Option.Option<{ readonly name: string }>
			readonly automatic: Option.Option<{ readonly budget: Cents }>
			readonly siblings: Option.Option<{ readonly account: Uuid; readonly n: bigint }>
		}
	>
>

/**
 * An arm states the handle its child is the arm of, as one literal, in the parent's head field that holds the
 * discriminator; any other is refused, since `row.kind !== handle` narrows the other records only for one handle.
 */
const cards = query(Work).rule((r) => {
	const { id, account, kind } = v(Task, "task")
	return r.match(Task, { id, account, kind }).find({ id, account, kind })
})

export const wrongHandle = () =>
	cards.attach(
		"automatic",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: the arm's handle is the handle the child is the arm of
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
			}),
		arm("kind", "Manual")
	)

export const wideHandle = (handle: string) =>
	cards.attach(
		"automatic",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: the arm's handle is one literal
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
			}),
		arm("kind", handle)
	)

export const wrongField = () =>
	cards.attach(
		"automatic",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: the arm's field is the parent's head field that holds its discriminator
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task: t.id, budget }).find({ budget })
			}),
		arm("id", "Automatic")
	)

/** Attaching never changes the parent's evidence: the parent set is unchanged. */
export type TaskCardsEvidence = Expect<
	Equals<
		Keys<typeof taskCards>,
		readonly [ReadonlyArray<"id" | "account" | "kind">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>

/** A further predicate makes the closed child at most one fact, not exactly one. */
export const filteredPlan = accounts.attach(
	"cheap",
	(a) =>
		query(Work).rule((r) => {
			const { budget } = v(Plan, "plan")
			return r
				.match(Plan, { id: a.plan, budget })
				.where(r.lt(budget, Cents(2n)))
				.find({ budget })
		}),
	"option"
)

export type FilteredPlanHead = Expect<
	Equals<HeadOf<typeof filteredPlan>["cheap"], Option.Option<{ readonly budget: Cents }>>
>

/** Attachments nest, each delivered by its own evidence. */
export const nested = accounts.attach(
	"tasks",
	(a) =>
		query(Work)
			.rule((r) => {
				const { id, title } = v(Task, "task")
				return r.match(Task, { id, account: a.id, title }).find({ id, title })
			})
			.attach(
				"note",
				(t) =>
					query(Work).rule((r) => {
						const { note } = v(TaskNote, "taskNote")
						return r.match(TaskNote, { task: t.id, note }).find({ note })
					}),
				"option"
			),
	"array"
)

export type NestedHead = Expect<
	Equals<
		HeadOf<typeof nested>["tasks"],
		ReadonlyArray<{
			readonly id: Uuid
			readonly title: string
			readonly note: Option.Option<{ readonly note: string }>
		}>
	>
>

/**
 * A computation is determined by the variables it reads, as the engine reads a computed output: a head of computations
 * over a match its key pins is at most one row, and a key keeps keying a head that computes over what it determines.
 */
export const doubledScore = query(Work).rule((r) => {
	const { score } = v(Sitting, "sitting")
	return r
		.match(Sitting, { id: r.param("id", Sitting.fields.id), score })
		.find({ doubled: Compute.mul(score, 2) })
})

export const studentScores = query(Work).rule((r) => {
	const { id, score } = v(Sitting, "sitting")
	return r
		.match(Sitting, { id, student: r.param("student", Sitting.fields.student), score })
		.find({ id, squared: Compute.mul(score, score) })
})

export type StudentScoresKeys = Expect<
	Equals<
		Keys<typeof studentScores>,
		readonly [ReadonlyArray<"id" | "squared">, ...ReadonlyArray<ReadonlyArray<"id">>]
	>
>

/**
 * A predicate is a computation over what its operands read, a rule's comparison, Compute's and their connectives
 * alike, so a conditional over one is determined by the predicate's variables: over a match its key pins it is at most
 * one row, and over one no key pins, where the predicate reads a variable the inputs do not determine, many.
 */
export const passedOf = query(Work).rule((r) => {
	const { score } = v(Sitting, "sitting")
	const passed = Compute.cond(
		Compute.and(r.ge(score, 50), Compute.le(score, 100)),
		Compute.literal(pg.integer, 1),
		0
	)
	return r.match(Sitting, { id: r.param("id", Sitting.fields.id), score }).find({ passed })
})

export const passedByStudent = query(Work).rule((r) => {
	const { score } = v(Sitting, "sitting")
	const passed = Compute.cond(
		Compute.and(r.ge(score, 50), Compute.le(score, 100)),
		Compute.literal(pg.integer, 1),
		0
	)
	return r
		.match(Sitting, { student: r.param("student", Sitting.fields.student), score })
		.find({ passed })
})

/** Compute's equality fixes a variable in a where as r.eq does, and its conjunction passes it on. */
export const sittingByCompute = query(Work).rule((r) => {
	const { id, score } = v(Sitting, "sitting")
	return r
		.match(Sitting, { id, score })
		.where(Compute.and(Compute.eq(id, r.param("id", uuid)), Compute.ge(score, 0)))
		.find({ score })
})

/**
 * A match's key determines only the variables the match binds: Task's account variable, bound at Label while Task's own
 * account is a parameter, is no field of the Task the key pins, so the Label it joins is any.
 */
export const boundElsewhere = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	const { color } = v(Label, "label")
	return r
		.match(Task, { id: r.param("id", uuid), account: r.param("account", uuid) })
		.match(Label, { account, label: "urgent", color })
		.find({ color })
})

/**
 * An equality between two variables makes each determine the other: the Label's account equals the pinned Task's, so
 * its key is pinned.
 */
export const equalAccounts = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	const label = v(Label, "label")
	return r
		.match(Task, { id: r.param("id", uuid), account })
		.match(Label, { account: label.account, label: "urgent", color: label.color })
		.where(r.eq(label.account, account))
		.find({ color: label.color })
})

/** A get over a query proved at most one row, and the refusal of one that is not. */
export const gets = (db: DbOf<typeof Reader, unknown>) => [
	db.get(taskById, { id: taskId }),
	db.get(taskByFilter, { id: taskId }),
	db.get(labelByConjunction, { account: accountId }),
	db.get(taskCount, {}),
	db.get(doubledScore, { id: sittingId }),
	db.get(passedOf, { id: sittingId }),
	db.get(sittingByCompute, { id: sittingId }),
	db.get(equalAccounts, { id: taskId }),
	db.get(anyTask, {})
]

export const refusedGets = (db: DbOf<typeof Reader, unknown>) => [
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(studentScores, { student: studentId }),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(passedByStudent, { student: studentId }),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(boundElsewhere, { id: taskId, account: accountId }),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(eitherFound, {}),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(tasksByTitle, { title: "x" }),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(labelByDisjunction, { account: accountId }),
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(selfJoin, { id: taskId })
]

/**
 * Filters fix an origin only where every value the predicates can take fixes it: a spread array of
 * unknown length may be empty at run time, and either side of a conditional may be the predicate that runs.
 * A boolean whose value the checker does not know: a function result is not narrowed to its literal.
 */
const unknownFlag = (): boolean => false
const flag = unknownFlag()
export const taskBySpread = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r
		.match(Task, { id, title })
		.where(...Arr.filter([r.eq(id, r.param("id", uuid))], () => flag))
		.find({ title })
})
export type TaskBySpreadCard = Expect<Equals<Card<typeof taskBySpread>, "many">>
/** Either way the parameters a member may use are required: the array may hold the comparison at run time. */
export type TaskBySpreadParams = Expect<
	Equals<ParamsOf<typeof taskBySpread>, { readonly id: ParamType<Uuid, "uuid"> }>
>

export const labelByEither = query(Work).rule((r) => {
	const { account, label, color } = v(Label, "label")
	return r
		.match(Label, { account, label, color })
		.where(flag ? r.eq(account, r.param("account", uuid)) : r.eq(label, "urgent"))
		.find({ color })
})
export type LabelByEitherCard = Expect<Equals<Card<typeof labelByEither>, "many">>
export type LabelByEitherKeys = Expect<
	Equals<Keys<typeof labelByEither>, readonly [ReadonlyArray<"color">]>
>

export type LabelByEitherParams = Expect<
	Equals<ParamsOf<typeof labelByEither>, { readonly account: ParamType<Uuid, "uuid"> }>
>

/** A conjunction is the same: each conjunct must fix the origin whichever value it takes. */
export const labelByEitherConjunct = query(Work).rule((r) => {
	const { account, label, color } = v(Label, "label")
	return r
		.match(Label, { account, label, color })
		.where(
			r.and(
				r.eq(account, r.param("account", uuid)),
				flag ? r.eq(label, "urgent") : r.ne(label, "x")
			)
		)
		.find({ color })
})
export type LabelByEitherConjunctCard = Expect<Equals<Card<typeof labelByEitherConjunct>, "many">>

/**
 * A composite containment proves the bare child: TaskLabel's (account, label) is always a Label's key.
 * It lowers to a foreign key that may be deferred, so the immediate heading keeps the Option.
 */
export const taskLabels = query(Work)
	.rule((r) => {
		const { task, account, label } = v(TaskLabel, "taskLabel")
		return r.match(TaskLabel, { task, account, label }).find({ task, account, label })
	})
	.attach(
		"color",
		(t) =>
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r.match(Label, { account: t.account, label: t.label, color }).find({ color })
			}),
		"one"
	)

export type TaskLabelsColor = Expect<
	Equals<HeadOf<typeof taskLabels>["color"], { readonly color: string }>
>

export type TaskLabelsImmediateColor = Expect<
	Equals<ImmediateHeadOf<typeof taskLabels>["color"], Option.Option<{ readonly color: string }>>
>

/**
 * A parent's head field carries its own origin's containments, never those of another field of the same type. The
 * head's plan is Upgrade.target, which no containment into Plan describes, while the rule also binds Account.plan,
 * which one does: both are closedId(Plan), so the types tell them apart by origin (an origin names one variable, its
 * scope's field), and the plan child is an Option by its key.
 */
export const upgradeTargets = query(Work)
	.rule((r) => {
		const { id, plan } = v(Account, "account")
		const { target } = v(Upgrade, "upgrade")
		return r
			.match(Account, { id, plan })
			.match(Upgrade, { account: id, target })
			.find({ id, plan: target })
	})
	.attach(
		"target",
		(u) =>
			query(Work).rule((r) => {
				const { budget } = v(Plan, "plan")
				return r.match(Plan, { id: u.plan, budget }).find({ budget })
			}),
		"option"
	)

export type UpgradeTargetsPlan = Expect<
	Equals<HeadOf<typeof upgradeTargets>["target"], Option.Option<{ readonly budget: Cents }>>
>

/**
 * Over a self-join parent each scope's head fields are fields of its own fact, so each scope proves what its fact
 * proves: the task scope's account is one Account by its containment, and each scope's id keys the arm of the handle
 * its own kind holds, the field the arm states.
 */
const siblings = query(Work).rule((r) => {
	const task = v(Task, "task")
	const sibling = v(Task, "sibling")
	return r
		.match(Task, { id: task.id, account: task.account, kind: task.kind })
		.match(Task, { id: sibling.id, account: task.account, kind: sibling.kind })
		.where(r.ne(task.id, sibling.id))
		.find({
			id: task.id,
			account: task.account,
			kind: task.kind,
			sibling: sibling.id,
			siblingKind: sibling.kind
		})
})

export const siblingTasks = siblings
	.attach(
		"owner",
		(t) =>
			query(Work).rule((r) => {
				const { name } = v(Account, "account")
				return r.match(Account, { id: t.account, name }).find({ name })
			}),
		"one"
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
	.attach(
		"siblingManual",
		(t) =>
			query(Work).rule((r) => {
				const { operator } = v(ManualTask, "manualTask")
				return r.match(ManualTask, { task: t.sibling, operator }).find({ operator })
			}),
		arm("siblingKind", "Manual")
	)

/** The sibling's manual arm is Some exactly where the sibling's own kind is Manual, whatever the task's kind. */
export type SiblingManualHead = Expect<
	Equals<
		Extract<HeadOf<typeof siblingTasks>, { readonly siblingKind: "Manual" }>["siblingManual"],
		Option.Some<{ readonly operator: string }>
	>
>

/** The sibling's arm is never read off the task's kind: a kind of the other scope's fact. */
export const crossScopeArm = () =>
	siblings.attach(
		"siblingAutomatic",
		(t) =>
			// @ts-expect-error -- TS2322 refusal: the arm's field is the parent's head field that holds its discriminator
			query(Work).rule((r) => {
				const { budget } = v(AutomaticTask, "automaticTask")
				return r.match(AutomaticTask, { task: t.sibling, budget }).find({ budget })
			}),
		arm("kind", "Automatic")
	)

/**
 * A composite containment proves the child of one scope's fields, either scope's, and never of a field of each: the
 * first scope's account with the second's label names no one TaskLabel's pair, so its color is an Option.
 */
const labelPairs = query(Work).rule((r) => {
	const first = v(TaskLabel, "first")
	const second = v(TaskLabel, "second")
	return r
		.match(TaskLabel, { task: first.task, account: first.account, label: first.label })
		.match(TaskLabel, { task: first.task, account: second.account, label: second.label })
		.where(r.ne(first.label, second.label))
		.find({
			task: first.task,
			account: first.account,
			label: first.label,
			otherAccount: second.account,
			otherLabel: second.label
		})
})

export const pairedLabels = labelPairs
	.attach(
		"color",
		(p) =>
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r.match(Label, { account: p.account, label: p.label, color }).find({ color })
			}),
		"one"
	)
	.attach(
		"otherColor",
		(p) =>
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r
					.match(Label, { account: p.otherAccount, label: p.otherLabel, color })
					.find({ color })
			}),
		"one"
	)
	.attach(
		"crossColor",
		(p) =>
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r.match(Label, { account: p.account, label: p.otherLabel, color }).find({ color })
			}),
		"option"
	)

export const crossScopeContainment = () =>
	labelPairs.attach(
		"crossColor",
		(p) =>
			// @ts-expect-error -- TS2322 refusal: the one child needs a child the evidence proves exactly one per parent
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r.match(Label, { account: p.account, label: p.otherLabel, color }).find({ color })
			}),
		"one"
	)

/**
 * A scope whose head fields no one match binds together is no one fact: the first scope's account is the first
 * match's and its label the second's, so the scope keeps no origin and its color is an Option.
 */
const splitLabels = query(Work).rule((r) => {
	const first = v(TaskLabel, "first")
	const second = v(TaskLabel, "second")
	return r
		.match(TaskLabel, { task: first.task, account: first.account, label: second.label })
		.match(TaskLabel, { task: second.task, account: second.account, label: first.label })
		.find({ task: first.task, account: first.account, label: first.label })
})

export type SplitLabelsOrigins = Expect<Equals<EvidenceOfQuery<typeof splitLabels>["origins"], {}>>

export const splitScopeLabels = splitLabels.attach(
	"color",
	(p) =>
		query(Work).rule((r) => {
			const { color } = v(Label, "label")
			return r.match(Label, { account: p.account, label: p.label, color }).find({ color })
		}),
	"option"
)

export const splitScopeContainment = () =>
	splitLabels.attach(
		"color",
		(p) =>
			// @ts-expect-error -- TS2322 refusal: the one child needs a child the evidence proves exactly one per parent
			query(Work).rule((r) => {
				const { color } = v(Label, "label")
				return r.match(Label, { account: p.account, label: p.label, color }).find({ color })
			}),
		"one"
	)

/**
 * A reflexive self-match proves each scope's own group: the sitting's rank over the sitting scope's student and score,
 * and the retake's count at or below its score over the retake scope's. A count read off both scopes' fields names no
 * one fact the group holds, so it is an Option.
 */
const sittingPairs = query(Work).rule((r) => {
	const sitting = v(Sitting, "sitting")
	const retake = v(Sitting, "retake")
	return r
		.match(Sitting, { id: sitting.id, student: sitting.student, score: sitting.score })
		.match(Sitting, { id: retake.id, student: sitting.student, score: retake.score })
		.where(r.ne(sitting.id, retake.id))
		.find({
			id: sitting.id,
			student: sitting.student,
			score: sitting.score,
			retake: retake.id,
			retakeScore: retake.score
		})
})

export const retakes = sittingPairs
	.attach(
		"rank",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.le(t.score, s.score))
					.find({ ordinal: r.count() })
			}),
		"one"
	)
	.attach(
		"atOrBelowRetake",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { id: t.id, score: t.score })
					.where(r.le(t.score, s.retakeScore))
					.find({ n: r.count() })
			}),
		"one"
	)
	.attach(
		"crossRank",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.le(t.score, s.score), r.le(t.id, s.retake))
					.find({ ordinal: r.count() })
			}),
		"option"
	)

export const crossScopeReflexive = () =>
	sittingPairs.attach(
		"crossRank",
		(s) =>
			// @ts-expect-error -- TS2322 refusal: the one child needs a child the evidence proves exactly one per parent
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.le(t.score, s.score), r.le(t.id, s.retake))
					.find({ ordinal: r.count() })
			}),
		"one"
	)

/**
 * The inclusive ordinal as an attachment: the count of the student's sittings at or before this one
 * matches the relation the parent's sitting was read from, and the parent's own sitting satisfies the filter, so the
 * group is never empty and the ordinal is a bigint, not an Option. Counting strict predecessors
 * proves nothing: the first sitting has none.
 */
export const sittings = query(Work)
	.rule((r) => {
		const { id, student, score } = v(Sitting, "sitting")
		return r.match(Sitting, { id, student, score }).find({ id, student, score })
	})
	.attach(
		"rank",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.or(r.lt(t.score, s.score), r.and(r.eq(t.score, s.score), r.le(t.id, s.id))))
					.find({ ordinal: r.count() })
			}),
		"one"
	)
	.attach(
		"predecessors",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.lt(t.score, s.score))
					.find({ ordinal: r.count() })
			}),
		"option"
	)
	.attach(
		"perStudent",
		(s) =>
			query(Work).rule((r) => {
				const { id } = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id })
					.find({ student: s.student, sittings: r.count() })
			}),
		"one"
	)

export type SittingsHead = Expect<
	Equals<
		HeadOf<typeof sittings>,
		{
			readonly id: Uuid
			readonly student: Uuid
			readonly score: number
			readonly rank: { readonly ordinal: bigint }
			readonly predecessors: Option.Option<{ readonly ordinal: bigint }>
			readonly perStudent: { readonly student: Uuid; readonly sittings: bigint }
		}
	>
>

/**
 * A parent variable read only by a filter is a correlation like a bound one: every sitting scored at or below this
 * one includes this one. A strict comparison excludes this sitting, so the sittings above it are an Option.
 */
export const scoreRanks = query(Work)
	.rule((r) => {
		const { id, student, score } = v(Sitting, "sitting")
		return r.match(Sitting, { id, student, score }).find({ id, student, score })
	})
	.attach(
		"atOrBelow",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { id: t.id, score: t.score })
					.where(r.le(t.score, s.score))
					.find({ n: r.count() })
			}),
		"one"
	)
	.attach(
		"above",
		(s) =>
			query(Work).rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { id: t.id, score: t.score })
					.where(r.gt(t.score, s.score))
					.find({ n: r.count() })
			}),
		"option"
	)

export type ScoreRanksHead = Expect<
	Equals<
		HeadOf<typeof scoreRanks>,
		{
			readonly id: Uuid
			readonly student: Uuid
			readonly score: number
			readonly atOrBelow: { readonly n: bigint }
			readonly above: Option.Option<{ readonly n: bigint }>
		}
	>
>

/** A read-back reads the one child as an Option, though the proof is a fact about the query alone. */
export type SittingsImmediateHead = Expect<
	Equals<
		ImmediateHeadOf<typeof sittings>,
		{
			readonly id: Uuid
			readonly student: Uuid
			readonly score: number
			readonly rank: Option.Option<{ readonly ordinal: bigint }>
			readonly predecessors: Option.Option<{ readonly ordinal: bigint }>
			readonly perStudent: Option.Option<{ readonly student: Uuid; readonly sittings: bigint }>
		}
	>
>

/** A take over the child is no grouped region the proof reads through: an Option. */
export const firstRank = sittings.attach(
	"firstRank",
	(s) =>
		query(Work)
			.rule((r) => {
				const t = v(Sitting, "sitting")
				return r
					.match(Sitting, { student: s.student, id: t.id, score: t.score })
					.where(r.le(t.score, s.score))
					.find({ student: s.student, ordinal: r.count() })
			})
			.orderBy(["student", "asc"])
			.take(1),
	"option"
)

export type FirstRankHead = Expect<
	Equals<
		HeadOf<typeof firstRank>["firstRank"],
		Option.Option<{ readonly student: Uuid; readonly ordinal: bigint }>
	>
>

/** A read inside a write transaction, a read-back, delivers the immediate heading; a Db read delivers the heading. */
export const readBack = (changes: ChangeSet<typeof Work, unknown, "Task">) =>
	changes.read("cards", () => taskCards)

export type ReadBackRows = Expect<
	Equals<
		ReadsOf<ReturnType<typeof readBack>>["cards"],
		ReadonlyArray<ImmediateHeadOf<typeof taskCards>>
	>
>
export const snapshotRead = (db: DbOf<typeof Reader, unknown>) => db.execute(taskCards, {})
export type SnapshotReadRows = Expect<
	Equals<
		ReturnType<typeof snapshotRead>,
		Effect.Effect<QueryResult<HeadOf<typeof taskCards>>, ReadError>
	>
>

/**
 * The delivered shape of every attachment, as the type states it, under each reading: each attachment states the
 * widest delivery its evidence licenses. The agreement test of ../evidence.test.ts compiles each query and requires
 * logical/attach.ts to prove, in the `snapshot` and `transaction` template contexts, a delivery that licenses each of
 * these shapes, so the decoder a program binds is never refused by an analysis that proves less than the type.
 */
type Delivered<T> =
	T extends ReadonlyArray<unknown> ? "array" : T extends Option.Option<unknown> ? "option" : "one"

type DeliveredOf<H, Names extends PropertyKey> = {
	readonly [K in Names]: Delivered<H[K & keyof H]>
}

type Readings<Q, Names extends PropertyKey> = {
	readonly snapshot: DeliveredOf<HeadOf<Q>, Names>
	readonly transaction: DeliveredOf<ImmediateHeadOf<Q>, Names>
}

export const deliveries = {
	accountCards: {
		snapshot: {
			planFact: "one",
			tasks: "array",
			labels: "array",
			firstTask: "option",
			taskCount: "option"
		},
		transaction: {
			planFact: "option",
			tasks: "array",
			labels: "array",
			firstTask: "option",
			taskCount: "option"
		}
	},
	taskCards: {
		snapshot: { note: "option", owner: "one", automatic: "option", siblings: "one" },
		transaction: { note: "option", owner: "option", automatic: "option", siblings: "option" }
	},
	filteredPlan: { snapshot: { cheap: "option" }, transaction: { cheap: "option" } },
	taskLabels: { snapshot: { color: "one" }, transaction: { color: "option" } },
	upgradeTargets: { snapshot: { target: "option" }, transaction: { target: "option" } },
	siblingTasks: {
		snapshot: { owner: "one", automatic: "option", siblingManual: "option" },
		transaction: { owner: "option", automatic: "option", siblingManual: "option" }
	},
	pairedLabels: {
		snapshot: { color: "one", otherColor: "one", crossColor: "option" },
		transaction: { color: "option", otherColor: "option", crossColor: "option" }
	},
	splitScopeLabels: { snapshot: { color: "option" }, transaction: { color: "option" } },
	retakes: {
		snapshot: { rank: "one", atOrBelowRetake: "one", crossRank: "option" },
		transaction: { rank: "option", atOrBelowRetake: "option", crossRank: "option" }
	},
	sittings: {
		snapshot: { rank: "one", predecessors: "option", perStudent: "one" },
		transaction: { rank: "option", predecessors: "option", perStudent: "option" }
	},
	scoreRanks: {
		snapshot: { atOrBelow: "one", above: "option" },
		transaction: { atOrBelow: "option", above: "option" }
	},
	firstRank: {
		snapshot: { rank: "one", predecessors: "option", perStudent: "one", firstRank: "option" },
		transaction: {
			rank: "option",
			predecessors: "option",
			perStudent: "option",
			firstRank: "option"
		}
	}
} as const
type Table = typeof deliveries
export type AccountCardsDeliveries = Expect<
	Equals<
		Table["accountCards"],
		Readings<typeof accountCards, keyof Table["accountCards"]["snapshot"]>
	>
>

export type TaskCardsDeliveries = Expect<
	Equals<Table["taskCards"], Readings<typeof taskCards, keyof Table["taskCards"]["snapshot"]>>
>

export type FilteredPlanDeliveries = Expect<
	Equals<
		Table["filteredPlan"],
		Readings<typeof filteredPlan, keyof Table["filteredPlan"]["snapshot"]>
	>
>

export type TaskLabelsDeliveries = Expect<
	Equals<Table["taskLabels"], Readings<typeof taskLabels, keyof Table["taskLabels"]["snapshot"]>>
>

export type UpgradeTargetsDeliveries = Expect<
	Equals<
		Table["upgradeTargets"],
		Readings<typeof upgradeTargets, keyof Table["upgradeTargets"]["snapshot"]>
	>
>

export type SiblingTasksDeliveries = Expect<
	Equals<
		Table["siblingTasks"],
		Readings<typeof siblingTasks, keyof Table["siblingTasks"]["snapshot"]>
	>
>

export type PairedLabelsDeliveries = Expect<
	Equals<
		Table["pairedLabels"],
		Readings<typeof pairedLabels, keyof Table["pairedLabels"]["snapshot"]>
	>
>

export type SplitScopeLabelsDeliveries = Expect<
	Equals<
		Table["splitScopeLabels"],
		Readings<typeof splitScopeLabels, keyof Table["splitScopeLabels"]["snapshot"]>
	>
>

export type RetakesDeliveries = Expect<
	Equals<Table["retakes"], Readings<typeof retakes, keyof Table["retakes"]["snapshot"]>>
>

export type SittingsDeliveries = Expect<
	Equals<Table["sittings"], Readings<typeof sittings, keyof Table["sittings"]["snapshot"]>>
>

export type ScoreRanksDeliveries = Expect<
	Equals<Table["scoreRanks"], Readings<typeof scoreRanks, keyof Table["scoreRanks"]["snapshot"]>>
>

export type FirstRankDeliveries = Expect<
	Equals<Table["firstRank"], Readings<typeof firstRank, keyof Table["firstRank"]["snapshot"]>>
>

/** nested's attachment inside its tasks. */
export type NestedDeliveries = Expect<
	Equals<
		{ readonly tasks: "array"; readonly note: "option" },
		{
			readonly tasks: Delivered<HeadOf<typeof nested>["tasks"]>
			readonly note: Delivered<HeadOf<typeof nested>["tasks"][number]["note"]>
		}
	>
>
