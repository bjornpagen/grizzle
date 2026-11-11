/**
 * A direct writer through a role that writes by its insert list, on PostgreSQL 19 (physical/ddl/roles.ts
 * grantedPrivileges): the role holds SELECT and INSERT on what it writes and no UPDATE or DELETE anywhere, so its
 * UPDATE or DELETE of any table is refused with 42501, beside a role that states `write` over the same entries.
 *
 * The schema: Stores own a counted family of Items, which add their quantities into their store's stock, both mutable;
 * Shelves (immutable) own an ordered family of Slots; Tickets stand alone. Roles: `appender` inserts into Item, Slot
 * and Ticket, each whole; `editor` writes the same entries by its write list, the control; `filer` inserts into Store
 * whole, a mutable table, and into Ticket through AllTickets, a query entry holding every row.
 *
 * A case draws probes, each a role and a statement on a table, sent under the role (SET LOCAL ROLE in the owner's
 * session, rolled back), each reading and writing no row, so PostgreSQL judges its privileges alone: a SELECT of the
 * key, an INSERT of the key from no row, an UPDATE of a payload field or of an owner's count to itself, and a DELETE,
 * each WHERE false. The oracle is the rule restated: a role selects what it writes and the family columns of an owner
 * whose member it writes; inserts into what it writes; and, by its write list alone, deletes from what it writes and
 * updates a mutable table it writes whole, or a mutable owner's count whose member it writes. A statement the rule
 * refuses is refused with 42501, and every other returns no row.
 *
 * Features: each role's probes of each statement kind, admitted and refused.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): insert-grants-delete (a role that writes by its insert list holds
 * DELETE on what it writes).
 */
import { layer } from "@effect/vitest"
import { drawn as drawnCase, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import { Array as Arr, Effect, Formatter, Option, Result } from "effect"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	counted,
	fin,
	fold,
	login,
	Monoid,
	mutable,
	on,
	ordered,
	relation,
	role,
	schema
} from "#compiler/public/schema.ts"
import { str } from "#compiler/public/text.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/** The version under the declared name `name`. */
const versionOf = (name: string) => {
	const word = str.regex("^[a-z]{1,8}$")
	const Store = relation(
		"Store",
		{ id: uuid, label: word, items: drawn(natural), stock: accumulated(pg.bigint, 0n) },
		["id"]
	)
	const Item = relation("Item", { id: uuid, store: uuid, qty: pg.bigint }, ["id"])
	const Shelf = relation("Shelf", { id: uuid, tag: word, slots: drawn(natural) }, ["id"])
	const Slot = relation("Slot", { shelf: uuid, at: drawn(natural), what: word }, ["shelf", "at"])
	const Ticket = relation("Ticket", { no: pg.bigserial, note: word }, ["no"])
	const items = counted(on(Item, "store"), fin(Store, "items"))
	const base = schema(name, { Store, Item, Shelf, Slot, Ticket }, [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots")),
		mutable(Store),
		mutable(Item)
	])
	const allTickets = query(base).rule((r) => {
		const { no, note } = v(Ticket, "ticket")
		return r.match(Ticket, { no, note }).find({ no, note })
	})
	const appender = role(
		base,
		"appender",
		{ Item, Slot, Ticket },
		{ insert: ["Item", "Slot", "Ticket"] }
	)
	const editor = role(base, "editor", { Item, Slot, Ticket }, { write: ["Item", "Slot", "Ticket"] })
	const filer = role(
		base,
		"filer",
		{ Store, AllTickets: allTickets },
		{ insert: ["Store", "AllTickets"] }
	)
	return {
		schema: base,
		relations: { Store, Item, Shelf, Slot, Ticket },
		login: login(base, "desk", [appender, editor, filer])
	}
}

type Built = ReturnType<typeof versionOf>

const roleNames = ["appender", "editor", "filer"] as const
type RoleName = (typeof roleNames)[number]
const tableNames = ["Store", "Item", "Shelf", "Slot", "Ticket"] as const
type Table = (typeof tableNames)[number]
type Owner = "Store" | "Shelf"

/** How a role writes each table: by its write list or its insert list, whole or through a query entry; or not. */
type Way = "none" | "whole" | "entry"

const ways: { readonly [R in RoleName]: { readonly [T in Table]: Way } } = {
	appender: { Store: "none", Item: "whole", Shelf: "none", Slot: "whole", Ticket: "whole" },
	editor: { Store: "none", Item: "whole", Shelf: "none", Slot: "whole", Ticket: "whole" },
	filer: { Store: "whole", Item: "none", Shelf: "none", Slot: "none", Ticket: "entry" }
}
const inserts: { readonly [R in RoleName]: boolean } = {
	appender: true,
	editor: false,
	filer: true
}
const mutables: { readonly [T in Table]: boolean } = {
	Store: true,
	Item: true,
	Shelf: false,
	Slot: false,
	Ticket: false
}
const memberOf: { readonly [O in Owner]: Table } = { Store: "Item", Shelf: "Slot" }
const keyOf: { readonly [T in Table]: string } = {
	Store: "id",
	Item: "id",
	Shelf: "id",
	Slot: "shelf",
	Ticket: "no"
}
/** The column an INSERT of no row names: the key, but a serial key's, which PostgreSQL refuses an explicit value
 * (428C9) before any privilege, so Ticket's note. */
const insertedOf: { readonly [T in Table]: string } = {
	Store: "id",
	Item: "id",
	Shelf: "id",
	Slot: "shelf",
	Ticket: "note"
}
const payloadOf: { readonly [T in Table]: string } = {
	Store: "label",
	Item: "qty",
	Shelf: "tag",
	Slot: "what",
	Ticket: "note"
}
const countOf: { readonly [O in Owner]: string } = { Store: "items", Shelf: "slots" }

const isOwner = (t: Table): t is Owner => t === "Store" || t === "Shelf"

/** A statement a probe sends, reading and writing no row. */
type Statement = "select" | "insert" | "update" | "recount" | "delete"

interface Probe {
	readonly role: RoleName
	readonly table: Table
	readonly statement: Statement
}

/** Whether `r` holds the family columns of the owner `t`: it writes a member of `t`'s family and not `t` whole. */
const holdsOwner = (r: RoleName, t: Table): boolean =>
	isOwner(t) && ways[r][memberOf[t]] !== "none" && ways[r][t] !== "whole"

/** The rule restated: whether `r` may send `s` on `t`. */
const allowed = (r: RoleName, t: Table, s: Statement): boolean => {
	const writes = ways[r][t] !== "none"
	const byWrite = !inserts[r]
	switch (s) {
		case "select":
			return writes || holdsOwner(r, t)
		case "insert":
			return writes
		case "delete":
			return writes && byWrite
		case "update":
			return ways[r][t] === "whole" && byWrite && mutables[t]
		case "recount":
			return (ways[r][t] === "whole" || holdsOwner(r, t)) && byWrite && mutables[t]
	}
}

type Feature =
	| "an insert role refused an UPDATE"
	| "an insert role refused a DELETE"
	| "an insert role refused a recount"
	| "an insert role inserts"
	| "an insert role selects an owner's family columns"
	| "the write role updates"
	| "the write role deletes"
	| "the write role recounts"
	| "a role refused a table it does not hold"

/** Takes on `role` for one transaction in the owner's session, sends `sql` and rolls back: its row count, or the
 * SQLSTATE it was refused with. */
const asRole = (session: RawSession, role: string, sql: string) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(`SET LOCAL ROLE ${quoteIdent(role)}`, [])
		const outcome = yield* Effect.result(session.values(sql, []))
		yield* session.rollback
		return Result.match(outcome, {
			onSuccess: (rows): { readonly rows: number } | { readonly refused: string } => ({
				rows: rows.length
			}),
			onFailure: (error) => ({
				refused:
					error.reason._tag === "ServerError" ? error.reason.fields.code : error.reason.message
			})
		})
	})

const probeGen: Gen<Probe> = (source) => {
	const table = source.draw(element(tableNames))
	return {
		role: source.draw(element(roleNames)),
		table,
		statement: source.draw(
			element(
				isOwner(table)
					? (["select", "insert", "update", "recount", "delete"] as const)
					: (["select", "insert", "update", "delete"] as const)
			)
		)
	}
}

const probesGen: Gen<Arr.NonEmptyReadonlyArray<Probe>> = (source) => [
	source.draw(probeGen),
	...source.draw(array(probeGen, { min: 0, max: 5 }))
]

layer(Substrate.layer)("a direct writer through an insert role", (it) => {
	it.effect(
		"is refused every UPDATE and DELETE, where the write role is refused only what it lacks",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					let built: Built | undefined
					const m = yield* migrated({
						label: "insert_grants",
						schemaName: { kind: "unique" },
						first: (name: string): Version => {
							built = versionOf(name)
							return { schema: built.schema, logins: [built.login] }
						},
						later: [],
						apply: { kind: "noPlaceholders" },
						declared: () => noDeclarations,
						observe: Option.none()
					})
					const b = defined(built, "the version")
					const names = namesOf(m)
					const tableOf = (t: Table): string => names.table(b.relations[t])
					const column = (t: Table, field: string): string =>
						quoteIdent(names.columnIdent({ name: t }, field))
					const roleOf = (r: RoleName): string =>
						defined(
							Arr.findFirst(
								Arr.flatMap(m.installation.worlds, (l) => l.roles),
								(x) => x.name === r
							).pipe(Option.getOrUndefined),
							`the role ${r}`
						).role
					const sqlOf = (p: Probe): string => {
						const table = tableOf(p.table)
						const key = column(p.table, keyOf[p.table])
						switch (p.statement) {
							case "select":
								return `SELECT ${key} FROM ${table} WHERE false`
							case "insert": {
								const inserted = column(p.table, insertedOf[p.table])
								return `INSERT INTO ${table} (${inserted}) SELECT ${inserted} FROM ${table} WHERE false`
							}
							case "update": {
								const payload = column(p.table, payloadOf[p.table])
								return `UPDATE ${table} SET ${payload} = ${payload} WHERE false`
							}
							case "recount": {
								const count = column(p.table, isOwner(p.table) ? countOf[p.table] : keyOf[p.table])
								return `UPDATE ${table} SET ${count} = ${count} WHERE false`
							}
							case "delete":
								return `DELETE FROM ${table} WHERE false`
						}
					}
					const owner = yield* substrate.session({
						...ownerSession(),
						label: "insert grants owner"
					})
					return yield* explore(
						{
							suite: "physical/insert-grants",
							draw: drawnCase(probesGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the insert list's rule: SELECT and INSERT on what it writes, never UPDATE or DELETE"
							},
							coverage: required<Feature>(
								[
									"an insert role refused an UPDATE",
									"an insert role refused a DELETE",
									"an insert role refused a recount",
									"an insert role inserts",
									"an insert role selects an owner's family columns",
									"the write role updates",
									"the write role deletes",
									"the write role recounts",
									"a role refused a table it does not hold"
								],
								{ cases: 64, sense: notesOnly }
							),
							kept: [],
							runs: 48,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(probes, c) =>
							Effect.gen(function* () {
								for (const p of probes) {
									const sql = sqlOf(p)
									const got = yield* asRole(owner, roleOf(p.role), sql)
									const may = allowed(p.role, p.table, p.statement)
									assert.deepEqual(
										got,
										may ? { rows: 0 } : { refused: "42501" },
										`${p.role} ${may ? "may send" : "is refused"}: ${sql}`
									)
									const holds = ways[p.role][p.table] !== "none" || holdsOwner(p.role, p.table)
									if (!holds) {
										c.note("a role refused a table it does not hold")
									} else if (inserts[p.role]) {
										if (p.statement === "update") {
											c.note("an insert role refused an UPDATE")
										} else if (p.statement === "delete") {
											c.note("an insert role refused a DELETE")
										} else if (p.statement === "recount") {
											c.note("an insert role refused a recount")
										} else if (p.statement === "insert" && may) {
											c.note("an insert role inserts")
										} else if (p.statement === "select" && holdsOwner(p.role, p.table)) {
											c.note("an insert role selects an owner's family columns")
										}
									} else if (may && p.statement === "update") {
										c.note("the write role updates")
									} else if (may && p.statement === "delete") {
										c.note("the write role deletes")
									} else if (may && p.statement === "recount") {
										c.note("the write role recounts")
									}
								}
							})
					)
				})
			)
	)
})
