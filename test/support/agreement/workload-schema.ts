import { ChangeSet } from "#compiler/public/changeset.ts"
import { closedId, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	contained,
	derived,
	key,
	on,
	relation,
	role,
	schema,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The values the workload agreement (test/support/agreement/workloads.ts) draws its workloads from, which its generated
 * program imports by name: Work, with a candidate key and a containment; Reports, an extension of it holding a derived
 * relation; Other and Twin, schemas of which neither is a level of Work, Twin of its name; Work's worlds, a writer of
 * every ordinary relation, a reader of every relation that writes none, and a clerk holding Account alone; and every
 * kind of program over each of them: queries, ordered queries, ChangeSets and keys.
 */
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Account = relation("Account", { id: uuid, name: str.regex("^[a-z]{1,32}$") }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const byName = key(on(Account, "name"))
export const Work = schema("Work", { Kind, Account, Task }, [
	contained(on(Task, "account"), on(Account, "id")),
	byName
])

export const Tally = derived(
	"Tally",
	query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ account, tasks: r.count() })
	})
)
export const Reports = schema.extend(Work, { Tally }, [])
export const Thing = relation("Thing", { id: uuid }, ["id"])
export const Other = schema("Other", { Thing }, [])
const Twin = schema("Work", { Account }, [])

export const Writer = role(Work, "writer", wholeEntriesOf(Work), { write: writableNamesOf(Work) })
export const Reader = role(Work, "reader", wholeEntriesOf(Work))
export const Clerk = role(Work, "clerk", { Account })

export const tasks = query(Work).rule((r) => {
	const { id, account } = v(Task, "task")
	return r.match(Task, { id, account }).find({ id, account })
})
export const newestTasks = tasks.orderBy(["id", "desc"])
export const tallies = query(Reports).rule((r) => {
	const { account, tasks: count } = v(Tally, "tally")
	return r.match(Tally, { account, tasks: count }).find({ account, count })
})
export const things = query(Other).rule((r) => {
	const { id } = v(Thing, "thing")
	return r.match(Thing, { id }).find({ id })
})
export const twins = query(Twin).rule((r) => {
	const { id } = v(Twin.relations.Account, "account")
	return r.match(Twin.relations.Account, { id }).find({ id })
})
export const writerTasks = query(Writer).rule((r) => {
	const { id } = v(Writer.relations.Task, "task")
	return r.match(Writer.relations.Task, { id }).find({ id })
})
export const clerkAccounts = query(Clerk).rule((r) => {
	const { id, name } = v(Clerk.relations.Account, "account")
	return r.match(Clerk.relations.Account, { id, name }).find({ id, name })
})
export const clerkNewest = clerkAccounts.orderBy(["name", "asc"])
export const addTask = ChangeSet.empty(Work).insert(Task, [])
export const addTaskAbove = ChangeSet.empty(Reports).insert(Task, [])
export const addThing = ChangeSet.empty(Other).insert(Thing, [])
export const clerkAccount = Clerk.relations.Account
