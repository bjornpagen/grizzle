import type { Brand, Effect, Option, Stream } from "effect"
import type { ReadError } from "#adapter/errors/execution.ts"
import type { DbOf, QueryResult } from "#adapter/types/db.ts"
import { ALLEN } from "#compiler/public/allen.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, type Decimal, pg, span, uuid } from "#compiler/public/fields.ts"
import {
	type CommonKeys,
	type EvidenceOfQuery,
	type HeadOf,
	type ParamsOf,
	query,
	type Vars,
	v
} from "#compiler/public/query.ts"
import { closed, contained, on, relation, schema } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { SqlOfTerm, TypeOfTerm } from "#compiler/types/core/phantom.ts"
import type { Span } from "#compiler/types/fields/field.ts"
import type { Equals, Expect } from "#test/types/query/support.ts"

/** The names of a program's parameters: never for one that takes none. */
type ParamNamesOf<X> = keyof ParamsOf<X>

/**
 * The language examples through the public facade: parameters inferred from uses, origins, the
 * heterogeneous union and its collect(), bound variables and contribution identity, staged aggregation, ordinals,
 * bounded subsets, imports and ordering. Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires
 * on the next line; refusals sit inside functions the runtime check never calls, because the fixtures also run.
 */
const text = str.regex("^.*$", "su")

export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Account = relation("Account", { id: uuid, name: text }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const TaskNote = relation("TaskNote", { task: uuid, note: text }, ["task"])
export const Work = schema("Work", { Kind, Account, Task, TaskNote }, [
	contained(on(TaskNote, "task"), on(Task, "id")),
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Task, "kind"), on(Kind, "id"))
])

/** A variable's host type is its field's. */
type TaskVars = ReturnType<typeof v<typeof Task>>
export type TaskKindHost = Expect<Equals<TypeOfTerm<TaskVars["kind"]>, "Automatic" | "Manual">>

/** The account parameter is a required string, inferred from its use. */
export const tasksForAccount = query(Work).rule((r) => {
	const { id, account, kind } = v(Task)
	return r
		.match(Task, { id, account, kind })
		.where(r.eq(account, r.param("account", uuid)))
		.find({ id, kind })
})

export type TasksForAccountParams = Expect<
	Equals<ParamsOf<typeof tasksForAccount>, { readonly account: string }>
>

export type TasksForAccountHead = Expect<
	Equals<
		HeadOf<typeof tasksForAccount>,
		{ readonly id: string; readonly kind: "Automatic" | "Manual" }
	>
>

/** A relation parameter is a set-valued source. */
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

/** r.param(name, Relation) types the parameter by the relation's heading. */
export const incoming = query(Work).rule((r) => {
	const wanted = r.relation("incoming", Task)
	const { id, account, kind } = v(wanted)
	return r.match(wanted, { id, account, kind }).find({ id, account })
})

type IncomingTask = {
	readonly id: string
	readonly account: string
	readonly kind: "Automatic" | "Manual"
}

export type IncomingParams = Expect<
	Equals<
		ParamsOf<typeof incoming>,
		{ readonly incoming: ReadonlyArray<IncomingTask> | Stream.Stream<IncomingTask> }
	>
>

/**
 * The gate: preferencesByState infers a required boolean parameter enabled and a boolean answer
 * field.
 */
export const Preference = relation("Preference", { account: uuid, enabled: pg.boolean }, [
	"account"
])
export const Settings = schema("Settings", { Preference }, [])
export const preferencesByState = query(Settings).rule((r) => {
	const { account, enabled } = v(Preference)
	return r
		.match(Preference, { account, enabled })
		.where(r.eq(enabled, r.param("enabled", pg.boolean)))
		.find({ account, enabled })
})

export type PreferencesByStateParams = Expect<
	Equals<ParamsOf<typeof preferencesByState>, { readonly enabled: boolean }>
>

export type PreferencesByStateHead = Expect<
	Equals<HeadOf<typeof preferencesByState>, { readonly account: string; readonly enabled: boolean }>
>

/** The parameter is required: no binding object without it, and no non-boolean, is a parameter map of the query. */
export const preferenceReads = (db: DbOf<typeof Settings, unknown>) => {
	const ok = db.execute(preferencesByState, { enabled: false })
	// @ts-expect-error -- TS2345: enabled is required
	const missing = db.execute(preferencesByState, {})
	// @ts-expect-error -- TS2322: enabled is a boolean, never a truthy value
	const truthy = db.execute(preferencesByState, { enabled: 1 })
	return [ok, missing, truthy]
}

/** A literal false binding finds explicit false values; r.not tests absence. */
export const disabled = query(Settings).rule((r) => {
	const { account } = v(Preference)
	return r.match(Preference, { account, enabled: false }).find({ account })
})

export const unrecorded = query(Work).rule((r) => {
	const { id } = v(Account)
	return r
		.match(Account, { id })
		.where(r.not(TaskNote, { task: id }))
		.find({ id })
})

/**
 * The gate: arms of different headings sharing the literal discriminant role. The element type is the
 * discriminated union of the arm headings, and so is what collect() delivers.
 */
export const Role = closed("Role", ["reported", "rejected", "omitted"])
export const Enrollment = relation("Enrollment", { assertion: uuid, role: closedId(Role) }, [
	"assertion"
])

export const RoleReported = relation("RoleReported", { assertion: uuid, value: text }, [
	"assertion"
])

export const RoleRejected = relation("RoleRejected", { assertion: uuid, issue: uuid }, [
	"assertion"
])
export const Roster = schema("Roster", { Role, Enrollment, RoleReported, RoleRejected }, [])
export const roles = query(Roster)
	.rule((r) => {
		const { assertion } = v(Enrollment)
		const { value } = v(RoleReported)
		return r
			.match(Enrollment, { assertion, role: "reported" })
			.match(RoleReported, { assertion, value })
			.find({ assertion, role: Role.handle("reported"), value })
	})
	.rule((r) => {
		const { assertion } = v(Enrollment)
		const { issue } = v(RoleRejected)
		return r
			.match(Enrollment, { assertion, role: "rejected" })
			.match(RoleRejected, { assertion, issue })
			.find({ assertion, role: Role.handle("rejected"), issue })
	})
	.rule((r) => {
		const { assertion } = v(Enrollment)
		return r
			.match(Enrollment, { assertion, role: "omitted" })
			.find({ assertion, role: Role.handle("omitted") })
	})

type RoleRow =
	| { readonly assertion: string; readonly role: "reported"; readonly value: string }
	| { readonly assertion: string; readonly role: "rejected"; readonly issue: string }
	| { readonly assertion: string; readonly role: "omitted" }
export type RolesHead = Expect<Equals<HeadOf<typeof roles>, RoleRow>>
export const readRoles = (db: DbOf<typeof Roster, unknown>) => db.execute(roles, {})
type RolesResult = Effect.Success<ReturnType<typeof readRoles>>
export type RolesResultType = Expect<Equals<RolesResult, QueryResult<RoleRow>>>
export type RolesCollect = Expect<
	Equals<RolesResult["collect"], Effect.Effect<ReadonlyArray<RoleRow>, ReadError>>
>
/** The union is discriminated: narrowing on role narrows the row to its arm's fields. */
type Collected = Effect.Success<RolesResult["collect"]>[number]
export const describeRole = (row: Collected): string => {
	switch (row.role) {
		case "reported":
			return row.value
		case "rejected":
			return row.issue
		case "omitted":
			return row.assertion
	}
}

export const undiscriminated = (row: Collected): string =>
	// @ts-expect-error -- TS2339: value exists only in the reported arm
	row.value

/** v over the union mints a variable per field of any arm; binding the discriminant selects one arm. */
export const reportedValues = query(Roster).rule((r) => {
	const { assertion, value } = v(roles)
	return r.match(roles, { assertion, role: "reported", value }).find({ assertion, value })
})

export type ReportedValuesHead = Expect<
	Equals<HeadOf<typeof reportedValues>, { readonly assertion: string; readonly value: string }>
>
/** Each variable has the union of its arms' host types, Vars<RoleRow>, and the SQL type its arms share. */
type RolesVarsOf = ReturnType<typeof v<typeof roles>>
export type RolesVars = Expect<
	Equals<
		{ readonly [K in keyof RolesVarsOf]: TypeOfTerm<RolesVarsOf[K]> },
		{ readonly [K in keyof Vars<RoleRow>]: TypeOfTerm<Vars<RoleRow>[K]> }
	>
>

export type RolesVarsSql = Expect<
	Equals<
		{ readonly [K in "assertion" | "value" | "issue"]: SqlOfTerm<RolesVarsOf[K]> },
		{ readonly assertion: "uuid"; readonly value: "text"; readonly issue: "uuid" }
	>
>
/** Ordering over the union uses common fields, the gate: role and assertion are common, value is not. */
export type RolesCommon = Expect<Equals<CommonKeys<HeadOf<typeof roles>>, "assertion" | "role">>
export const rolesOrdered = roles.orderBy(["role", "asc"], ["assertion", "desc"])
export const rolesByValue = () =>
	// @ts-expect-error -- TS2322: value is not common to every arm
	roles.orderBy(["value", "asc"])

export const rolesByIssue = () =>
	// @ts-expect-error -- TS2322: issue is not common to every arm
	roles.orderBy(["assertion", "asc"], ["issue", "desc"])
export const rolesTaken = rolesOrdered.take(2)
export type RolesTakenHead = Expect<Equals<HeadOf<typeof rolesTaken>, RoleRow>>

/** Bound variables define contribution identity; both sums are numeric over bigint. */
export const Posting = relation("Posting", { id: uuid, account: uuid, amount: pg.bigint }, ["id"])
export const Ledger = schema("Ledger", { Posting }, [])
export const byFact = query(Ledger).rule((r) => {
	const { id, account, amount } = v(Posting)
	return r.match(Posting, { id, account, amount }).find({ account, total: r.sum(amount) })
})

export const byAmount = query(Ledger).rule((r) => {
	const { account, amount } = v(Posting)
	return r.match(Posting, { account, amount }).find({ account, total: r.sum(amount) })
})

export type ByFactHead = Expect<
	Equals<HeadOf<typeof byFact>, { readonly account: string; readonly total: Decimal }>
>
export type ByAmountHead = Expect<Equals<HeadOf<typeof byAmount>, HeadOf<typeof byFact>>>
/** Grouped by account, keyed by it. */
export type ByFactKeys = Expect<
	Equals<EvidenceOfQuery<typeof byFact>["keys"], readonly [ReadonlyArray<"account">]>
>

/** A staged aggregation over an imported query's heading. */
export const amounts = query(Ledger).rule((r) => {
	const { account, amount } = v(Posting)
	return r.match(Posting, { account, amount }).find({ account, amount })
})

export const staged = query(Ledger).rule((r) => {
	const row = v(amounts)
	return r.match(amounts, row).find({ account: row.account, total: r.sum(row.amount) })
})

export type StagedHead = Expect<
	Equals<HeadOf<typeof staged>, { readonly account: string; readonly total: Decimal }>
>

/** Ordinals as counts under a completed order. */
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Sitting = relation(
	"Sitting",
	{ id: uuid, student: uuid, scoreDate: pg.bigint, score: Cents },
	["id"]
)
export const Exams = schema("Exams", { Sitting }, [])
export const ordinals = query(Exams).rule((r) => {
	const s = v(Sitting)
	const t = v(Sitting)
	return r
		.match(Sitting, { student: s.student, id: s.id, scoreDate: s.scoreDate })
		.match(Sitting, { student: s.student, id: t.id, scoreDate: t.scoreDate })
		.where(
			r.or(r.lt(t.scoreDate, s.scoreDate), r.and(r.eq(t.scoreDate, s.scoreDate), r.le(t.id, s.id)))
		)
		.find({ student: s.student, id: s.id, ordinal: r.count() })
})

export type OrdinalsHead = Expect<
	Equals<
		HeadOf<typeof ordinals>,
		{ readonly student: string; readonly id: string; readonly ordinal: bigint }
	>
>

/** min and max keep a contract; mean is numeric; a conditional count is a sum of ones and zeros. */
export const scoreStats = query(Exams).rule((r) => {
	const { id, student, score } = v(Sitting)
	return r.match(Sitting, { id, student, score }).find({
		student,
		best: r.max(score),
		worst: r.min(score),
		mean: r.mean(score),
		passes: r.sum(Compute.cond(r.ge(score, Cents(50n)), Compute.literal(pg.integer, 1), 0))
	})
})
type CentsHost = bigint & Brand.Brand<"Cents">
export type ScoreStatsHead = Expect<
	Equals<
		HeadOf<typeof scoreStats>,
		{
			readonly student: string
			readonly best: CentsHost
			readonly worst: CentsHost
			readonly mean: Decimal
			readonly passes: bigint
		}
	>
>

/**
 * take(k) closes an ordered query into a set; bind imports it per account; a named k joins the
 * parameters as an integer.
 */
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: Cents }, ["task"])
export const Budgets = schema("Budgets", { Account, Task, AutomaticTask }, [])
export const latestBudget = query(Budgets)
	.rule((r) => {
		const { id } = v(Task)
		const { budget } = v(AutomaticTask)
		return r
			.match(Task, { id, account: r.param("account", Task.fields.account) })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, budget })
	})
	.orderBy(["budget", "desc"])
	.take(3)

export const topThreePerAccount = query(Budgets).rule((r) => {
	const { id: account } = v(Account)
	const top = latestBudget.bind({ account })
	const { id, budget } = v(top)
	return r.match(Account, { id: account }).match(top, { id, budget }).find({ account, id, budget })
})
export type TopThreeParams = Expect<Equals<ParamNamesOf<typeof topThreePerAccount>, never>>
export const batched = latestBudget.orderBy(["budget", "asc"]).take("batch")
export type BatchedParams = Expect<
	Equals<ParamsOf<typeof batched>, { readonly account: string; readonly batch: number }>
>

/** take(1) is at most one row. */
export const newest = query(Budgets)
	.rule((r) => {
		const { id } = v(Task)
		return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
	})
	.orderBy(["id", "desc"])
	.take(1)
export type NewestCard = Expect<Equals<EvidenceOfQuery<typeof newest>["card"], "atMostOne">>
export const importRefusals = () => {
	// @ts-expect-error -- TS2345: bind requires every parameter
	const partial = latestBudget.bind({})
	const unbound = query(Budgets).rule((r) => {
		const { id } = v(latestBudget)
		// @ts-expect-error -- TS2345 refusal: bind the query's parameters before matching it: Q.bind({ ... })
		return r.match(latestBudget, { id }).find({ id })
	})
	return [partial, unbound]
}

/** Comparisons are typed: no number for numeric, no contract against its base. */
export const Line = relation(
	"Line",
	{ id: uuid, amount: pg.numeric(12, 2), cents: Cents, n: pg.bigint },
	["id"]
)
export const Lines = schema("Lines", { Line }, [])
export const numericFilter = query(Lines).rule((r) => {
	const { id, amount } = v(Line)
	return r.match(Line, { id, amount }).where(r.gt(amount, "10.50"), r.lt(amount, 100n)).find({ id })
})

export const comparisonRefusals = () => [
	query(Lines).rule((r) => {
		const { id, amount } = v(Line)
		// @ts-expect-error -- TS2345: a JavaScript number is never a numeric literal
		return r.match(Line, { id, amount }).where(r.gt(amount, 10)).find({ id })
	}),
	query(Lines).rule((r) => {
		const { id, cents, n } = v(Line)
		// @ts-expect-error -- TS2345: a contract term never meets its bare base
		return r.match(Line, { id, cents, n }).where(r.eq(cents, n)).find({ id })
	}),
	query(Lines).rule((r) => {
		const { id } = v(Line)
		// @ts-expect-error -- TS2322 refusal: not a field of the arms the bindings select
		return r.match(Line, { id, nope: id }).find({ id })
	})
]
/**
 * r.pointIn takes a term as its point: a parameter never stands first, here in a parameter span.
 * test/unit/spans/lowering.test.ts runs the same call through the runtime's admission core.
 */
const Slot = relation("Slot", { id: pg.integer, during: span(pg.integer) }, ["id"])
const Slots = schema("Slots", { Slot }, [])
export const pointInRefusal = () =>
	query(Slots).rule((r) => {
		const { id } = v(Slot)
		// @ts-expect-error -- TS2345 refusal: a term first: a parameter or a literal takes its place opposite a term, never first
		const within = r.pointIn(r.param("t", pg.integer), r.param("window", span(pg.integer)))
		return r.match(Slot, { id }).where(within).find({ id })
	})

/** A parameter compared with a contract field takes the contract's host type. */
export const centsAtLeast = query(Lines).rule((r) => {
	const { id, cents } = v(Line)
	return r
		.match(Line, { id, cents })
		.where(r.ge(cents, r.param("floor", Cents)))
		.find({ id, cents })
})

export type CentsAtLeastParams = Expect<
	Equals<ParamsOf<typeof centsAtLeast>, { readonly floor: CentsHost }>
>

/** An interior stage is a source of the rule that describes it; its parameters join the rule's. */
export const interiorStage = query(Work).rule((r) => {
	const stage = r.interior((r2) => {
		const { id } = v(Task)
		return r2.match(Task, { id, account: r2.param("account", Task.fields.account) }).find({ id })
	})
	const { id } = v(stage)
	return r.match(stage, { id }).find({ id })
})

export type InteriorParams = Expect<
	Equals<ParamsOf<typeof interiorStage>, { readonly account: string }>
>

/** A rule matches only relations of its schema. */
export const foreignMatch = () =>
	query(Settings).rule((r) => {
		const { id } = v(Task)
		// @ts-expect-error -- TS2345 refusal: the relation is not in this query's schema
		return r.match(Task, { id }).find({ id })
	})

/** Attachment over a keyed child is an Option. */
export const tasksWithNotes = tasksForAccount.attach(
	"note",
	(t) =>
		query(Work).rule((r) => {
			const { note } = v(TaskNote)
			return r.match(TaskNote, { task: t.id, note }).find({ note })
		}),
	"option"
)

export type TasksWithNotesNote = Expect<
	Equals<HeadOf<typeof tasksWithNotes>["note"], Option.Option<{ readonly note: string }>>
>

/** An attachment's name is a new field: one the parent's heading already has is refused. */
export const staleAttachmentName = () =>
	tasksForAccount.attach(
		// @ts-expect-error -- TS2345 refusal: a new field name for the attachment
		"kind",
		(t) =>
			query(Work).rule((r) => {
				const { note } = v(TaskNote)
				return r.match(TaskNote, { task: t.id, note }).find({ note })
			}),
		"option"
	)

/**
 * A comparison's operands are of one SQL type, as the lowering checks them: a parameter is of the SQL type of the
 * descriptor it is declared with, so a smallint meets a smallint parameter and never an integer one.
 */
export const Walk = relation("Walk", { id: uuid, hops: pg.smallint }, ["id"])
export const Walks = schema("Walks", { Walk }, [])
export const withinLimit = query(Walks).rule((r) => {
	const { id, hops } = v(Walk)
	return r
		.match(Walk, { id, hops })
		.where(r.lt(hops, r.param("limit", pg.smallint)))
		.find({ id })
})

export const integerLimit = () =>
	query(Walks).rule((r) => {
		const { id, hops } = v(Walk)
		// @ts-expect-error -- TS2345: operands of one SQL type: a smallint never meets an integer parameter
		const below = r.lt(hops, r.param("limit", pg.integer))
		return r.match(Walk, { id, hops }).where(below).find({ id })
	})

/**
 * One attachment statement delivers one heading: a child whose rows are a union of arms of different headings is
 * refused, from a query and from an arm that attaches before it joins a union, and a union of arms of one heading
 * attaches.
 */
export const enrolled = query(Roster).rule((r) => {
	const { assertion } = v(Enrollment)
	return r.match(Enrollment, { assertion }).find({ assertion })
})

export const enrolledRoles = enrolled.attach(
	"arm",
	(e) =>
		query(Roster)
			.rule((r) =>
				r
					.match(RoleReported, { assertion: e.assertion })
					.find({ assertion: e.assertion, role: r.literal("reported") })
			)
			.rule((r) =>
				r
					.match(RoleRejected, { assertion: e.assertion })
					.find({ assertion: e.assertion, role: r.literal("rejected") })
			),
	"array"
)

export type EnrolledRolesArm = Expect<
	Equals<
		HeadOf<typeof enrolledRoles>["arm"],
		ReadonlyArray<
			| { readonly assertion: string; readonly role: "reported" }
			| { readonly assertion: string; readonly role: "rejected" }
		>
	>
>

export const heterogeneousAttach = () =>
	enrolled.attach(
		"arm",
		(e) =>
			// @ts-expect-error -- TS2322 refusal: an attached heterogeneous union; one attachment statement delivers one heading
			query(Roster)
				.rule((r) => {
					const { value } = v(RoleReported)
					return r
						.match(RoleReported, { assertion: e.assertion, value })
						.find({ role: r.literal("reported"), value })
				})
				.rule((r) => {
					const { issue } = v(RoleRejected)
					return r
						.match(RoleRejected, { assertion: e.assertion, issue })
						.find({ role: r.literal("rejected"), issue })
				}),
		"array"
	)

export const heterogeneousArmAttach = () =>
	query(Roster).rule((r) => {
		const { assertion } = v(Enrollment)
		return r
			.match(Enrollment, { assertion })
			.find({ assertion })
			.attach(
				"arm",
				(e) =>
					// @ts-expect-error -- TS2322 refusal: an attached heterogeneous union; one attachment statement delivers one heading
					query(Roster)
						.rule((r2) => {
							const { value } = v(RoleReported)
							return r2
								.match(RoleReported, { assertion: e.assertion, value })
								.find({ role: r2.literal("reported"), value })
						})
						.rule((r2) => {
							const { issue } = v(RoleRejected)
							return r2
								.match(RoleRejected, { assertion: e.assertion, issue })
								.find({ role: r2.literal("rejected"), issue })
						}),
				"array"
			)
	})

/**
 * A parameter reaches the program's map exactly wherever it is declared, beside terms that need none: a match field
 * whose sibling fields are variables, an Allen predicate over a variable, and a head term beside variables. A map that
 * needs no parameter never erases its neighbours' in the fold over a record of terms.
 */
export const paramInMatchField = query(Work).rule((r) => {
	const { id, kind } = v(Task)
	return r.match(Task, { id, kind, account: r.param("account", Task.fields.account) }).find({ id })
})

export type ParamInMatchFieldParams = Expect<
	Equals<ParamsOf<typeof paramInMatchField>, { readonly account: string }>
>

export const paramInAllen = query(Slots).rule((r) => {
	const { id, during } = v(Slot)
	return r
		.match(Slot, { id, during })
		.where(r.allen(during, ALLEN.overlaps, r.param("window", Slot.fields.during)))
		.find({ id })
})

export type ParamInAllenParams = Expect<
	Equals<ParamsOf<typeof paramInAllen>, { readonly window: Span<number> }>
>

export const paramInHead = query(Work).rule((r) => {
	const { id } = v(Task)
	return r.match(Task, { id }).find({ id, label: r.param("label", text) })
})

export type ParamInHeadParams = Expect<
	Equals<ParamsOf<typeof paramInHead>, { readonly label: string }>
>
