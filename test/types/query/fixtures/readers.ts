import type { Effect, Option } from "effect"
import type { OpenError, ReadError } from "#adapter/errors/execution.ts"
import type { DbOf as DbType } from "#adapter/types/db.ts"
import type { DbLayerService } from "#adapter/types/layer.ts"
import type { ChangeSet as PublicChangeSet } from "#compiler/public/changeset.ts"
import { closedId, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
import { type EvidenceOfQuery, type HeadOf, query, v } from "#compiler/public/query.ts"
import {
	alternatives,
	closed,
	contained,
	derived,
	type KeysOf,
	key,
	login,
	mirrors,
	mutable,
	on,
	relation,
	role,
	schema,
	select
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { ChangeSet as ChangeSetType, WritesOf } from "#compiler/types/changeset/changeset.ts"
import { Db } from "#index.ts"
import type { Equals, Expect } from "#test/types/query/support.ts"

/**
 * The seven readers of the schema's captured statements, each exercised through the public
 * facade, and Db.open of a role:
 *
 * 1. attach types its result ReadonlyArray, Option or the bare child from key and containment evidence;
 * 2. get accepts any query proved at most one row, and a key;
 * 3. alternatives checks its arm map against the declared keys;
 * 4. derived carries the keys its definition proves and refuses any law that names a derived relation;
 * 5. apply checks a ChangeSet against the role's write list;
 * 6. orderBy orders by fields common to every arm;
 * 7. mirrors and contained check side compatibility.
 *
 * Uses of Db and ChangeSet sit inside functions the runtime check never calls, and their values are declared here by
 * the type of the skeleton's declaration. Every `@ts-expect-error --
 * TSnnnn` names the diagnostic the harness requires on the next line.
 */
declare const ChangeSet: typeof PublicChangeSet

const text = str.regex("^.*$", "su")

export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Tier = closed("Tier", ["Free", "Pro"])
export const Account = relation("Account", { id: uuid, name: text, tier: closedId(Tier) }, ["id"])
export const Task = relation(
	"Task",
	{ id: uuid, account: uuid, kind: closedId(Kind), title: text },
	["id"]
)
export const AutomaticTask = relation("AutomaticTask", { task: uuid, budget: pg.bigint }, ["task"])
export const ManualTask = relation("ManualTask", { task: uuid, operator: text }, ["task"])
export const Numbered = relation("Numbered", { n: pg.bigint, kind: closedId(Kind) }, ["n"])
export const byName = key(Account, ["name"])
export const Work = schema("Work", { Kind, Tier, Account, Task, AutomaticTask, ManualTask }, [
	byName,
	contained(on(Task, "account"), on(Account, "id")),
	contained(on(Account, "tier"), on(Tier, "id")),
	alternatives(Task, "kind", Kind, { Automatic: AutomaticTask, Manual: ManualTask }),
	mutable(Account)
])
export const Reader = role(Work, "reader", Work.relations)
export const Writer = role(Work, "writer", Work.relations, {
	write: ["Task", "AutomaticTask", "ManualTask"]
})

/**
 * 1. attach. A child keyed through the parent's variable is an Option; a child read from a closed relation through a
 * declared containment, with no further predicate, is the bare fact; a child bound on no key is a set.
 */
export const accounts = query(Work).rule((r) => {
	const { id, name, tier } = v(Account, "account")
	return r.match(Account, { id, name, tier }).find({ id, name, tier })
})

export const accountCards = accounts
	.attach(
		"tierFact",
		(a) => query(Work).rule((r) => r.match(Tier, { id: a.tier }).find({ tier: a.tier })),
		"one"
	)
	.attach(
		"tasks",
		(a) =>
			query(Work).rule((r) => {
				const { id, title } = v(Task, "task")
				return r.match(Task, { id, account: a.id, title }).find({ id, title })
			}),
		"array"
	)
	.attach(
		"self",
		(a) =>
			query(Work).rule((r) => {
				const { name } = v(Account, "account")
				return r.match(Account, { id: a.id, name }).find({ name })
			}),
		"option"
	)

export type AccountCardsHead = Expect<
	Equals<
		HeadOf<typeof accountCards>,
		{
			readonly id: Uuid
			readonly name: string
			readonly tier: "Free" | "Pro"
			readonly tierFact: { readonly tier: "Free" | "Pro" }
			readonly tasks: ReadonlyArray<{ readonly id: Uuid; readonly title: string }>
			readonly self: Option.Option<{ readonly name: string }>
		}
	>
>

/** A child that is a query over another schema is no child of this one. */
export const foreignChild = () => {
	const Other = schema("Other", { Kind }, [])
	return accounts.attach(
		"other",
		() =>
			// @ts-expect-error -- TS2322: an attachment child is a query over a level of the parent's schema
			query(Other).rule((r) =>
				r.match(Kind, { id: "Manual" }).find({ kind: Kind.handle("Manual") })
			),
		"array"
	)
}

/** 2. get: a lookup through the primary key, a candidate key, or any query proved at most one row. */
export const accountById = query(Work).rule((r) => {
	const { name } = v(Account, "account")
	return r.match(Account, { id: r.param("id", Account.fields.id), name }).find({ name })
})

export const accountByName = query(Work).rule((r) => {
	const { id } = v(Account, "account")
	return r.match(Account, { id, name: r.param("name", Account.fields.name) }).find({ id })
})

export const tasksOf = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r.match(Task, { id, account: r.param("account", Task.fields.account) }).find({ id })
})

export const taskCount = query(Work).rule((r) => {
	const { id } = v(Task, "task")
	return r
		.match(Task, { id, account: r.param("account", Task.fields.account) })
		.find({ tasks: r.count() })
})

const accountId = "0193d8f2-7c1e-7000-8000-0000000000a1"
const taskId = "0193d8f2-7c1e-7000-8000-0000000000a2"

export const gets = (db: DbType<typeof Reader, unknown>) => {
	const byId = db.get(accountById, { id: accountId })
	const byKey = db.get(byName, { name: "acme" })
	const byPrimary = db.get(Task, { id: taskId })
	const count = db.get(taskCount, { account: accountId })
	return { byId, byKey, byPrimary, count }
}
type Gets = ReturnType<typeof gets>
export type GetById = Expect<
	Equals<Gets["byId"], Effect.Effect<Option.Option<{ readonly name: string }>, ReadError>>
>

export type GetByKey = Expect<
	Equals<
		Gets["byKey"],
		Effect.Effect<
			Option.Option<{ readonly id: Uuid; readonly name: string; readonly tier: "Free" | "Pro" }>,
			ReadError
		>
	>
>

export type GetCount = Expect<
	Equals<Gets["count"], Effect.Effect<Option.Option<{ readonly tasks: bigint }>, ReadError>>
>

export const manyGet = (db: DbType<typeof Reader, unknown>) =>
	// @ts-expect-error -- TS2345 refusal: get needs a query proved at most one row per parameter binding
	db.get(tasksOf, { account: accountId })

export const nonKeyGet = (db: DbType<typeof Reader, unknown>) =>
	// @ts-expect-error -- TS2353: a keyed get names the key fields only
	db.get(Account, { name: "acme" })

/** 3. alternatives: each arm's key matches the parent key, and the discriminator is a closedId of the roster. */
export const badArms = () =>
	// @ts-expect-error -- TS2322 refusal: the arm's key does not match the parent key
	alternatives(Numbered, "kind", Kind, { Automatic: AutomaticTask })

export const badDiscriminator = () =>
	// @ts-expect-error -- TS2345: the discriminator is a closedId of the roster
	alternatives(Task, "title", Kind, { Automatic: AutomaticTask })

/** 4. derived: the definition's evidence keys the derived relation, here its group term; no law names one. */
export const tasksPerAccount = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ account, tasks: r.count() })
})
export const TasksPerAccount = derived("TasksPerAccount", tasksPerAccount)
/** A plain definition keeps the key its match proves (types/evidence HeadKeys): Task's id. */
export const titles = query(Work).rule((r) => {
	const { id, title } = v(Task, "task")
	return r.match(Task, { id, title }).find({ id, title })
})
export const Titles = derived("Titles", titles)
export const Reports = schema.extend(Work, { TasksPerAccount, Titles }, [])
export const Reporter = role(Reports, "reporter", Reports.relations)
export const Refresher = role(Reports, "refresher", Reports.relations, {
	refresh: ["TasksPerAccount", "Titles"]
})

export type TasksPerAccountKeys = Expect<
	Equals<KeysOf<typeof Reports, typeof TasksPerAccount>, ReadonlyArray<"account">>
>

export type TitlesKeys = Expect<
	Equals<KeysOf<typeof Reports, typeof Titles>, ReadonlyArray<"id" | "title"> | ReadonlyArray<"id">>
>

/** The retained key pins a match on the derived relation like a declared key. */
export const titleById = query(Reports).rule((r) => {
	const { title } = v(Titles, "titles")
	return r.match(Titles, { id: r.param("id", Account.fields.id), title }).find({ title })
})
export type TitleByIdCard = Expect<Equals<EvidenceOfQuery<typeof titleById>["card"], "atMostOne">>
export const derivedLaws = () => [
	// @ts-expect-error -- TS2739: key does not take a derived relation
	key(TasksPerAccount, ["account"]),
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	contained(on(TasksPerAccount, "account"), on(Account, "id"))
]

export const parameterizedDefinition = () =>
	// @ts-expect-error -- TS2345: a derived definition reads no parameter
	derived("PerAccount", tasksOf)

/** 5. apply: a ChangeSet's writes must lie in the role's write list; refresh in its refresh list. */
export const applies = (
	writer: DbType<typeof Writer, unknown>,
	reports: DbType<typeof Refresher, unknown>
) => {
	const change = ChangeSet.empty(Work).delete(Task, [
		{ id: taskId, account: accountId, kind: "Manual", title: "x" }
	])
	const applied = writer.apply(change, {})
	const refreshed = reports.refresh(TasksPerAccount, Titles)
	return { change, applied, refreshed }
}
export type ChangeWrites = Expect<Equals<WritesOf<ReturnType<typeof applies>["change"]>, "Task">>
export const outOfScope = (
	reader: DbType<typeof Reader, unknown>,
	change: ChangeSetType<typeof Work, unknown, "Task">
) =>
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
	reader.apply(change, {})

export const accountWrite = (
	writer: DbType<typeof Writer, unknown>,
	change: ChangeSetType<typeof Work, unknown, "Account">
) =>
	// @ts-expect-error -- TS2345 refusal: a ChangeSet writes only relations its role's write list names
	writer.apply(change, {})

export const refreshOutOfScope = (reporter: DbType<typeof Reporter, unknown>) =>
	// @ts-expect-error -- TS2345: the reporter refreshes nothing
	reporter.refresh(Titles)

/** 6. orderBy: fields of the heading, common to every arm of a union. */
export const payloads = query(Work)
	.rule((r) => {
		const { id } = v(Task, "task")
		const { budget } = v(AutomaticTask, "automaticTask")
		return r
			.match(Task, { id, kind: "Automatic" })
			.match(AutomaticTask, { task: id, budget })
			.find({ id, kind: Kind.handle("Automatic"), budget })
	})
	.rule((r) => {
		const { id } = v(Task, "task")
		const { operator } = v(ManualTask, "manualTask")
		return r
			.match(Task, { id, kind: "Manual" })
			.match(ManualTask, { task: id, operator })
			.find({ id, kind: Kind.handle("Manual"), operator })
	})
export const payloadsByKind = payloads.orderBy(["kind", "asc"], ["id", "desc"])
export const payloadsByBudget = () =>
	// @ts-expect-error -- TS2322: budget is not common to every arm
	payloads.orderBy(["budget", "desc"])

export const accountsByTitle = () =>
	// @ts-expect-error -- TS2322: title is not a field of the heading
	accounts.orderBy(["title", "asc"])

/** 7. mirrors and contained: the two sides pair fields of one identity, position by position. */
export const sides = [
	contained(on(Task, "account"), on(Account, "id")),
	mirrors(on(select(Task, { kind: "Automatic" }), "id"), on(AutomaticTask, "task"))
] as const

export const sideRefusals = () => [
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	contained(on(Task, "kind"), on(Tier, "id")),
	// @ts-expect-error -- TS2345 refusal: the sides' field types differ
	mirrors(on(Task, "title"), on(Account, "id"))
]

/**
 * Db.open takes a role reached through its login, which names the layer it needs: the requirement is the role's, and
 * the Db reads the role's levels, its base among them for a full role. A schema is no role, and no role is named by a
 * string.
 */
const Server = login(Work, "server", [Writer])
const ReportsServer = login(Reports, "reports", [Reporter])
export const opened = Db.open(Server.roles.writer, {})
export type Opened = Expect<
	Equals<
		typeof opened,
		Effect.Effect<DbType<typeof Writer, unknown>, OpenError, DbLayerService<typeof Writer>>
	>
>
export const openedOverExtension = Db.open(ReportsServer.roles.reporter, {})
export type OpenedOverExtension = Expect<
	Equals<
		typeof openedOverExtension,
		Effect.Effect<DbType<typeof Reporter, unknown>, OpenError, DbLayerService<typeof Reporter>>
	>
>
/** A full role's Db reads programs over its base. */
export const readsBase = (db: DbType<typeof Reporter, unknown>) => db.execute(accounts, {})
// @ts-expect-error -- TS2554: Db.open takes a role and its options
export const withoutOptions = Db.open(Server.roles.writer)
// @ts-expect-error -- TS2739: a schema is no role
export const openedSchema = Db.open(Work, {})
// @ts-expect-error -- TS2345: a role is a value, never its name
export const openedByName = Db.open("writer", {})
