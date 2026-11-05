/**
 * A member writer's hold on its family's owner, on PostgreSQL 19 (physical/ddl/roles.ts, rows-first): a role that
 * writes a family's member and not its owner O holds column SELECT on O's key, count, ends and copies, column UPDATE on
 * its count and ends when O is mutable, nothing else of O, and a policy on O under O's row security that admits exactly
 * the owners whose groups its member writes admit.
 *
 * The schema: Stores (id, region, label, a drawn count of Items and an accumulated stock) own a counted family of Items,
 * which copy their store's region and sum their quantities into its stock; Shelves (immutable) own an ordered family of
 * Slots. Roles: `manager` writes the north Stores, a query entry whose filter puts Store under row security; `stocker`
 * writes Item whole; `picker` writes the Items of the first store, a filter over the group; `shelver` writes Slot whole.
 *
 * Properties, each as PostgreSQL decides it under the role (SET LOCAL ROLE in the owner's session, rolled back):
 * - **Columns:** stocker reads Store's id, region, count and stock and updates its count and stock, and is refused
 *   (42501) reading or updating its label, inserting a Store and deleting one; shelver reads Shelf's id and count and is
 *   refused updating the count of the immutable Shelf and reading its tag.
 * - **Rows:** under Store's row security, stocker, whose members are every Item, reads and updates every Store; picker
 *   reads and updates exactly the first store, the one its filter's group names; manager reads the north ones.
 * - **Through grizzle's own apply:** stocker appends Items to a north and a south store, puts a quantity and deletes an
 *   Item, each one read flight and count statement over those columns alone, and each Store's count and stock are the
 *   family's.
 */
import { layer } from "@effect/vitest"
import { Array as Arr, Effect, Option, Result } from "effect"
import { Db } from "#adapter/public/db.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, uuid } from "#compiler/public/fields.ts"
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
import { quoteIdent } from "#compiler/sql/print.ts"
import { assert, defined } from "#test/support/assert.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"
import { loginLayer } from "#test/support/worlds.ts"

const S1 = "00000000-0000-4000-8000-000000000001"
const S2 = "00000000-0000-4000-8000-000000000002"
const S3 = "00000000-0000-4000-8000-000000000003"
const S9 = "00000000-0000-4000-8000-000000000009"
const I1 = "00000000-0000-4000-8000-0000000000a1"
const I2 = "00000000-0000-4000-8000-0000000000a2"
const I3 = "00000000-0000-4000-8000-0000000000a3"
const H1 = "00000000-0000-4000-8000-0000000000b1"

/** The version under the declared name `name`. */
const versionOf = (name: string) => {
	const word = str.regex("^[a-z]{1,8}$")
	const Store = relation(
		"Store",
		{
			id: uuid,
			region: word,
			label: word,
			items: drawn(natural),
			stock: accumulated(pg.bigint, 0n)
		},
		["id"]
	)
	const Item = relation("Item", { id: uuid, store: uuid, region: word, qty: pg.bigint }, ["id"])
	const Shelf = relation("Shelf", { id: uuid, tag: word, slots: drawn(natural) }, ["id"])
	const Slot = relation("Slot", { shelf: uuid, at: drawn(natural), what: word }, ["shelf", "at"])
	const items = counted(on(Item, "store"), fin(Store, "items"))
	const base = schema(name, { Store, Item, Shelf, Slot }, [
		items,
		fold(items, Monoid.sum, on(Item, "store", "qty"), on(Store, "id", "stock")),
		contained(on(Item, "store", "region"), on(Store, "id", "region")),
		ordered(on(Slot, "shelf", "at"), fin(Shelf, "slots")),
		mutable(Store),
		mutable(Item)
	])
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
		stocker,
		login: login(base, "desk", [manager, stocker, picker, shelver])
	}
}

type Built = ReturnType<typeof versionOf>

/** Takes on `role` for one transaction in the owner's session, sends `sql` and rolls back: its rows' first column as
 * text, sorted, or the SQLSTATE it was refused with. */
const asRole = (session: RawSession, role: string, sql: string) =>
	Effect.gen(function* () {
		yield* session.begin
		yield* session.query(`SET LOCAL ROLE ${quoteIdent(role)}`, [])
		const outcome = yield* Effect.result(session.values(sql, []))
		yield* session.rollback
		return Result.match(outcome, {
			onSuccess: (
				rows
			): { readonly rows: ReadonlyArray<string> } | { readonly refused: string } => ({
				rows: Arr.map(rows, (row) => String(row[0])).toSorted()
			}),
			onFailure: (error) => ({
				refused:
					error.reason._tag === "ServerError" ? error.reason.fields.code : error.reason.message
			})
		})
	})

layer(Substrate.layer)("a member writer's hold on its family's owner", (it) => {
	it.effect(
		"reads and updates exactly its family's columns of the owner, and exactly the owners its member writes admit",
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const substrate = yield* Substrate
					let built: Built | undefined
					const m = yield* migrated({
						label: "family_grants",
						schemaName: { kind: "unique" },
						first: (name: string): Version => {
							built = versionOf(name)
							return { schema: built.schema, logins: [built.login] }
						},
						later: [],
						apply: { kind: "noPlaceholders" },
						register: true,
						declared: () => noDeclarations,
						observe: Option.none()
					})
					const b = defined(built, "the version")
					const names = namesOf(m)
					const store = names.table(b.Store)
					const shelf = names.table(b.Shelf)
					const sc = (f: "id" | "region" | "label" | "items" | "stock") => names.column(b.Store, f)
					const hc = (f: "id" | "tag" | "slots") => names.column(b.Shelf, f)
					const owner = yield* substrate.session({
						...ownerSession(),
						label: "family grants owner"
					})
					yield* owner.query(
						`INSERT INTO ${store} (${sc("id")}, ${sc("region")}, ${sc("label")}, ${sc("items")}, ${sc("stock")}) VALUES ($1::uuid, 'north', 'a', 0, 0), ($2::uuid, 'south', 'b', 0, 0), ($3::uuid, 'north', 'c', 0, 0)`,
						[S1, S2, S3]
					)
					yield* owner.query(
						`INSERT INTO ${shelf} (${hc("id")}, ${hc("tag")}, ${hc("slots")}) VALUES ($1::uuid, 'a', 0)`,
						[H1]
					)
					const roleOf = (r: "manager" | "stocker" | "picker" | "shelver") =>
						defined(
							Arr.findFirst(
								Arr.flatMap(m.installation.worlds, (l) => l.roles),
								(x) => x.name === r
							).pipe(Option.getOrUndefined),
							`the role ${r}`
						).role
					const every = [S1, S2, S3]
					const expect = (
						r: "manager" | "stocker" | "picker" | "shelver",
						sql: string,
						want: { readonly rows: ReadonlyArray<string> } | { readonly refused: string },
						why: string
					) => Effect.map(asRole(owner, roleOf(r), sql), (got) => assert.deepEqual(got, want, why))

					yield* expect(
						"stocker",
						`SELECT ${sc("id")}::text FROM ${store} WHERE ${sc("region")} IS NOT NULL AND ${sc("items")} >= 0 AND ${sc("stock")} >= 0`,
						{ rows: every },
						"stocker reads every Store's key, region, count and stock"
					)
					yield* expect(
						"stocker",
						`SELECT ${sc("label")} FROM ${store}`,
						{ refused: "42501" },
						"stocker reads no Store label"
					)
					yield* expect(
						"stocker",
						`UPDATE ${store} SET ${sc("items")} = ${sc("items")}, ${sc("stock")} = ${sc("stock")} RETURNING ${sc("id")}::text`,
						{ rows: every },
						"stocker updates every Store's count and stock"
					)
					yield* expect(
						"stocker",
						`UPDATE ${store} SET ${sc("label")} = ${sc("label")}`,
						{ refused: "42501" },
						"stocker updates no Store label"
					)
					yield* expect(
						"stocker",
						`INSERT INTO ${store} (${sc("id")}, ${sc("region")}, ${sc("label")}, ${sc("items")}, ${sc("stock")}) VALUES ('${S9}'::uuid, 'north', 'z', 0, 0)`,
						{ refused: "42501" },
						"stocker inserts no Store"
					)
					yield* expect(
						"stocker",
						`DELETE FROM ${store}`,
						{ refused: "42501" },
						"stocker deletes no Store"
					)
					yield* expect(
						"shelver",
						`SELECT ${hc("id")}::text FROM ${shelf} WHERE ${hc("slots")} >= 0`,
						{ rows: [H1] },
						"shelver reads Shelf's key and count"
					)
					yield* expect(
						"shelver",
						`UPDATE ${shelf} SET ${hc("slots")} = ${hc("slots")}`,
						{ refused: "42501" },
						"shelver updates no count of the immutable Shelf"
					)
					yield* expect(
						"shelver",
						`SELECT ${hc("tag")} FROM ${shelf}`,
						{ refused: "42501" },
						"shelver reads no Shelf tag"
					)

					yield* expect(
						"picker",
						`SELECT ${sc("id")}::text FROM ${store}`,
						{ rows: [S1] },
						"picker reads exactly the store its filter's group names"
					)
					yield* expect(
						"picker",
						`UPDATE ${store} SET ${sc("items")} = ${sc("items")} RETURNING ${sc("id")}::text`,
						{ rows: [S1] },
						"picker updates exactly the store its filter's group names"
					)
					yield* expect(
						"manager",
						`SELECT ${sc("id")}::text FROM ${store}`,
						{ rows: [S1, S3] },
						"manager reads the north stores"
					)

					const counts = Effect.map(
						owner.values(
							`SELECT ${sc("id")}::text, ${sc("items")}::text, ${sc("stock")}::text FROM ${store} ORDER BY 1`,
							[]
						),
						(rows) => Arr.map(rows, (row) => Arr.map(row, String).join(" "))
					)
					yield* Effect.scoped(
						Effect.gen(function* () {
							const db = yield* Db.open(b.login.roles.stocker, {})
							yield* db.apply(
								ChangeSet.empty(b.stocker).insert(b.stocker.relations.Item, [
									{ id: I1, store: S1, region: "north", qty: 2n },
									{ id: I2, store: S1, region: "north", qty: 3n },
									{ id: I3, store: S2, region: "south", qty: 5n }
								]),
								{}
							)
							assert.deepEqual(
								yield* counts,
								[`${S1} 2 5`, `${S2} 1 5`, `${S3} 0 0`],
								"each store's count and stock after the appends, a south store's included"
							)
							yield* db.apply(
								ChangeSet.empty(b.stocker).put(b.stocker.relations.Item, [
									{ id: I1, store: S1, region: "north", qty: 7n }
								]),
								{}
							)
							assert.deepEqual(
								yield* counts,
								[`${S1} 2 10`, `${S2} 1 5`, `${S3} 0 0`],
								"the first store's stock after a put of a quantity"
							)
							yield* db.apply(
								ChangeSet.empty(b.stocker).delete(b.stocker.relations.Item, [
									{ id: I1, store: S1, region: "north", qty: 7n }
								]),
								{}
							)
							assert.deepEqual(
								yield* counts,
								[`${S1} 1 3`, `${S2} 1 5`, `${S3} 0 0`],
								"the first store's count and stock after a delete"
							)
						})
					).pipe(withLayer(loginLayer(m, b.login)))
				})
			)
	)
})
