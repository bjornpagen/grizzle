/** What the properties of family-grants.test.ts read: the version, its templates, the spaces and the holds. */

import { array, element, type Gen, int, oneOf, subarray } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, Record, Result, String as Str } from "effect"

import { quoteIdent } from "#compiler/core/text.ts"
import { accumulated, drawn, natural, pg, type Uuid } from "#compiler/public/fields.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	contained,
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
import { nonEmpty } from "#test/support/assert.ts"
import { Id } from "#test/support/ids.ts"
import { migratedOnceTemplate } from "#test/support/installed.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { upTo } from "#test/support/up-to.ts"

/** The uuid of the `n`th key of a kind: stores 0x0, items 0xa0 and shelves 0xb0. */
export const uuidAt = (base: number, n: number): Uuid =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")((base + n).toString(16))}`

/** The first store, which picker's filter names. */
export const S1 = uuidAt(0, 1)

/** The version under the declared name `name`. */
export const versionOf = (name: string) => {
	const word = str.regex("^[a-z]{1,8}$")
	const Store = relation(
		"Store",
		{
			id: Id,
			region: word,
			label: word,
			items: drawn(natural),
			stock: accumulated(pg.bigint, 0n)
		},
		["id"]
	)
	const Item = relation("Item", { id: Id, store: Id, region: word, qty: pg.bigint }, ["id"])
	const Shelf = relation("Shelf", { id: Id, tag: word, slots: drawn(natural) }, ["id"])
	const Slot = relation("Slot", { shelf: Id, at: drawn(natural), what: word }, ["shelf", "at"])
	const items = counted(on(Item, "store"), fin(Store, "items"))
	const base = schema(
		name,
		[Store, Item, Shelf, Slot],
		[
			items,
			fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
			contained(on(Item, "store", "region"), on(Store, "id", "region")),
			ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots")),
			mutable(Store),
			mutable(Item)
		]
	)
	const north = query(base).rule((r) => {
		const { id, label, items: n, stock } = v(Store, "store")
		return r
			.match(Store, { id, region: "north", label, items: n, stock })
			.find({ id, label, items: n, stock })
	})
	const first = query(base).rule((r) => {
		const { id, region, qty } = v(Item, "item")
		return r.match(Item, { id, store: S1, region, qty }).find({ id, region, qty })
	})
	const manager = role(base, "manager", { NorthStores: north }, { write: ["NorthStores"] })
	const stocker = role(base, "stocker", { Item }, { write: ["Item"] })
	const picker = role(base, "picker", { FirstItems: first }, { write: ["FirstItems"] })
	const shelver = role(base, "shelver", { Slot }, { write: ["Slot"] })
	return {
		schema: base,
		Store,
		Item,
		Shelf,
		Slot,
		stocker,
		manager,
		login: login(base, "desk", [manager, stocker, picker, shelver])
	}
}

export type RoleName = "manager" | "stocker" | "picker" | "shelver"
export type Owner = "Store" | "Shelf"

/** Takes on `role` for one transaction in the owner's session, sends `sql` and rolls back: its rows' first column as
 * text, sorted, or the SQLSTATE it was refused with. */
export const asRole = (session: RawSession, role: string, sql: string) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(`SET LOCAL ROLE ${quoteIdent(role)}`, [])
		const outcome = yield* Effect.result(session.values(sql, []))
		yield* session.rollback
		return Result.match(outcome, {
			onSuccess: (
				rows
			): { readonly rows: ReadonlyArray<string> } | { readonly refused: string } => ({
				rows: Arr.sort(
					Arr.map(rows, (row) => String(row[0])),
					Order.String
				)
			}),
			onFailure: (error) => ({
				refused:
					error.reason._tag === "ServerError" ? error.reason.fields.code : error.reason.message
			})
		})
	})

/** A store as a case draws it: its key, its region and its label. */
export interface StoreRow {
	readonly id: Uuid
	readonly region: "north" | "south"
	readonly label: string
}

/** A statement a probe sends on an owner: a field selected or updated to itself, an insertion or a deletion. */
export type Statement =
	| Readonly<{ kind: "select"; field: string }>
	| Readonly<{ kind: "update"; field: string }>
	| Readonly<{ kind: "insert" }>
	| Readonly<{ kind: "delete" }>

export interface Probe {
	readonly role: RoleName
	readonly owner: Owner
	readonly statement: Statement
}

/** A case: the stores and shelves the owner writes, and the probes the roles send. */
export interface Grants {
	readonly stores: ReadonlyArray<StoreRow>
	readonly shelves: ReadonlyArray<Uuid>
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/** What a role holds of an owner, by the rule: the fields it may select and update, and the owners it admits. */
export interface Hold {
	readonly select: ReadonlySet<string>
	readonly update: ReadonlySet<string>
	readonly admits: (store: StoreRow) => boolean
}

/** A member writer's hold on Store, mutable: its key, count, end and copy to select, its count and end to update. */
const memberOfStore = (admits: (store: StoreRow) => boolean): Hold => ({
	select: new Set(["id", "region", "items", "stock"]),
	update: new Set(["items", "stock"]),
	admits
})

/** The rule's hold of a role on an owner; none where the role writes no member of the owner's family. */
export const holdOf = (role: RoleName, owner: Owner): Option.Option<Hold> => {
	switch (role) {
		case "stocker":
			return owner === "Store" ? Option.some(memberOfStore(() => true)) : Option.none()
		case "picker":
			return owner === "Store" ? Option.some(memberOfStore((s) => s.id === S1)) : Option.none()
		case "shelver":
			return owner === "Shelf"
				? Option.some({ select: new Set(["id", "slots"]), update: new Set(), admits: () => true })
				: Option.none()
		case "manager":
			return owner === "Store"
				? Option.some({
						select: new Set(["id"]),
						update: new Set(),
						admits: (s) => s.region === "north"
					})
				: Option.none()
	}
}

export type GrantsFeature =
	| "a member writer selects a column it holds"
	| "a member writer is refused a column it lacks"
	| "a member writer updates its count or end"
	| "a member writer is refused an update"
	| "an insertion or a deletion refused"
	| "picker admits the first store alone"
	| "manager admits the north stores"
	| "a role reaches no owner outside its family"
	| "the immutable owner's count is never updated"

/** One Item as stocker writes it. */
export interface ItemFact {
	readonly id: Uuid
	readonly store: Uuid
	readonly region: "north" | "south"
	readonly qty: bigint
}

/** A write stocker sends through its Db: an Item appended, a quantity put, or an Item deleted; or manager's put of a
 * store's label through NorthStores, its query entry over the north stores. */
export type ItemWrite =
	| Readonly<{ kind: "insert"; store: number; qty: number }>
	| Readonly<{ kind: "put"; item: number; qty: number }>
	| Readonly<{ kind: "delete"; item: number }>
	| Readonly<{ kind: "label"; store: number; label: "a" | "b" }>

export interface Apply {
	readonly stores: Arr.NonEmptyReadonlyArray<StoreRow>
	readonly writes: Arr.NonEmptyReadonlyArray<ItemWrite>
}

export type ApplyFeature =
	| "an append"
	| "a put of a quantity"
	| "a deletion"
	| "items of two stores"
	| "a north store's label put through NorthStores"
	| "a south store's label refused through NorthStores"

const regionGen: Gen<"north" | "south"> = element(["north", "south"] as const)

/** Stores of a subset of four keys, the first store's among them or not. */
const storesGen: Gen<ReadonlyArray<StoreRow>> = (source) =>
	Arr.map(source.draw(subarray(Arr.range(1, 4))), (n) => ({
		id: uuidAt(0, n),
		region: source.draw(regionGen),
		label: source.draw(element(["a", "b"] as const))
	}))

const statementGen = (fields: Arr.NonEmptyReadonlyArray<string>): Gen<Statement> =>
	oneOf<Statement>([
		(source) => ({ kind: "select", field: source.draw(element(fields)) }),
		(source) => ({ kind: "update", field: source.draw(element(fields)) }),
		(source) => ({ kind: source.draw(element(["insert", "delete"] as const)) })
	])

const roleNames = ["manager", "stocker", "picker", "shelver"] as const

/** The item an index of a write names among those held, if any is. */
export const heldAt = (held: ReadonlyArray<ItemFact>, at: number): Option.Option<ItemFact> =>
	Arr.isReadonlyArrayNonEmpty(held) ? Arr.get(held, at % held.length) : Option.none()

/** The version under its declared name: the owners' fields a probe draws, which no installation's name moves. */
const declared = versionOf("FamilyGrants")

/** Each owner's fields, as the probes draw them. */
const fieldsOf: { readonly [O in Owner]: Arr.NonEmptyReadonlyArray<string> } = {
	Store: nonEmpty(Record.keys(declared.Store.fields), "Store's fields"),
	Shelf: nonEmpty(Record.keys(declared.Shelf.fields), "Shelf's fields")
}

const probeGen: Gen<Probe> = (source) => {
	const role = source.draw(element(roleNames))
	const on = source.draw(element(["Store", "Shelf"] as const))
	return {
		role,
		owner: on,
		statement:
			role === "manager" && on === "Store"
				? { kind: "select", field: "id" }
				: source.draw(statementGen(fieldsOf[on]))
	}
}
export const grantsGen: Gen<Grants> = (source) => ({
	stores: source.draw(storesGen),
	shelves: Arr.map(source.draw(subarray(Arr.range(1, 2))), (n) => uuidAt(0xb0, n)),
	probes: [source.draw(probeGen), ...source.draw(array(probeGen, { min: 0, max: 3 }))]
})

export const applyGen: Gen<Apply> = (source) => {
	const stores = nonEmpty(
		Arr.map(
			upTo(source.draw(int(1, 3)), (i) => i + 1),
			(n) => ({
				id: uuidAt(0, n),
				region: source.draw(regionGen),
				label: "a"
			})
		),
		"a store"
	)
	const writeGen = oneOf<ItemWrite>([
		(s) => ({
			kind: "insert",
			store: s.draw(int(0, stores.length - 1)),
			qty: s.draw(int(0, 9))
		}),
		(s) => ({ kind: "put", item: s.draw(int(0, 3)), qty: s.draw(int(0, 9)) }),
		(s) => ({ kind: "delete", item: s.draw(int(0, 3)) }),
		(s) => ({
			kind: "label",
			store: s.draw(int(0, stores.length - 1)),
			label: s.draw(element(["a", "b"] as const))
		})
	])
	return {
		stores,
		writes: [source.draw(writeGen), ...source.draw(array(writeGen, { min: 0, max: 5 }))]
	}
}

/**
 * The version installed once per member through its generated migration (installed.ts migratedOnceTemplate), where each
 * search installed it before its cases: a case rebuilds the version under the installed name (versionOf).
 */
export const holdTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "family grants hold",
	options: {
		label: "family_grants",
		first: (name) => {
			const built = versionOf(name)
			return { schema: built.schema, logins: [built.login] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})

/** The version installed once per member for the apply property (migratedOnceTemplate), as holdTemplate is. */
export const applyTemplate = migratedOnceTemplate({
	declaredIn: import.meta,
	name: "family grants apply",
	options: {
		label: "family_grants_apply",
		first: (name) => {
			const built = versionOf(name)
			return { schema: built.schema, logins: [built.login] }
		},
		later: [],
		apply: { kind: "noPlaceholders" },
		declared: () => noDeclarations
	}
})
