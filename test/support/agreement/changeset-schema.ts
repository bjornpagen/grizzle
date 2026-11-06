import { closedId, contract, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import { closed, derived, relation, role, schema } from "#compiler/public/schema.ts"

/**
 * The schemas the ChangeSet type/engine agreement draws its cases over (test/support/agreement/changesets.ts): Work,
 * whose relations a ChangeSet writes (a closed roster's id, a contract, serial fields, plain bigint and money for exact
 * arithmetic), an extension of it, a level above it, and two schemas of which neither is a level of Work, one of its
 * name; and Work's worlds, a writer of every ordinary relation and a reader that writes none.
 */
export const Cents = contract("Cents", pg.bigint, (x) => x.ge(0n))
export const Kind = closed("Kind", ["Automatic", "Manual"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
export const Budget = relation("Budget", { task: uuid, cents: Cents }, ["task"])
export const Ticket = relation("Ticket", { id: pg.bigserial, account: uuid, amount: Cents }, ["id"])
export const Pair = relation("Pair", { a: pg.bigserial, b: pg.serial, note: uuid }, ["a"])
export const Ledger = relation("Ledger", { id: pg.bigint, balance: pg.bigint, fee: pg.money }, [
	"id"
])
export const Work = schema("Work", { Kind, Task, Budget, Ticket, Pair, Ledger }, [])

/** An extension of Work, a level above it, and two schemas of which neither is a level of Work, one of its name. */
const TaskCount = derived(
	"TaskCount",
	query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ account, tasks: r.count() })
	})
)
export const Reports = schema.extend(Work, { TaskCount }, [])
const Note = relation("Note", { id: uuid }, ["id"])
export const Other = schema("Other", { Note }, [])
export const Twin = schema("Work", { Kind, Task }, [])

/** Work's worlds: a writer of every ordinary relation, and a reader that writes none. */
export const Writer = role(Work, "writer", Work.relations, {
	write: ["Task", "Budget", "Ticket", "Pair", "Ledger"]
})
export const Reader = role(Work, "reader", Work.relations)
