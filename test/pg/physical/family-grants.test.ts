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
 * The oracle is a model of the rule, per role and owner: the columns it may select and update, and the owners its row
 * security admits (every store for stocker, the first store for picker, the north ones for manager, every shelf for
 * shelver; nothing of an owner whose family the role does not write).
 * - **Columns and rows:** a case draws stores (a subset of four keys, the first store's among them or not, each in a
 *   drawn region) and shelves, then probes, each a role and a statement on an owner: a SELECT of a drawn field, an
 *   UPDATE of one to itself returning the key, an INSERT or a DELETE. PostgreSQL decides each under the role (SET LOCAL
 *   ROLE in the owner's session, rolled back): a statement the model's columns refuse is refused with 42501, and every
 *   other answers exactly the keys of the owners the model admits. Manager's columns are its query entry's, outside the
 *   rule, so its probes select the key alone.
 * - **Through grizzle's own apply:** stocker appends, puts and deletes drawn Items of drawn stores through its Db, and
 *   manager puts a drawn store's label through NorthStores, its query entry over the owner: a north store's label is
 *   put in place, `no-change` when it holds it already, a south store's put is `invariant-rejected` on Store's key, the
 *   store outside manager's entry. After
 *   each write every Store's count and stock are the family's: the number of its Items and the sum of their quantities.
 *
 * Features: each role's probes of each statement kind on the owners, admitted and refused, and each apply outcome.
 *
 * Plants (~/.cache/grizzle-release/BR11/plants): family-grants-owner-whole (a member writer holds column SELECT on every
 * field of its family's owner) and family-grants-no-recount (a member writer holds no column UPDATE on its owner).
 */
import { layer } from "@effect/vitest"
import { drawn as drawnCase, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf, subarray } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Effect,
	Formatter,
	Option,
	Order,
	Record,
	Result,
	String as Str
} from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import type { LoadedMember } from "#adapter/served/load.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { accumulated, drawn, natural, pg, type Uuid, uuid } from "#compiler/public/fields.ts"
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
import { assert, assertVariant, defined, nonEmpty } from "#test/support/assert.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { migrated, type Version } from "#test/support/installed.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { caseHang } from "#test/support/limits.ts"
import { noDeclarations } from "#test/support/migrate/kit.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import type { RawSession } from "#test/support/substrate/session.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { upTo } from "#test/support/up-to.ts"

/** The uuid of the `n`th key of a kind: stores 0x0, items 0xa0 and shelves 0xb0. */
const uuidAt = (base: number, n: number): Uuid =>
	`00000000-0000-4000-8000-${Str.padStart(12, "0")((base + n).toString(16))}`

/** The first store, which picker's filter names. */
const S1 = uuidAt(0, 1)

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

type Built = ReturnType<typeof versionOf>

type RoleName = "manager" | "stocker" | "picker" | "shelver"
type Owner = "Store" | "Shelf"

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
interface StoreRow {
	readonly id: Uuid
	readonly region: "north" | "south"
	readonly label: string
}

/** A statement a probe sends on an owner: a field selected or updated to itself, an insertion or a deletion. */
type Statement =
	| Readonly<{ kind: "select"; field: string }>
	| Readonly<{ kind: "update"; field: string }>
	| Readonly<{ kind: "insert" }>
	| Readonly<{ kind: "delete" }>

interface Probe {
	readonly role: RoleName
	readonly owner: Owner
	readonly statement: Statement
}

/** A case: the stores and shelves the owner writes, and the probes the roles send. */
interface Grants {
	readonly stores: ReadonlyArray<StoreRow>
	readonly shelves: ReadonlyArray<Uuid>
	readonly probes: Arr.NonEmptyReadonlyArray<Probe>
}

/** What a role holds of an owner, by the rule: the fields it may select and update, and the owners it admits. */
interface Hold {
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
const holdOf = (role: RoleName, owner: Owner): Option.Option<Hold> => {
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

type GrantsFeature =
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
interface ItemFact {
	readonly id: Uuid
	readonly store: Uuid
	readonly region: "north" | "south"
	readonly qty: bigint
}

/** A write stocker sends through its Db: an Item appended, a quantity put, or an Item deleted; or manager's put of a
 * store's label through NorthStores, its query entry over the north stores. */
type ItemWrite =
	| Readonly<{ kind: "insert"; store: number; qty: number }>
	| Readonly<{ kind: "put"; item: number; qty: number }>
	| Readonly<{ kind: "delete"; item: number }>
	| Readonly<{ kind: "label"; store: number; label: "a" | "b" }>

interface Apply {
	readonly stores: Arr.NonEmptyReadonlyArray<StoreRow>
	readonly writes: Arr.NonEmptyReadonlyArray<ItemWrite>
}

type ApplyFeature =
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
const heldAt = (held: ReadonlyArray<ItemFact>, at: number): Option.Option<ItemFact> =>
	Arr.isReadonlyArrayNonEmpty(held) ? Arr.get(held, at % held.length) : Option.none()

layer(Substrate.layer)("a member writer's hold on its family's owner", (it) => {
	it.effect(
		"reads and updates exactly its family's columns of the owner, and exactly the owners its member writes admit",
		(ctx) =>
			searched(
				ctx,
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
						declared: () => noDeclarations,
						observe: Option.none()
					})
					const b = defined(built, "the version")
					const names = namesOf(m)
					const tables: { readonly [O in Owner]: string } = {
						Store: names.table(b.Store),
						Shelf: names.table(b.Shelf)
					}
					const fieldsOf: { readonly [O in Owner]: Arr.NonEmptyReadonlyArray<string> } = {
						Store: nonEmpty(Record.keys(b.Store.fields), "Store's fields"),
						Shelf: nonEmpty(Record.keys(b.Shelf.fields), "Shelf's fields")
					}
					const column = (relation: Owner, field: string): string =>
						quoteIdent(names.columnIdent({ name: relation }, field))
					const owner = yield* substrate.session({
						...ownerSession(),
						label: "family grants owner"
					})
					const roleOf = (r: RoleName) =>
						defined(
							Arr.findFirst(
								Arr.flatMap(m.installation.worlds, (l) => l.roles),
								(x) => x.name === r
							).pipe(Option.getOrUndefined),
							`the role ${r}`
						).role
					const sqlOf = (probe: Probe): string => {
						const table = tables[probe.owner]
						const key = column(probe.owner, "id")
						const s = probe.statement
						switch (s.kind) {
							case "select":
								return `SELECT ${key}::text FROM ${table} WHERE ${column(probe.owner, s.field)} IS NOT NULL`
							case "update":
								return `UPDATE ${table} SET ${column(probe.owner, s.field)} = ${column(probe.owner, s.field)} RETURNING ${key}::text`
							case "insert":
								return probe.owner === "Store"
									? `INSERT INTO ${table} (${column("Store", "id")}, ${column("Store", "region")}, ${column("Store", "label")}, ${column("Store", "items")}, ${column("Store", "stock")}) VALUES ('${uuidAt(0, 9)}'::uuid, 'north', 'z', 0, 0)`
									: `INSERT INTO ${table} (${column("Shelf", "id")}, ${column("Shelf", "tag")}, ${column("Shelf", "slots")}) VALUES ('${uuidAt(0xb0, 9)}'::uuid, 'z', 0)`
							case "delete":
								return `DELETE FROM ${table}`
						}
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
					const grantsGen: Gen<Grants> = (source) => ({
						stores: source.draw(storesGen),
						shelves: Arr.map(source.draw(subarray(Arr.range(1, 2))), (n) => uuidAt(0xb0, n)),
						probes: [source.draw(probeGen), ...source.draw(array(probeGen, { min: 0, max: 3 }))]
					})
					return yield* explore(
						{
							suite: "physical/family-grants/hold",
							draw: drawnCase(grantsGen),
							literal: Formatter.format,
							oracle: {
								kind: "specification",
								name: "the member writer's rule: its family's key, count, ends and copies, the owners its members admit"
							},
							coverage: required<GrantsFeature>(
								[
									"a member writer selects a column it holds",
									"a member writer is refused a column it lacks",
									"a member writer updates its count or end",
									"a member writer is refused an update",
									"an insertion or a deletion refused",
									"picker admits the first store alone",
									"manager admits the north stores",
									"a role reaches no owner outside its family",
									"the immutable owner's count is never updated"
								],
								{ cases: 96, sense: notesOnly }
							),
							kept: [],
							runs: 32,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(g, c) =>
							Effect.gen(function* () {
								yield* owner.query(
									`TRUNCATE ${tables.Store}, ${names.table(b.Item)}, ${tables.Shelf}, ${names.table(b.Slot)}`,
									[]
								)
								for (const store of g.stores) {
									yield* owner.query(
										`INSERT INTO ${tables.Store} (${column("Store", "id")}, ${column("Store", "region")}, ${column("Store", "label")}, ${column("Store", "items")}, ${column("Store", "stock")}) VALUES ($1::uuid, $2, $3, 0, 0)`,
										[store.id, store.region, store.label]
									)
								}
								for (const shelf of g.shelves) {
									yield* owner.query(
										`INSERT INTO ${tables.Shelf} (${column("Shelf", "id")}, ${column("Shelf", "tag")}, ${column("Shelf", "slots")}) VALUES ($1::uuid, 'a', 0)`,
										[shelf]
									)
								}
								for (const probe of g.probes) {
									const sql = sqlOf(probe)
									const got = yield* asRole(owner, roleOf(probe.role), sql)
									const hold = holdOf(probe.role, probe.owner)
									const s = probe.statement
									const allowed = Option.exists(hold, (h) =>
										s.kind === "select"
											? h.select.has(s.field)
											: s.kind === "update"
												? h.update.has(s.field)
												: false
									)
									if (!allowed) {
										assert.deepEqual(got, { refused: "42501" }, `${probe.role}: ${sql}`)
										if (Option.isNone(hold)) {
											c.note("a role reaches no owner outside its family")
										} else if (s.kind === "insert" || s.kind === "delete") {
											c.note("an insertion or a deletion refused")
										} else if (probe.owner === "Shelf" && s.kind === "update") {
											c.note("the immutable owner's count is never updated")
										} else if (s.kind === "select") {
											c.note("a member writer is refused a column it lacks")
										} else {
											c.note("a member writer is refused an update")
										}
										continue
									}
									const admitted = Option.match(hold, {
										onNone: () => [],
										onSome: (h) =>
											probe.owner === "Store"
												? Arr.map(Arr.filter(g.stores, h.admits), (store) => store.id)
												: g.shelves
									})
									assert.deepEqual(
										got,
										{ rows: Arr.sort(admitted, Order.String) },
										`${probe.role}: ${sql}`
									)
									switch (probe.role) {
										case "picker":
											if (
												Arr.some(g.stores, (store) => store.id === S1) &&
												Arr.some(g.stores, (store) => store.id !== S1)
											) {
												c.note("picker admits the first store alone")
											}
											break
										case "manager":
											if (
												Arr.isReadonlyArrayNonEmpty(admitted) &&
												admitted.length < g.stores.length
											) {
												c.note("manager admits the north stores")
											}
											break
										case "stocker":
										case "shelver":
											break
									}
									c.note(
										s.kind === "update"
											? "a member writer updates its count or end"
											: "a member writer selects a column it holds"
									)
								}
							})
					)
				}).pipe(Effect.scoped)
			)
	)

	it.effect(
		"keeps each owner's count and stock through a member writer's own appends, puts and deletes",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const substrate = yield* Substrate
					let built: Built | undefined
					const m = yield* migrated({
						label: "family_grants_apply",
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
					const store = names.table(b.Store)
					const sc = (f: "id" | "region" | "label" | "items" | "stock") => names.column(b.Store, f)
					const owner = yield* substrate.session({
						...ownerSession(),
						label: "family grants apply owner"
					})
					const counts = Effect.map(
						owner.values(
							`SELECT ${sc("id")}::text, ${sc("items")}::text, ${sc("stock")}::text FROM ${store} ORDER BY 1`,
							[]
						),
						(rows) => Arr.map(rows, (row) => Arr.map(row, String))
					)
					const applyGen: Gen<Apply> = (source) => {
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
					const labelOf = (id: Uuid) =>
						Effect.map(
							owner.values(`SELECT ${sc("label")} FROM ${store} WHERE ${sc("id")} = $1::uuid`, [
								id
							]),
							(rows) => String(rows[0]?.[0])
						)
					return yield* withServedDb(m, b.login.roles.stocker, {}, (stockerDb) =>
						withServedDb(m, b.login.roles.manager, {}, (managerDb) =>
							Effect.gen(function* () {
								/** The stocker's appends, puts and deletes of Item, and the manager's puts of NorthStores, each a call's facts. */
								const stocker = {
									ctx: stockerDb.ctx,
									members: yield* stockerDb.load({
										append: ChangeSet.empty(b.stocker).insert(b.stocker.relations.Item, []),
										put: ChangeSet.empty(b.stocker).put(b.stocker.relations.Item, []),
										remove: ChangeSet.empty(b.stocker).delete(b.stocker.relations.Item, [])
									})
								}
								const manager = {
									ctx: managerDb.ctx,
									members: yield* managerDb.load({
										label: ChangeSet.empty(b.manager).put(b.manager.relations.NorthStores, [])
									})
								}
								/** A change member's apply on its Db with the call's facts, its ChangeSet's array members. */
								const applied = (
									db: {
										readonly ctx: ServedDbContext
										readonly members: ReadonlyMap<string, LoadedMember>
									},
									name: string,
									facts: unknown
								) => {
									const change = member(db.members, name)
									assertVariant(change, "kind", "change", `the member ${name} is a change`)
									assert.equal(
										variantOf(db.ctx, change.variants).call.kind,
										"facts",
										`the member ${name} takes its call's facts`
									)
									return answered(writeOnce(memberCalls(db.ctx, change))({ params: {}, facts }))
								}
								return yield* explore(
									{
										suite: "physical/family-grants/apply",
										draw: drawnCase(applyGen),
										literal: Formatter.format,
										oracle: {
											kind: "specification",
											name: "the families model: each store's count is its Items', its stock their quantities' sum"
										},
										coverage: required<ApplyFeature>(
											[
												"an append",
												"a put of a quantity",
												"a deletion",
												"items of two stores",
												"a north store's label put through NorthStores",
												"a south store's label refused through NorthStores"
											],
											{ cases: 32, sense: notesOnly }
										),
										kept: [],
										runs: 16,
										shrink: completeShrink,
										concurrency: 1,
										steerEvery: 8,
										caseHang
									},
									(a, c) =>
										Effect.gen(function* () {
											yield* owner.query(
												`TRUNCATE ${store}, ${names.table(b.Item)}, ${names.table(b.Shelf)}, ${names.table(b.Slot)}`,
												[]
											)
											for (const s of a.stores) {
												yield* owner.query(
													`INSERT INTO ${store} (${sc("id")}, ${sc("region")}, ${sc("label")}, ${sc("items")}, ${sc("stock")}) VALUES ($1::uuid, $2, $3, 0, 0)`,
													[s.id, s.region, s.label]
												)
											}
											const items = new Map<Uuid, ItemFact>()
											for (const [at, w] of a.writes.entries()) {
												const held = Arr.fromIterable(items.values())
												switch (w.kind) {
													case "insert": {
														const into = Arr.getUnsafe(a.stores, w.store)
														const fact: ItemFact = {
															id: uuidAt(0xa0, at + 1),
															store: into.id,
															region: into.region,
															qty: BigInt(w.qty)
														}
														yield* applied(stocker, "append", { insert: { Item: [fact] } })
														items.set(fact.id, fact)
														c.note("an append")
														break
													}
													case "put": {
														const target = heldAt(held, w.item)
														if (Option.isNone(target)) {
															break
														}
														const fact: ItemFact = { ...target.value, qty: BigInt(w.qty) }
														yield* applied(stocker, "put", { put: { Item: [fact] } })
														items.set(fact.id, fact)
														c.note("a put of a quantity")
														break
													}
													case "delete": {
														const target = heldAt(held, w.item)
														if (Option.isNone(target)) {
															break
														}
														yield* applied(stocker, "remove", { delete: { Item: [target.value] } })
														items.delete(target.value.id)
														c.note("a deletion")
														break
													}
													case "label": {
														const target = Arr.getUnsafe(a.stores, w.store)
														const was = yield* labelOf(target.id)
														const outcome = yield* applied(manager, "label", {
															put: { NorthStores: [{ id: target.id, label: w.label }] }
														})
														const now = yield* labelOf(target.id)
														const what = `manager's put of ${Formatter.format(w)}`
														if (target.region === "north") {
															assert.deepEqual(
																[outcome.kind, now],
																[was === w.label ? "unchanged" : "accepted", w.label],
																what
															)
															c.note("a north store's label put through NorthStores")
														} else {
															const laws: ReadonlyArray<string> =
																outcome.kind === "refused"
																	? Arr.map(refusedLaws(outcome.refused), (l) => l.kind)
																	: []
															assert.deepEqual(
																[outcome.kind, ...laws],
																["refused", "primaryKey"],
																what
															)
															assert.equal(now, was, what)
															c.note("a south store's label refused through NorthStores")
														}
														break
													}
												}
												const expected = Arr.map(
													Arr.sort(
														Arr.map(a.stores, (s) => s.id),
														Order.String
													),
													(id) => {
														const mine = Arr.filter(
															Arr.fromIterable(items.values()),
															(i) => i.store === id
														)
														return [
															id,
															String(mine.length),
															String(Arr.reduce(mine, 0n, (sum, i) => sum + i.qty))
														]
													}
												)
												const after = yield* counts
												assert.deepEqual(after, expected, `after ${Formatter.format(w)}`)
											}
											if (
												new Set(Arr.map(Arr.fromIterable(items.values()), (i) => i.store)).size > 1
											) {
												c.note("items of two stores")
											}
										})
								)
							})
						)
					)
				}).pipe(Effect.scoped)
			)
	)
})
