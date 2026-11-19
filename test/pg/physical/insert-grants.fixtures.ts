/** What the properties of insert-grants.test.ts read: its spaces, models and helpers. */

import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Result } from "effect"
import { quoteIdent } from "#compiler/core/text.ts"
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
import type { RawSession } from "#test/support/substrate/session.ts"

/** The version under the declared name `name`. */
export const versionOf = (name: string) => {
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
	const base = schema(
		name,
		[Store, Item, Shelf, Slot, Ticket],
		[
			items,
			fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
			ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots")),
			mutable(Store),
			mutable(Item)
		]
	)
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

export type InsertGrantsBuilt = ReturnType<typeof versionOf>

const roleNames = ["appender", "editor", "filer"] as const

export type RoleName = (typeof roleNames)[number]

const tableNames = ["Store", "Item", "Shelf", "Slot", "Ticket"] as const

export type Table = (typeof tableNames)[number]

type Owner = "Store" | "Shelf"

/** How a role writes each table: by its write list or its insert list, whole or through a query entry; or not. */
type Way = "none" | "whole" | "entry"

export const ways: { readonly [R in RoleName]: { readonly [T in Table]: Way } } = {
	appender: { Store: "none", Item: "whole", Shelf: "none", Slot: "whole", Ticket: "whole" },
	editor: { Store: "none", Item: "whole", Shelf: "none", Slot: "whole", Ticket: "whole" },
	filer: { Store: "whole", Item: "none", Shelf: "none", Slot: "none", Ticket: "entry" }
}

export const inserts: { readonly [R in RoleName]: boolean } = {
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

export const keyOf: { readonly [T in Table]: string } = {
	Store: "id",
	Item: "id",
	Shelf: "id",
	Slot: "shelf",
	Ticket: "no"
}

/** The column an INSERT of no row names: the key, but a serial key's, which PostgreSQL refuses an explicit value
 * (428C9) before any privilege, so Ticket's note. */
export const insertedOf: { readonly [T in Table]: string } = {
	Store: "id",
	Item: "id",
	Shelf: "id",
	Slot: "shelf",
	Ticket: "note"
}

export const payloadOf: { readonly [T in Table]: string } = {
	Store: "label",
	Item: "qty",
	Shelf: "tag",
	Slot: "what",
	Ticket: "note"
}

export const countOf: { readonly [O in Owner]: string } = { Store: "items", Shelf: "slots" }

export const isOwner = (t: Table): t is Owner => t === "Store" || t === "Shelf"

/** A statement a probe sends, reading and writing no row. */
type Statement = "select" | "insert" | "update" | "recount" | "delete"

export interface Probe {
	readonly role: RoleName
	readonly table: Table
	readonly statement: Statement
}

/** Whether `r` holds the family columns of the owner `t`: it writes a member of `t`'s family and not `t` whole. */
export const holdsOwner = (r: RoleName, t: Table): boolean =>
	isOwner(t) && ways[r][memberOf[t]] !== "none" && ways[r][t] !== "whole"

/** The rule restated: whether `r` may send `s` on `t`. */
export const allowed = (r: RoleName, t: Table, s: Statement): boolean => {
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

export type Feature =
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
export const asRole = (session: RawSession, role: string, sql: string) =>
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

export const probesGen: Gen<Arr.NonEmptyReadonlyArray<Probe>> = (source) => [
	source.draw(probeGen),
	...source.draw(array(probeGen, { min: 0, max: 5 }))
]
