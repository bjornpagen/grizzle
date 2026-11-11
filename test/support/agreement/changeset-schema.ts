import { Compute } from "#compiler/public/compute.ts"
import {
	accumulated,
	bits,
	closedId,
	contract,
	drawn,
	generated,
	natural,
	pg,
	uuid
} from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	closed,
	counted,
	derived,
	fin,
	fold,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema,
	tree,
	wholeEntriesOf,
	writableNamesOf
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

/**
 * The schemas the ChangeSet type/engine agreement draws its cases over (test/support/agreement/changesets.ts): Work,
 * whose relations a ChangeSet writes (a closed roster's id, a set, texts of two patterns, a contract, serial fields, plain bigint and money
 * for exact arithmetic, and families: ordered families whose members sum into their owners, counted families whose counts fold
 * into their owners and whose members have a generated field, each over an immutable and a mutable owner, and a tree),
 * an extension of it, a level above it, and two schemas of which neither is a level of Work, one of its name; and
 * Work's worlds.
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
/** A relation every field of which its caller writes, a closed id, a set and two texts of different patterns among them. */
export const Flag = closed("Flag", ["on", "off"])
export const Tag = relation(
	"Tag",
	{
		id: uuid,
		kind: closedId(Kind),
		flags: bits(Flag),
		answer: str.regex("^(yes|no)$"),
		grade: str.regex("^(pass|fail)$")
	},
	["id"]
)

/** An ordered family's owner: its drawn count, and the total its members' quantities sum into. */
const ownerFields = { id: uuid, n: drawn(natural), total: accumulated(pg.bigint, 0n) } as const
/** An ordered family's member, keyed by its owner and its drawn index, with its sum's accumulator pair. */
const sequenceFields = {
	owner: uuid,
	at: drawn(natural),
	qty: pg.bigint,
	before: accumulated(pg.bigint, 0n),
	after: accumulated(pg.bigint, 0n)
} as const
/** A counted family's owner: its drawn count, and the size its count folds into. */
const poolFields = { id: uuid, k: drawn(natural), size: accumulated(natural, 0n) } as const

/** Ordered families over an immutable owner, Order, and a mutable one, Cart. */
export const Order = relation("Order", ownerFields, ["id"])
export const Line = relation("Line", sequenceFields, ["owner", "at"])
export const Cart = relation("Cart", ownerFields, ["id"])
export const Entry = relation("Entry", sequenceFields, ["owner", "at"])
const lines = ordered(on(Line, "owner", "at"), fin(Order, "n"))
const entries = ordered(on(Entry, "owner", "at"), fin(Cart, "n"))

/**
 * Counted families over an immutable owner, Pool, and a mutable one, Bin, each member with a field PostgreSQL
 * generates from its value.
 */
export const Pool = relation("Pool", poolFields, ["id"])
export const Bin = relation("Bin", poolFields, ["id"])
export const Item = relation.generated(
	"Item",
	{ owner: uuid, v: pg.bigint },
	["owner", "v"],
	(r) => ({
		next: generated(
			pg.bigint,
			Compute.when(
				Compute.within(Compute.add(r.v, 1n), -9223372036854775808n, 9223372036854775807n),
				(g) => Compute.cast(g, pg.bigint),
				r.v
			)
		)
	})
)
export const Chip = relation.generated(
	"Chip",
	{ owner: uuid, v: pg.bigint },
	["owner", "v"],
	(r) => ({
		next: generated(
			pg.bigint,
			Compute.when(
				Compute.within(Compute.add(r.v, 1n), -9223372036854775808n, 9223372036854775807n),
				(g) => Compute.cast(g, pg.bigint),
				r.v
			)
		)
	})
)
const items = counted(on(Item, "owner"), fin(Pool, "k"))
const chips = counted(on(Chip, "owner"), fin(Bin, "k"))

/** A document's nodes, a tree: each row's drawn index, children, start and end, its root field doc its tree's. */
export const Node = relation(
	"Node",
	{
		id: uuid,
		parent: uuid,
		at: drawn(natural),
		children: drawn(natural),
		start: drawn(natural),
		end: drawn(natural),
		doc: uuid,
		label: pg.integer
	},
	["id"]
)

export const Work = schema(
	"Work",
	[
		Kind,
		Flag,
		Task,
		Budget,
		Ticket,
		Pair,
		Ledger,
		Tag,
		Order,
		Line,
		Cart,
		Entry,
		Pool,
		Item,
		Bin,
		Chip,
		Node
	],
	[
		lines,
		fold(lines, Monoid.sum, on(Line, "owner", "qty", "before", "after"), on(Order, "id", "total")),
		entries,
		fold(
			entries,
			Monoid.sum,
			on(Entry, "owner", "qty", "before", "after"),
			on(Cart, "id", "total")
		),
		items,
		fold(items, Monoid.count, on(Item, "owner"), on(Pool, "id", "size")),
		chips,
		fold(chips, Monoid.count, on(Chip, "owner"), on(Bin, "id", "size")),
		tree(on(Node, "parent", "at"), fin(Node, "children"), { root: "doc" }),
		mutable(Cart),
		mutable(Bin)
	]
)

/** An extension of Work, a level above it, and two schemas of which neither is a level of Work, one of its name. */
export const TaskCount = derived.materialized(
	"TaskCount",
	query(Work).rule((r) => {
		const { id, account } = v(Task, "task")
		return r.match(Task, { id, account }).find({ account, tasks: r.count() })
	})
)
export const Reports = schema.extend(Work, "Reports", [TaskCount], [])
const Note = relation("Note", { id: uuid }, ["id"])
export const Other = schema("Other", [Note], [])
export const Twin = schema("Work", [Kind, Task], [])

/**
 * Work's worlds: a writer of every ordinary relation; a clerk of Task, Budget and the families' owners, whose write list
 * leaves out every member relation an owner's insert nests or edits; and a reader that writes none.
 */
export const Writer = role(Work, "writer", wholeEntriesOf(Work), { write: writableNamesOf(Work) })
export const Clerk = role(Work, "clerk", wholeEntriesOf(Work), {
	write: ["Task", "Budget", "Order", "Cart", "Pool", "Bin"]
})
export const Reader = role(Work, "reader", wholeEntriesOf(Work))
