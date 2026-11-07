import { uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
	context,
	derived,
	login,
	on,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The values the access agreement (test/support/agreement/access.ts) draws its worlds from, which its generated
 * program imports by name: Work, an account's tasks; Reports, an extension of it holding two derived relations a role
 * may refresh; two contexts, Org, a claimed organisation's id, and Session, a token's subject; Task as a query entry
 * reading a context at every place a definition can, or none; and two logins the DbConfig agreement
 * (test/support/agreement/dbconfig.ts) configures, one whose role reads no context and one whose role reads Session.
 */
export const Account = relation("Account", { id: uuid, name: str.regex("^[a-z]{1,32}$") }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid }, ["id"])
export const Work = schema("Work", { Account, Task }, [
	contained(on(Task, "account"), on(Account, "id"))
])

export const TaskTally = derived(
	"TaskTally",
	query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ account, tasks: r.count() })
	})
)
export const AccountNames = derived(
	"AccountNames",
	query(Work).rule((r) => {
		const { id, name } = v(Account, "account")
		return r.match(Account, { id, name }).find({ id, name })
	})
)
export const Reports = schema.extend(Work, { TaskTally, AccountNames }, [])

export const Org = context("Org", { id: uuid }, { claim: "o" })
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
const Reader = role(Work, "reader", { Account, Task })
export const PlainLogin = login(Work, "plain", [Reader])

/** A role of Work whose Task entry reads Session, and the login that holds it. */
const Member = role(Work, "member", { Account, Task: taskSession })
export const WebLogin = login(Work, "web", [Member])
