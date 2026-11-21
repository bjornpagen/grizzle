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
 */
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, Array as Arr, Option, Order } from "effect"
import { type ServedDbContext } from "#adapter/db/context.ts"
import { memberCalls, variantOf } from "#adapter/db/handles.ts"
import { type LoadedMember } from "#adapter/served/load.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { type Uuid } from "#compiler/public/fields.ts"
import {
	type ApplyFeature,
	applyGen,
	applyTemplate,
	asRole,
	type GrantsFeature,
	grantsGen,
	heldAt,
	holdOf,
	holdTemplate,
	type ItemFact,
	type Owner,
	type Probe,
	type RoleName,
	S1,
	uuidAt,
	versionOf
} from "#test/pg/physical/family-grants.fixtures.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { openServedDb, member } from "#test/support/served-db.ts"
import { Substrate, ownerSession } from "#test/support/substrate/substrate.ts"

/**
 * A member writer's hold reads and updates exactly its family's columns of the owner, and exactly the owners its member
 * writes admit, each case on the worker's seat of the version.
 *
 * Its pre-conversion budget: runs 32, coverage cases 96 (test/pg/physical/family-grants.test.ts at d4a2aaf70).
 */
export const aMemberWriterReadsAndUpdatesExactlyItsFamilysColumnsOfTheOwnerAndExactlyTheOwnersItsWritesAdmit =
	property.explore(grantsGen, {
		needs: { version: Substrate.seat(holdTemplate) },
		situations: [
			"a member writer selects a column it holds",
			"a member writer is refused a column it lacks",
			"a member writer updates its count or end",
			"a member writer is refused an update",
			"an insertion or a deletion refused",
			"picker admits the first store alone",
			"manager admits the north stores",
			"a role reaches no owner outside its family",
			"the immutable owner's count is never updated"
		] satisfies ReadonlyArray<Reached<GrantsFeature>>,
		check:
			({ version }, c: Case<GrantsFeature>) =>
			(g) =>
				Effect.scoped(
					Effect.flatMap(version, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const m = taken.value
								const b = versionOf(m.declared)
								const names = namesOf(m)
								const tables: { readonly [O in Owner]: string } = {
									Store: names.table(b.Store),
									Shelf: names.table(b.Shelf)
								}
								const column = (relation: Owner, field: string): string =>
									quoteIdent(names.columnIdent({ name: relation }, field))
								const owner = yield* s.session({
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
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the member writer's rule: its family's key, count, ends and copies, the owners its members admit"
		},
		show: Formatter.format,
		budget: { runs: 32, steered: 96 },
		kept: [],
		kills: []
	})

/**
 * A member writer's own appends, puts and deletes keep each owner's count and stock, each case on the worker's seat of
 * the version, its stocker's and manager's Dbs its own.
 *
 * Its pre-conversion budget: runs 16, coverage cases 32 (test/pg/physical/family-grants.test.ts at d4a2aaf70).
 */
export const keepsEachOwnersCountAndStockThroughAMemberWritersOwnAppendsPutsAndDeletes =
	property.explore(applyGen, {
		needs: { version: Substrate.seat(applyTemplate) },
		situations: [
			"an append",
			"a put of a quantity",
			"a deletion",
			"items of two stores",
			"a north store's label put through NorthStores",
			"a south store's label refused through NorthStores"
		] satisfies ReadonlyArray<Reached<ApplyFeature>>,
		check:
			({ version }, c: Case<ApplyFeature>) =>
			(a) =>
				Effect.scoped(
					Effect.flatMap(version, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const m = taken.value
								const b = versionOf(m.declared)
								const names = namesOf(m)
								const store = names.table(b.Store)
								const sc = (f: "id" | "region" | "label" | "items" | "stock") =>
									names.column(b.Store, f)
								const owner = yield* s.session({
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
								const labelOf = (id: Uuid) =>
									Effect.map(
										owner.values(
											`SELECT ${sc("label")} FROM ${store} WHERE ${sc("id")} = $1::uuid`,
											[id]
										),
										(rows) => String(rows[0]?.[0])
									)
								const stockerDb = yield* openServedDb(m, b.login.roles.stocker, {})
								const managerDb = yield* openServedDb(m, b.login.roles.manager, {})
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
												assert.deepEqual([outcome.kind, ...laws], ["refused", "primaryKey"], what)
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
								if (new Set(Arr.map(Arr.fromIterable(items.values()), (i) => i.store)).size > 1) {
									c.note("items of two stores")
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the families model: each store's count is its Items', its stock their quantities' sum"
		},
		show: Formatter.format,
		budget: { runs: 16, steered: 32 },
		kept: [],
		kills: []
	})
