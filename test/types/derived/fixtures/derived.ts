import type { Brand } from "effect"
import type { DbOf } from "#adapter/types/db.ts"
import type { FieldHost } from "#compiler/core/decoder.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Compute } from "#compiler/public/compute.ts"
import { closedId, contract, Decimal, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	check,
	closed,
	contained,
	derived,
	fin,
	type KeysOf,
	key,
	type LevelsOf,
	mirrors,
	mutable,
	on,
	type RefreshListOf,
	relation,
	role,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { Carrier, SqlOfCarrier } from "#compiler/types/core/phantom.ts"
import type { RelationFieldsOf } from "#compiler/types/schema/relation.ts"
import type { Equals, Expect, IsAssignable, Not } from "#test/types/derived/support.ts"

/**
 * The derived-relations type gate: derived relations through the public barrels.
 *
 * The five refusals the gate names, each a type error with the diagnostic its directive states: a parameterized
 * definition, a definition reading its own level, a law over a derived relation, a ChangeSet member naming a derived
 * relation, and a refresh outside the role's refresh list. Beside them: the fields a derived relation infers from
 * its definition's head, its inherited keys, levels and the definitions a materialized view cannot store (an empty
 * head, several heading groups). Every `@ts-expect-error -- TSnnnn` names the diagnostic the harness requires on the
 * next line; refusals sit inside functions nothing calls.
 */
type Cents = bigint & Brand.Brand<"Cents">

/** The schema the summaries read. */
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Code = str.regex("^[A-Z]{3}$")
export const Account = relation("Account", { id: uuid, code: Code, limit: pg.integer }, ["id"])
export const Task = relation(
	"Task",
	{ id: pg.bigserial, account: uuid, kind: closedId(Kind), cost: Cents, hours: pg.real },
	["id"]
)
export const AutomaticTask = relation("AutomaticTask", { task: pg.bigint, budget: Cents }, ["task"])
export const Work = schema("Work", { Kind, Account, Task, AutomaticTask }, [
	contained(on(Task, "account"), on(Account, "id"))
])

export const Writer = role(Work, "writer", Work.relations, {
	write: ["Account", "Task", "AutomaticTask"]
})

/** AccountBudget is keyed by its group term. */
export const automaticBudget = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { budget } = v(AutomaticTask, "automaticTask")
	return r
		.match(Task, { id, account, kind: "Automatic" })
		.match(AutomaticTask, { task: id, budget })
		.find({ account, tasks: r.count(), budget: r.sum(budget) })
})
export const AccountBudget = derived("AccountBudget", automaticBudget)

/** A plain head over one match keeps every field's own descriptor; a serial field reads as its plain width. */
export const taskFacts = query(Work).rule((r) => {
	const { id, account, kind, cost } = v(Task, "task")
	return r.match(Task, { id, account, kind, cost }).find({ id, account, kind, cost })
})
export const TaskFacts = derived("TaskFacts", taskFacts)

/** Aggregates: the host type names the SQL type where it determines one. */
export const taskTotals = query(Work).rule((r) => {
	const { id, account, cost, hours } = v(Task, "task")
	return r.match(Task, { id, account, cost, hours }).find({
		account,
		n: r.count(),
		total: r.sum(cost),
		mean: r.mean(cost),
		least: r.min(cost),
		hours: r.sum(hours),
		flag: Compute.literal(pg.boolean, true)
	})
})
export const TaskTotals = derived("TaskTotals", taskTotals)

export const Reports = schema.extend(Work, { AccountBudget, TaskFacts, TaskTotals }, [])
export const Reporter = role(Reports, "reporter", Reports.relations)
export const Refresher = role(Reports, "refresher", Reports.relations, {
	refresh: ["AccountBudget", "TaskFacts", "TaskTotals"]
})

/** 1. Fields are inferred from the head: each is its head term's carrier, of the term's host and SQL type. */
type CarriersOf<R> = {
	readonly [K in keyof RelationFieldsOf<R>]: Carrier<
		FieldHost<RelationFieldsOf<R>[K]>,
		SqlOfCarrier<RelationFieldsOf<R>[K]>
	>
}

export type BudgetFields = Expect<
	Equals<
		CarriersOf<typeof AccountBudget>,
		{
			readonly account: Carrier<Uuid, "uuid">
			readonly tasks: Carrier<bigint, "bigint">
			readonly budget: Carrier<Decimal, "numeric">
		}
	>
>

export type FactAccount = Expect<
	Equals<CarriersOf<typeof TaskFacts>["account"], Carrier<Uuid, "uuid">>
>

export type FactKind = Expect<
	Equals<CarriersOf<typeof TaskFacts>["kind"], Carrier<"Automatic" | "Manual", "code">>
>

/** A contract keeps its brand and its SQL type. */
export type FactCost = Expect<
	Equals<CarriersOf<typeof TaskFacts>["cost"], Carrier<Cents, "bigint">>
>
/** A serial field is a plain bigint column of the view. */
export type FactId = Expect<Equals<CarriersOf<typeof TaskFacts>["id"], Carrier<bigint, "bigint">>>
/** sum and mean of a contract have the base's result type; min keeps the brand. */
export type TotalsSum = Expect<
	Equals<CarriersOf<typeof TaskTotals>["total"], Carrier<Decimal, "numeric">>
>

export type TotalsMean = Expect<
	Equals<CarriersOf<typeof TaskTotals>["mean"], Carrier<Decimal, "numeric">>
>

export type TotalsMin = Expect<
	Equals<CarriersOf<typeof TaskTotals>["least"], Carrier<Cents, "bigint">>
>

export type TotalsCount = Expect<
	Equals<CarriersOf<typeof TaskTotals>["n"], Carrier<bigint, "bigint">>
>

export type TotalsFlag = Expect<
	Equals<CarriersOf<typeof TaskTotals>["flag"], Carrier<boolean, "boolean">>
>

/** A float sum keeps its operand's SQL type, which the host type alone does not name. */
export type TotalsHours = Expect<
	Equals<CarriersOf<typeof TaskTotals>["hours"], Carrier<number, "real">>
>

/** 2. Keys are inherited, never declared. */
export type BudgetKeys = Expect<
	Equals<KeysOf<typeof Reports, typeof AccountBudget>, ReadonlyArray<"account">>
>

export type FactKeys = Expect<
	Equals<
		KeysOf<typeof Reports, typeof TaskFacts>,
		ReadonlyArray<"id"> | ReadonlyArray<"id" | "account" | "kind" | "cost">
	>
>

/**
 * A variable minted over a derived relation carries the relation and field as its origin, so a match on the inherited
 * key pins the occurrence.
 */
export const budgetOf = query(Reports).rule((r) => {
	const { tasks } = v(AccountBudget, "accountBudget")
	return r
		.match(AccountBudget, { account: r.param("account", Task.fields.account), tasks })
		.find({ tasks })
})

/** 3. Levels: a query over Work is a query over Reports; a definition is a query over a level below its extension. */
export type ReportsLevels = Expect<Equals<LevelsOf<typeof Reports>, typeof Reports | typeof Work>>
export const overReports = query(Reports).rule((r) => {
	const { account, tasks } = v(AccountBudget, "accountBudget")
	return r.match(AccountBudget, { account, tasks }).find({ account, tasks })
})
export const BudgetCopy = derived("BudgetCopy", overReports)
/** The second level reads the first. */
export const Level2 = schema.extend(Reports, { BudgetCopy }, [])
export const Auditor = role(Level2, "auditor", Level2.relations)
export type Level2Levels = Expect<
	Equals<LevelsOf<typeof Level2>, typeof Level2 | typeof Reports | typeof Work>
>

export const ownLevel = () =>
	// @ts-expect-error -- TS2322: a definition over Reports does not exist at Reports' own level
	schema.extend(Work, { BudgetCopy }, [])

/** 4. A definition is parameterless. */
export const tasksOf = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})

export const parameterized = () =>
	// @ts-expect-error -- TS2345: a derived definition reads no parameter
	derived("TasksOf", tasksOf)

/** A bound import is parameterless: the binding supplies the import's parameter. */
export const boundImport = query(Work).rule((r) => {
	const { id: account } = v(Account, "account")
	const tasks = tasksOf.bind({ account })
	const { id } = v(tasks, "tasks")
	return r.match(Account, { id: account }).match(tasks, { id }).find({ account, id })
})
export const BoundImport = derived("BoundImport", boundImport)

/** 5. A materialized view stores one heading with at least one column. */
export const nothing = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id }).find({})
})

export const emptyHead = () =>
	// @ts-expect-error -- TS2345 refusal: a derived definition has at least one field
	derived("Nothing", nothing)

export const mixed = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Automatic" }).find({ id, kind: Kind.handle("Automatic") })
	})
	.rule((r) => {
		const { id, account } = v(Task, "task")
		return r
			.match(Task, { id, account, kind: "Manual" })
			.find({ id, kind: Kind.handle("Manual"), account })
	})

export const severalHeadings = () =>
	// @ts-expect-error -- TS2345 refusal: a derived definition has one heading: a materialized view stores one heading group
	derived("Mixed", mixed)

/** Arms that differ only in a discriminant's value are one heading. */
export const kinds = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Automatic" }).find({ id, kind: Kind.handle("Automatic") })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		return r.match(Task, { id, kind: "Manual" }).find({ id, kind: Kind.handle("Manual") })
	})
export const Kinds = derived("Kinds", kinds)

/** 6. No law names a derived relation, on either side. */
export const laws = () => [
	// @ts-expect-error -- TS2345: a key's side is never over a derived relation
	key(on(AccountBudget, "account")),
	// @ts-expect-error -- TS2739: mutable takes ordinary relations only
	mutable(AccountBudget),
	// @ts-expect-error -- TS2739: check takes ordinary relations only
	check("Positive", AccountBudget, (b) => b.and()),
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	contained(on(AccountBudget, "account"), on(Account, "id")),
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	contained(on(Task, "account"), on(AccountBudget, "account")),
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	mirrors(on(AccountBudget, "account"), on(Account, "id")),
	// @ts-expect-error -- TS2345: a selection is never over a derived relation
	select(AccountBudget, (b) => b.and()),
	// @ts-expect-error -- TS2345: alternatives takes no derived parent
	alternatives(AccountBudget, "account", Kind, {}),
	// @ts-expect-error -- TS2739: a family's slots are never a derived relation's
	fin(AccountBudget, "tasks")
]

/** A role's write list never names a derived relation, and its refresh list names derived relations only. */
export const lists = () => [
	// @ts-expect-error -- TS2345: a write list never names a derived relation
	role(Reports, "bad", Reports.relations, { write: ["AccountBudget"] }),
	// @ts-expect-error -- TS2345: a refresh list names derived relations only
	role(Reports, "bad", Reports.relations, { refresh: ["Task"] })
]

/** 7. No ChangeSet member names a derived relation. */
export const members = () => [
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
	ChangeSet.empty(Reports).insert(AccountBudget, [
		{ account: "a", tasks: 1n, budget: Decimal.zero }
	]),
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
	ChangeSet.empty(Reports).delete(AccountBudget, []),
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
	ChangeSet.empty(Reports).put(AccountBudget, [])
]

export const deltaOfDerived = () =>
	ChangeSet.empty(Reports).read("removed", (delta) =>
		query(Reports).rule((r) =>
			// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only the ordinary relations of its schema and the world relations its role writes
			r.match(delta.removed(AccountBudget), {}).find({ one: Compute.literal(pg.integer, 1) })
		)
	)

/** 8. db.refresh names only the derived relations the role lists under refresh. */
export type RefresherList = Expect<
	Equals<
		RefreshListOf<typeof Refresher>,
		typeof AccountBudget | typeof TaskFacts | typeof TaskTotals
	>
>
export type ReporterList = Expect<Equals<RefreshListOf<typeof Reporter>, never>>
export const refreshes = (refresher: DbOf<typeof Refresher, unknown>) =>
	refresher.refresh(AccountBudget, TaskTotals)
export const refreshNothing = (refresher: DbOf<typeof Refresher, unknown>) =>
	// @ts-expect-error -- TS2555: a refresh names at least one derived relation
	refresher.refresh()
export const reporterRefresh = (reporter: DbOf<typeof Reporter, unknown>) =>
	// @ts-expect-error -- TS2345: the reporter refreshes nothing
	reporter.refresh(AccountBudget)

export const writerRefresh = (writer: DbOf<typeof Writer, unknown>) =>
	// @ts-expect-error -- TS2345: Work has no derived relation, and the writer refreshes nothing
	writer.refresh(AccountBudget)

/** Level2's auditor reads BudgetCopy and refreshes nothing at that level either. */
export const auditorRefresh = (auditor: DbOf<typeof Auditor, unknown>) =>
	// @ts-expect-error -- TS2345: the auditor refreshes nothing
	auditor.refresh(BudgetCopy)
export type DerivedNotWritable = Expect<Not<IsAssignable<typeof AccountBudget, typeof Task>>>
