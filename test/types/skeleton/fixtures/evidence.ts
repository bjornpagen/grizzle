import type { Brand, Option } from "effect"
import { closedId, type Uuid, uuid } from "#compiler/public/fields.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import type { Origin } from "#compiler/types/core/phantom.ts"
import type { EvidenceOfQuery, HeadOf, ImmediateHeadOf } from "#compiler/types/query/query.ts"
import { query, v } from "#index.ts"
import {
	Account,
	AccountLabel,
	Cents,
	Reports,
	SchoolCalendar,
	Student,
	StudentWeekly,
	Task,
	TaskNote,
	Work
} from "#test/types/skeleton/fixtures/work.ts"
import type { Equals, Expect } from "#test/types/skeleton/support.ts"

/**
 * Evidence and attachment delivery over declare-only values.
 * Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the next line.
 *
 * A lookup whose primary key is bound to a parameter is atMostOne.
 */
export const taskById = query(Work).rule((r) => {
	const { account, kind } = v(Task, "task")
	return r.match(Task, { id: r.param("id", Task.fields.id), account, kind }).find({ account, kind })
})
export type TaskByIdCard = Expect<Equals<EvidenceOfQuery<typeof taskById>["card"], "atMostOne">>
/** So is a lookup through a declared candidate key. */
export const accountByName = query(Work).rule((r) => {
	const { id } = v(Account, "account")
	return r.match(Account, { id, name: r.param("name", Account.fields.name) }).find({ id })
})

export type AccountByNameCard = Expect<
	Equals<EvidenceOfQuery<typeof accountByName>["card"], "atMostOne">
>

/** A filter on a non-key field is many, and so is a key bound to a rule variable rather than an input. */
export const tasksForAccount = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})

export type TasksForAccountCard = Expect<
	Equals<EvidenceOfQuery<typeof tasksForAccount>["card"], "many">
>

/** A pinned occurrence determines the join variable, which pins the occurrence it joins: at most one row. */
export const taskAndNotes = query(Work).rule((r) => {
	const { account } = v(Task, "task")
	const { name } = v(Account, "account")
	return r
		.match(Task, { id: r.param("id", Task.fields.id), account })
		.match(Account, { id: account, name })
		.find({ name })
})

export type TaskAndNotesCard = Expect<
	Equals<EvidenceOfQuery<typeof taskAndNotes>["card"], "atMostOne">
>

/**
 * A composite key pins an occurrence only when every one of its fields is fixed: binding account alone leaves
 * AccountLabel's key [account, label] open, so the lookup is many. A head reads only variables its matches bind, so the
 * key field the head holds is bound to its variable and fixed by a filter.
 */
export const labelsOf = query(Work).rule((r) => {
	const { label } = v(AccountLabel, "accountLabel")
	return r
		.match(AccountLabel, { account: r.param("account", AccountLabel.fields.account), label })
		.find({ label })
})
export type LabelsOfCard = Expect<Equals<EvidenceOfQuery<typeof labelsOf>["card"], "many">>
export const labelLookup = query(Work).rule((r) => {
	const { account } = v(AccountLabel, "accountLabel")
	return r
		.match(AccountLabel, { account, label: r.param("label", AccountLabel.fields.label) })
		.where(r.eq(account, r.param("account", AccountLabel.fields.account)))
		.find({ account })
})

export type LabelLookupCard = Expect<
	Equals<EvidenceOfQuery<typeof labelLookup>["card"], "atMostOne">
>

export const labelLiteral = query(Work).rule((r) => {
	const { account } = v(AccountLabel, "accountLabel")
	return r
		.match(AccountLabel, { account, label: "urgent" })
		.where(r.eq(account, r.param("account", AccountLabel.fields.account)))
		.find({ account })
})

export type LabelLiteralCard = Expect<
	Equals<EvidenceOfQuery<typeof labelLiteral>["card"], "atMostOne">
>

/** An aggregate-only query has at most one row; a grouped aggregate is keyed by its group terms. */
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
			/** account was matched at Task.account, so a query attaching to this one reads it as that field. */
			readonly origins: { readonly account: Origin<"Task", "account", "task"> }
		}
	>
>

/**
 * attach: the child's binding on the parent's variable covers the TaskNote key, so the note is an Option; a child
 * without a key proof is a set; take(1) is an Option; an aggregate child grouped only by parent-bound variables is an
 * Option, and the bare row here, because it matches the relation the parent's task was read from with nothing the
 * parent's own task fails, a reflexive self-match that proves the group nonempty.
 */
export const tasks = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ id, account })
})

export const withNote = tasks
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
		"siblings",
		(t) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: t.account }).find({ id })
			}),
		"array"
	)
	.attach(
		"first",
		(t) =>
			query(Work)
				.rule((r) => {
					const { id } = v(Task, "task")
					return r.match(Task, { id, account: t.account }).find({ id })
				})
				.orderBy(["id", "asc"])
				.take(1),
		"option"
	)
	.attach(
		"siblingCount",
		(t) =>
			query(Work).rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: t.account }).find({ account: t.account, n: r.count() })
			}),
		"one"
	)

export type WithNoteHead = Expect<
	Equals<
		HeadOf<typeof withNote>,
		{
			readonly id: Uuid
			readonly account: Uuid
			readonly note: Option.Option<{ readonly note: string }>
			readonly siblings: ReadonlyArray<{ readonly id: Uuid }>
			readonly first: Option.Option<{ readonly id: Uuid }>
			readonly siblingCount: { readonly account: Uuid; readonly n: bigint }
		}
	>
>

/** A child bound on part of a composite key is a set: the labels of a task's account. */
export const withLabels = tasks.attach(
	"labels",
	(t) =>
		query(Work).rule((r) => {
			const { label } = v(AccountLabel, "accountLabel")
			return r.match(AccountLabel, { account: t.account, label }).find({ label })
		}),
	"array"
)

export type WithLabelsHead = Expect<
	Equals<HeadOf<typeof withLabels>["labels"], ReadonlyArray<{ readonly label: string }>>
>
/** Attaching never changes the parent's evidence: the parent set is unchanged. */
export type WithNoteCard = Expect<Equals<EvidenceOfQuery<typeof withNote>["card"], "many">>

/** An ordered child is delivered in its completed order as an array. */
export const withOrdered = tasks.attach(
	"ordered",
	(t) =>
		query(Work)
			.rule((r) => {
				const { id } = v(Task, "task")
				return r.match(Task, { id, account: t.account }).find({ id })
			})
			.orderBy(["id", "desc"]),
	"array"
)

export type WithOrderedHead = Expect<
	Equals<HeadOf<typeof withOrdered>["ordered"], ReadonlyArray<{ readonly id: Uuid }>>
>

/** An arm may attach before it joins a union, keeping its own attached heading. */
export const armAttached = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r
		.match(Task, { id })
		.find({ id })
		.attach(
			"note",
			(t) =>
				query(Work).rule((r2) => {
					const { note } = v(TaskNote, "taskNote")
					return r2.match(TaskNote, { task: t.id, note }).find({ note })
				}),
			"option"
		)
})

export type ArmAttachedHead = Expect<
	Equals<
		HeadOf<typeof armAttached>,
		{ readonly id: Uuid; readonly note: Option.Option<{ readonly note: string }> }
	>
>
/** The orderBy reader: a non-heading field cannot order. */
// @ts-expect-error -- TS2322: id is not in the heading
export const badOrder = taskById.orderBy(["id", "asc"])

/**
 * A derived relation's inherited keys pin a match like a declared key: StudentWeekly is keyed by
 * (student, week), so a lookup binding both to parameters is atMostOne, and binding student alone is many.
 */
export const weeklyLookup = query(Reports).rule((r) => {
	const { passes } = v(StudentWeekly, "studentWeekly")
	return r
		.match(StudentWeekly, {
			student: r.param("student", uuid),
			week: r.param("week", SchoolCalendar.fields.week),
			passes
		})
		.find({ passes })
})

export type WeeklyLookupCard = Expect<
	Equals<EvidenceOfQuery<typeof weeklyLookup>["card"], "atMostOne">
>

export const weeklyOfStudent = query(Reports).rule((r) => {
	const { week, passes } = v(StudentWeekly, "studentWeekly")
	return r
		.match(StudentWeekly, { student: r.param("student", uuid), week, passes })
		.find({ week, passes })
})

export type WeeklyOfStudentCard = Expect<
	Equals<EvidenceOfQuery<typeof weeklyOfStudent>["card"], "many">
>

/** An attachment bound on the derived key through the parent's variables is an Option. */
export const studentWeeks = query(Reports)
	.rule((r) => {
		const { id } = v(Student, "student")
		const { week } = v(SchoolCalendar, "schoolCalendar")
		return r.match(Student, { id }).match(SchoolCalendar, { week }).find({ student: id, week })
	})
	.attach(
		"weekly",
		(p) =>
			query(Reports).rule((r) => {
				const { passes } = v(StudentWeekly, "studentWeekly")
				return r.match(StudentWeekly, { student: p.student, week: p.week, passes }).find({ passes })
			}),
		"option"
	)

export type StudentWeeksHead = Expect<
	Equals<HeadOf<typeof studentWeeks>["weekly"], Option.Option<{ readonly passes: bigint }>>
>

/**
 * The containment row: a child whose only match reads a closed relation by an id bound to
 * a parent variable, where a containment maps the parent field the variable was matched at onto that id, and which
 * binds nothing else but fresh variables, meets exactly one fact, so it is delivered bare. Containment into closed
 * facts is enum membership, an immediate constraint, so the evidence holds in a read-back too.
 */
export const Plan = closed("Plan", ["Free", "Pro"]).with(
	{ budget: Cents },
	{ Free: { budget: Cents(1n) }, Pro: { budget: Cents(2n) } }
)
export const Subscriber = relation("Subscriber", { id: uuid, plan: closedId(Plan) }, ["id"])
export const Upgrade = relation("Upgrade", { subscriber: uuid, plan: closedId(Plan) }, [
	"subscriber"
])

export const Billing = schema("Billing", { Plan, Subscriber, Upgrade }, [
	contained(on(Subscriber, "plan"), on(Plan, "id"))
])
type Budget = bigint & Brand.Brand<"Cents">
export const subscribers = query(Billing).rule((r) => {
	const { id, plan } = v(Subscriber, "subscriber")
	return r.match(Subscriber, { id, plan }).find({ id, plan })
})

/** The parent variable keeps the field its head field was matched at. */
export type SubscriberOrigins = Expect<
	Equals<
		EvidenceOfQuery<typeof subscribers>["origins"],
		{
			readonly id: Origin<"Subscriber", "id", "subscriber">
			readonly plan: Origin<"Subscriber", "plan", "subscriber">
		}
	>
>

export const withPlan = subscribers
	.attach(
		"details",
		(s) =>
			query(Billing).rule((r) => {
				const { budget } = v(Plan, "plan")
				return r.match(Plan, { id: s.plan, budget }).find({ budget })
			}),
		"one"
	)
	.attach(
		"filtered",
		(s) =>
			query(Billing).rule((r) =>
				r.match(Plan, { id: s.plan, budget: Cents(1n) }).find({ plan: s.plan })
			),
		"option"
	)
	.attach(
		"guarded",
		(s) =>
			query(Billing).rule((r) => {
				const { budget } = v(Plan, "plan")
				return r
					.match(Plan, { id: s.plan, budget })
					.where(r.gt(budget, Cents(1n)))
					.find({ budget })
			}),
		"option"
	)
	.attach(
		"joined",
		(s) =>
			query(Billing).rule((r) => {
				const { budget } = v(Plan, "plan")
				const { subscriber } = v(Upgrade, "upgrade")
				return r
					.match(Plan, { id: s.plan, budget })
					.match(Upgrade, { subscriber, plan: s.plan })
					.find({ budget })
			}),
		"array"
	)

export type WithPlanHead = Expect<
	Equals<
		HeadOf<typeof withPlan>,
		{
			readonly id: Uuid
			readonly plan: "Free" | "Pro"
			readonly details: { readonly budget: Budget }
			readonly filtered: Option.Option<{ readonly plan: "Free" | "Pro" }>
			readonly guarded: Option.Option<{ readonly budget: Budget }>
			readonly joined: ReadonlyArray<{ readonly budget: Budget }>
		}
	>
>

/**
 * Without a declared containment, or through a variable minted at Subscriber.plan but matched at Upgrade.plan, the
 * parent's value is not proved to be a Plan id, so the child is an Option.
 */
export const upgrades = query(Billing).rule((r) => {
	const { plan } = v(Subscriber, "subscriber")
	const { subscriber } = v(Upgrade, "upgrade")
	return r.match(Upgrade, { subscriber, plan }).find({ subscriber, plan })
})

export const upgradePlan = upgrades.attach(
	"budget",
	(u) =>
		query(Billing).rule((r) => {
			const { budget } = v(Plan, "plan")
			return r.match(Plan, { id: u.plan, budget }).find({ budget })
		}),
	"option"
)

export type UpgradePlanHead = Expect<
	Equals<HeadOf<typeof upgradePlan>["budget"], Option.Option<{ readonly budget: Budget }>>
>

/**
 * A containment into an ordinary relation proves the bare child in a snapshot read. It may
 * lower to a deferred foreign key, which a read inside a write transaction cannot rely on, so the
 * query's immediate heading, which read-backs deliver, keeps the Option.
 */
export const noteOwners = query(Work)
	.rule((r) => {
		const { task, note } = v(TaskNote, "taskNote")
		return r.match(TaskNote, { task, note }).find({ task, note })
	})
	.attach(
		"owner",
		(n) =>
			query(Work).rule((r) => {
				const { account } = v(Task, "task")
				return r.match(Task, { id: n.task, account }).find({ account })
			}),
		"one"
	)

export type NoteOwnerHead = Expect<
	Equals<HeadOf<typeof noteOwners>["owner"], { readonly account: Uuid }>
>

export type NoteOwnerImmediateHead = Expect<
	Equals<ImmediateHeadOf<typeof noteOwners>["owner"], Option.Option<{ readonly account: Uuid }>>
>
