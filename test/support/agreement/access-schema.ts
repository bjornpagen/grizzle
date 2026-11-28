import { closedId, int4 } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	context,
	derived,
	login,
	on,
	relation,
	role,
	schema,
	unit
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

/**
 * The values the access agreement (test/support/agreement/access.ts) draws its worlds from, which its generated
 * program imports by name: Work, an account's tasks and its tier, whose seats a closed relation states, each in the
 * unit Entity of its id; Reports, an extension of it holding two derived relations, each stored and read in full by a
 * role that holds Account and Task whole, which no role holds; two contexts, Org, a claimed organisation's id, and Session, a token's subject; Task as a query entry
 * reading a context at every place a definition can, or none; a program over Work matching each context; and two
 * logins the DbConfig agreement (test/support/agreement/dbconfig.ts) configures, one whose role declares no context and
 * one whose role declares Session, which its Task entry reads.
 */
export const Tier = closed.ordered("Tier", ["Free", "Pro"])
const TierInfo = closed.relation(
	"TierInfo",
	{ tier: closedId(Tier), seats: int4 },
	["tier"],
	[
		{ tier: "Free", seats: 1 },
		{ tier: "Pro", seats: 5 }
	]
)
export const Account = relation(
	"Account",
	{ id: Id, name: str.regex("^[a-z]{1,32}$"), tier: closedId(Tier) },
	["id"]
)
export const Task = relation("Task", { id: Id, account: Id }, ["id"])
export const Work = schema(
	"Work",
	[Tier, TierInfo, Account, Task],
	[contained(on(Task, "account"), on(Account, "id")), unit("Entity", { id: Id })]
)

/** A program over the base reading its ordinary relations alone. */
export const accountIds = query(Work).rule((r) => {
	const { id } = v(Account, "account")
	return r.match(Account, { id }).find({ id })
})

/** A program over the base matching the closed relation's rows, which every role reads. */
export const accountSeats = query(Work).rule((r) => {
	const { id, tier } = v(Account, "account")
	const { seats } = v(TierInfo, "info")
	return r.match(Account, { id, tier }).match(TierInfo, { tier, seats }).find({ id, seats })
})

/** Each account's name, stored: a role holding Account whole reads it in full. */
export const AccountNames = derived(
	"AccountNames",
	query(Work).rule((r) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})
)
/** An account's tasks, stored as AccountNames is: no role holds it, and a role reads it through Task. */
const AccountTasks = derived(
	"AccountTasks",
	query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ id, account })
	})
)
export const Reports = schema.extend([Work], "Reports", [AccountNames, AccountTasks], [])

/** A program over the extension matching a derived relation of it, which a full role of the extension runs. */
export const accountTasks = query(Reports).rule((r) => {
	const { id, account } = v(AccountTasks, "tasks")
	return r.match(AccountTasks, { id, account }).find({ id, account })
})

export const Org = context("Org", { id: Id }, { claim: "o" })
export const Session = context("Session", { sub: str.regex("^[a-z]{1,32}$") })

/** The accounts of the claimed organisation: a query a definition imports, reading Org through it. */
const orgAccounts = query(Work).rule((r) => {
	const { id } = v(Org, "org")
	return r.match(Account, { id }).match(Org, { id }).find({ id })
})

/** Task as a query entry reading no context. */
export const taskPlain = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ id, account })
})

/** Task as a query entry matching Org. */
export const taskOrg = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).match(Org, { id: account }).find({ id, account })
})

/** Task as a query entry matching Session, through its account's name. */
export const taskSession = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	const { name } = v(Account, "account")
	return r
		.match(Task, { id, account })
		.match(Account, { id: account, name })
		.match(Session, { sub: name })
		.find({ id, account })
})

/** Task as a query entry reading Org under a negation. */
export const taskNegated = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r
		.match(Task, { id, account })
		.where(r.not(Org, { id: account }))
		.find({ id, account })
})

/** Task as a query entry reading Org in an interior stage. */
export const taskStaged = query(Work).rule((r) => {
	const stage = r.interior((inner) => {
		const { id } = v(Org, "org")
		return inner.match(Org, { id }).find({ id })
	})
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).match(stage, { id: account }).find({ id, account })
})

/** Task as a query entry reading Org through the query it imports. */
export const taskImported = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).match(orgAccounts, { id: account }).find({ id, account })
})

/** A role of Work reading no context, and the login that holds it. */
const Reader = role(Work, "reader", { Tier, Account, Task })
export const PlainLogin = login(Work, "plain", [Reader])

/** A program over the base matching Org: an account of the claimed organisation, which a role declaring Org runs. */
export const accountOrg = query(Work).rule((r) => {
	const { id } = v(Account, "account")
	return r.match(Account, { id }).match(Org, { id }).find({ id })
})

/** A program over the base matching Session: the account the token's subject names, which a role declaring Session runs. */
export const accountSession = query(Work).rule((r) => {
	const { id, name } = v(Account, "account")
	return r.match(Account, { id, name }).match(Session, { sub: name }).find({ id })
})

/** A role of Work whose Task entry reads Session, which it declares, and the login that holds it. */
const Member = role(Work, "member", { Tier, Account, Task: taskSession }, { contexts: [Session] })
export const WebLogin = login(Work, "web", [Member])
