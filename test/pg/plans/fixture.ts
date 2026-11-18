import { Array as Arr, pipe, String as Str } from "effect"
import { codeOf, type RosterCodec } from "#compiler/ir/codes.ts"
import { closedId, pg, uuid, type Uuid } from "#compiler/public/fields.ts"
import { closed, key, on, relation, schema, select } from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import type { VolumeFill } from "#test/support/substrate/fill.ts"

const text = str.regex("^.*$", "su")

const Kind = closed.ordered("Kind", ["Automatic", "Manual"])
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
 * - Task(id, account, kind) and Ticket/Note(id, ticket, open), each with at most one fact of a selected source per
 *   group, `key(on(select(S, φ), f))` (fin.md §6, "at most one"), which the law model lowers to a UNIQUE over the
 *   selected side's generated law column: the selective reads a query whose discriminator stays a literal makes under
 *   generic and custom plans (R04).
 *
 * The facts are generated in SQL with fixed sizes. Every table but Item holds at most 30,000 rows: ANALYZE samples 300
 * times default_statistics_target rows, 30,000 at the default 100, so those tables' statistics are computed from all of
 * their rows and are the same on every run. Item holds 200,000 rows, so that a probe per input row is the right join
 * at any input's estimate, its arrays' length in a custom plan and the default ten in a generic one; its sampled
 * statistics do not move that plan, which rests on its primary key's uniqueness and its size, and VACUUM counts its
 * rows exactly. VACUUM also sets the visibility map an index-only scan needs. The sizes make every keyed probe far
 * cheaper than a scan, so a plan that loses an index condition shows it.
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
export const uid = (family: number, n: number): Uuid =>
	`${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-${pipe(n.toString(16), Str.padStart(12, "0"))}`

const uidSql = (family: number, n: string): string =>
	`('${pipe(family.toString(16), Str.padStart(8, "0"))}-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`

/** The physical names the installation gives each relation, and the codes its codebook gives Kind's handles. */
interface FixtureNames {
	readonly table: (relation: string) => string
	readonly kinds: RosterCodec
}

/**
 * The facts, each relation a volume fill (substrate/fill.ts) over its index `g`, sized by `sizes`. Every Automatic task
 * and every open note is the only one of its account or ticket, as the keys over the selected sides require.
 */
export const factFills = (n: FixtureNames): Arr.NonEmptyReadonlyArray<VolumeFill> => [
	{
		tables: [
			{
				table: n.table("Account"),
				columns: [
					['"id"', uidSql(1, "g")],
					['"name"', "'account ' || g"]
				]
			}
		],
		rows: sizes.accounts,
		conflicts: "refused"
	},
	{
		tables: [
			{
				table: n.table("Posting"),
				columns: [
					['"id"', uidSql(2, "g")],
					['"account"', uidSql(1, `g % ${sizes.accounts}`)],
					['"amount"', "(g % 37)::int8"]
				]
			}
		],
		rows: sizes.postings,
		conflicts: "refused"
	},
	{
		tables: [
			{
				table: n.table("Entry"),
				columns: [
					['"account"', uidSql(1, `g % ${sizes.accounts}`)],
					['"seq"', `(g / ${sizes.accounts})::int8`],
					['"amount"', "(g % 53)::int8"]
				]
			}
		],
		rows: sizes.accounts * sizes.entriesPerAccount,
		conflicts: "refused"
	},
	{
		tables: [
			{
				table: n.table("Item"),
				columns: [
					['"id"', uidSql(6, "g")],
					['"amount"', "(g % 101)::int8"]
				]
			}
		],
		rows: sizes.items,
		conflicts: "refused"
	},
	{
		tables: [
			{
				table: n.table("Task"),
				columns: [
					['"id"', uidSql(3, "g")],
					['"account"', uidSql(1, `g % ${sizes.accounts}`)],
					[
						'"kind"',
						`(CASE WHEN g < ${sizes.accounts} THEN ${codeOf(n.kinds, "Automatic")} ELSE ${codeOf(n.kinds, "Manual")} END)::smallint`
					]
				]
			}
		],
		rows: sizes.tasks,
		conflicts: "refused"
	},
	{
		tables: [{ table: n.table("Ticket"), columns: [['"id"', uidSql(4, "g")]] }],
		rows: sizes.tickets,
		conflicts: "refused"
	},
	{
		tables: [
			{
				table: n.table("Note"),
				columns: [
					['"id"', uidSql(5, "g")],
					['"ticket"', uidSql(4, `g % ${sizes.tickets}`)],
					['"open"', `g < ${sizes.tickets}`]
				]
			}
		],
		rows: sizes.notes,
		conflicts: "refused"
	}
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
