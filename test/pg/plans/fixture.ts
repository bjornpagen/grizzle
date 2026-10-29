import { pipe, String as Str } from "effect"
import { closedId, pg, uuid } from "#compiler/public/fields.ts"
import { capacity, closed, on, relation, schema, select, within } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"

const text = str.regex("^.*$", "su")

const Kind = closed("Kind", ["Automatic", "Manual"])
export const Account = relation("Account", { id: uuid, name: text }, ["id"])
export const Posting = relation("Posting", { id: uuid, account: uuid, amount: pg.bigint }, ["id"])
export const Entry = relation("Entry", { account: uuid, seq: pg.bigint, amount: pg.bigint }, [
	"account",
	"seq"
])
export const Item = relation("Item", { id: uuid, amount: pg.bigint }, ["id"])
export const Task = relation("Task", { id: uuid, account: uuid, kind: closedId(Kind) }, ["id"])
const Ticket = relation("Ticket", { id: uuid }, ["id"])
export const Note = relation("Note", { id: uuid, ticket: uuid, open: pg.boolean }, ["id"])

/**
 * The plan-property fixture. Plan-property tests run VACUUM ANALYZE on fixtures with pinned sizes and read EXPLAIN
 * (FORMAT JSON) through the tree's one decoder (bench/harness/explain.ts).
 *
 * One schema over the public builders, installed by the fresh-install compiler under a fresh schema name:
 *
 * - Account(id, name) keyed by id;
 * - Posting(id, account, amount) keyed by id, the aggregate example of a bound variable's contribution;
 * - Entry(account, seq, amount) keyed by (account, seq), so its primary key is the `(key, order...)` B-tree a take
 *   correlated on account and ordered by seq reads (R20);
 * - Item(id, amount) keyed by id, the keyed relation a relation parameter is joined to (R22);
 * - Task(id, account, kind) and Ticket/Note(id, ticket, open), each with an upper bound of one on a selected source,
 *   `capacity(..., within(0n, 1n))`, which the law model specializes to a partial UNIQUE index:
 *   the partial indexes a query whose discriminator stays a literal must use under generic and custom plans (R04).
 *
 * The facts are generated in SQL with fixed sizes. Every table but Item holds at most 30,000 rows: ANALYZE samples 300
 * times default_statistics_target rows, 30,000 at the default 100, so those tables' statistics are computed from all of
 * their rows and are the same on every run. Item holds 200,000 rows, so that a probe per input row is the right join
 * even at the 100-row estimate PostgreSQL assumes for a jsonb_to_recordset function scan; its sampled
 * statistics do not move that plan, which rests on its primary key's uniqueness and its size, and VACUUM counts its
 * rows exactly. VACUUM also sets the visibility map an index-only scan needs. The sizes make every keyed probe far
 * cheaper than a scan, so a plan that loses an index condition shows it.
 */
export const Plans = schema("Plans", { Kind, Account, Posting, Entry, Item, Task, Ticket, Note }, [
	capacity(on(Account, "id"), {
		from: on(select(Task, { kind: "Automatic" }), "account"),
		within: within(0n, 1n)
	}),
	capacity(on(Ticket, "id"), {
		from: on(select(Note, { open: true }), "ticket"),
		within: within(0n, 1n)
	})
])

/** The pinned sizes. */
export const sizes = {
	accounts: 1000,
	postings: 30_000,
	entriesPerAccount: 30,
	items: 200_000,
	tasks: 20_000,
	tickets: 1000,
	notes: 20_000
} as const

/** A deterministic uuid: the family in the first group, the row number in the last. */
export const uid = (family: number, n: number): string =>
	`${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const uidSql = (family: number, n: string): string =>
	`('${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`

/** The physical names the installation gives each relation and the Kind enum. */
interface FixtureNames {
	readonly table: (relation: string) => string
	readonly kindType: string
}

/**
 * The facts, in SQL over generate_series, sized by `sizes`. Every Automatic task and every open note is the only one
 * of its account or ticket, as the capacity laws require.
 */
export const factSql = (n: FixtureNames): ReadonlyArray<string> => [
	`INSERT INTO ${n.table("Account")} ("id", "name") SELECT ${uidSql(1, "i")}, 'account ' || i FROM generate_series(0, ${sizes.accounts - 1}) AS i`,
	`INSERT INTO ${n.table("Posting")} ("id", "account", "amount") SELECT ${uidSql(2, "i")}, ${uidSql(1, `i % ${sizes.accounts}`)}, (i % 37)::int8 FROM generate_series(0, ${sizes.postings - 1}) AS i`,
	`INSERT INTO ${n.table("Entry")} ("account", "seq", "amount") SELECT ${uidSql(1, `i % ${sizes.accounts}`)}, (i / ${sizes.accounts})::int8, (i % 53)::int8 FROM generate_series(0, ${sizes.accounts * sizes.entriesPerAccount - 1}) AS i`,
	`INSERT INTO ${n.table("Item")} ("id", "amount") SELECT ${uidSql(6, "i")}, (i % 101)::int8 FROM generate_series(0, ${sizes.items - 1}) AS i`,
	`INSERT INTO ${n.table("Task")} ("id", "account", "kind") SELECT ${uidSql(3, "i")}, ${uidSql(1, `i % ${sizes.accounts}`)}, (CASE WHEN i < ${sizes.accounts} THEN 'Automatic' ELSE 'Manual' END)::${n.kindType} FROM generate_series(0, ${sizes.tasks - 1}) AS i`,
	`INSERT INTO ${n.table("Ticket")} ("id") SELECT ${uidSql(4, "i")} FROM generate_series(0, ${sizes.tickets - 1}) AS i`,
	`INSERT INTO ${n.table("Note")} ("id", "ticket", "open") SELECT ${uidSql(5, "i")}, ${uidSql(4, `i % ${sizes.tickets}`)}, i < ${sizes.tickets} FROM generate_series(0, ${sizes.notes - 1}) AS i`
]

export const relationNames = [
	"Account",
	"Posting",
	"Entry",
	"Item",
	"Task",
	"Ticket",
	"Note"
] as const
