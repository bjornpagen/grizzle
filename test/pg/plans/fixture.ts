import { closedId, pg } from "#compiler/public/fields.ts"
import { closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { Id } from "#test/support/ids.ts"

const text = str.regex("^.*$", "su")

const Kind = closed.ordered("Kind", ["Automatic", "Manual"])
const Account = relation("Account", { id: Id, name: text }, ["id"])
const Posting = relation("Posting", { id: Id, account: Id, amount: pg.bigint }, ["id"])
const Entry = relation("Entry", { account: Id, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])
const Item = relation("Item", { id: Id, amount: pg.bigint }, ["id"])
export const Task = relation("Task", { id: Id, account: Id, kind: closedId(Kind) }, ["id"])
const Ticket = relation("Ticket", { id: Id }, ["id"])
export const Note = relation("Note", { id: Id, ticket: Id, open: pg.boolean }, ["id"])

/**
 * The plans schema, over the public builders, whose selection keys test/unit/lower/selection-key.fixtures.ts compiles:
 *
 * - Account(id, name) keyed by id;
 * - Posting(id, account, amount) keyed by id;
 * - Entry(account, seq, amount) keyed by (account, seq);
 * - Item(id, amount) keyed by id;
 * - Task(id, account, kind) and Ticket/Note(id, ticket, open), each with at most one fact of a selected source per
 *   group, `key(on(select(S, φ), f))` (fin.md §6, "at most one"), which the law model lowers to a UNIQUE over the
 *   selected side's generated law column.
 */
export const Plans = schema(
	"Plans",
	[Kind, Account, Posting, Entry, Item, Task, Ticket, Note],
	[
		key(
			on(
				select(Task, (x) => x.eq(x.kind, "Automatic")),
				"account"
			)
		),
		key(
			on(
				select(Note, (x) => x.eq(x.open, true)),
				"ticket"
			)
		)
	]
)
