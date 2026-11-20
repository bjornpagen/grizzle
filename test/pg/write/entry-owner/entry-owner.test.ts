import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order } from "effect"
import { changeSetOver } from "#compiler/write/changeset/value.ts"
import {
	caseGen,
	expectedOf,
	type Feature,
	holdsAll,
	type Row,
	rowOf,
	shopTemplate,
	statedFilters,
	uuidAt,
	versionOf
} from "#test/pg/write/entry-owner/entry-owner.fixtures.ts"
import { answered, writeOnce } from "#test/support/calls.ts"
import { entryName, roleName } from "#test/support/families/entry-owner.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A family's owner written through a role's query entry on PostgreSQL 19 inserts and puts the north stores each entry sees as the model of the entry over the family states, leaving every count, stock and Item as the family holds them.
 *
 * Its pre-conversion budget: runs 32, coverage cases 120 (test/pg/write/entry-owner/entry-owner.test.ts at d8eed1786).
 */
export const aFamilysOwnerWrittenThroughARolesQueryEntryOnPostgreSQL19InsertsAndPutsTheNorthStoresEachEntrySeesAsTheModelOfTheEntryOverTheFamilyStatesLeavingEveryCountStockAndItemAsTheFamilyHoldsThem =
	property.explore(caseGen, {
		needs: { shop: Substrate.seat(shopTemplate) },
		situations: [
			...Arr.flatMap(["insert", "put"] as const, (op) =>
				Arr.map(
					["a visible store", "an unseen store", "a fresh key"] as const,
					(where): Feature => `${op}: ${where}`
				)
			),
			"insert of a fact outside the entry",
			"put of a fact outside the entry",
			...Arr.map(holdsAll, (holds): Feature => `a head holding ${holds}`)
		] satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ shop }, run: Case<Feature>) =>
			(c) =>
				Effect.flatMap(shop, ({ substrate: seat, value: m }) =>
					Effect.provideService(
						Effect.gen(function* () {
							const substrate = yield* Substrate
							const b = versionOf(m.declared)
							const names = namesOf(m)
							const store = names.table(b.built.Store)
							const items = names.table(b.built.Item)
							const sc = (f: "id" | "region" | "label" | "items" | "stock") =>
								names.column(b.built.Store, f)
							const owner = yield* substrate.session({ ...ownerSession(), label: "entry owner" })
							const rows = Effect.map(
								owner.values(
									`SELECT ${sc("id")}::text, ${sc("region")}, ${sc("label")}, ${sc("items")}::text, ${sc("stock")}::text FROM ${store} ORDER BY 1`,
									[]
								),
								(read): ReadonlyArray<Row> => Arr.map(read, (row) => Arr.map(row, String))
							)
							const itemCount = Effect.map(
								owner.values(`SELECT count(*)::text FROM ${items}`, []),
								(read) => String(read[0]?.[0])
							)
							return yield* Effect.gen(function* () {
								const keeper = yield* openServedDb(
									m,
									defined(b.login.roles["keeper"], "the keeper"),
									{}
								)
								const seeds = yield* keeper.serve({
									seed: changeSetOver
										.empty(b.keeper)
										.insert(defined(b.keeper.relations["Store"], "the keeper's Store"), [])
										.insert(defined(b.keeper.relations["Item"], "the keeper's Item"), [])
								})
								/** Each entry role's insert and put of its entry, served on its own Db, by the role's name. */
								const opened = yield* Effect.forEach(
									Arr.flatMap(holdsAll, (holds) =>
										Arr.map(statedFilters, (filter) => [holds, filter] as const)
									),
									([holds, filter]) =>
										Effect.gen(function* () {
											const name = roleName(holds, filter)
											const writerRole = defined(b.writers.get(name), "the writer's role")
											const relation = defined(
												writerRole.relations[entryName(holds, filter)],
												"the writer's entry"
											)
											const db = yield* openServedDb(
												m,
												defined(b.login.roles[name], "an entry role"),
												{}
											)
											const empty = changeSetOver.empty(writerRole)
											const served = yield* db.serve({
												insert: empty.insert(relation, []),
												put: empty.put(relation, [])
											})
											return [name, served] as const
										})
								)
								const writers = new Map(opened)

								yield* owner.query(`TRUNCATE ${store}, ${items}`, [])
								const storeFacts = Arr.map(c.stores, (s) => ({
									id: uuidAt(0, s.key),
									region: s.region,
									label: s.label
								}))
								const itemFacts = Arr.flatMap(c.stores, (s) =>
									Arr.map(s.qtys, (qty, i) => ({
										id: uuidAt(0xa0, s.key * 4 + i),
										store: uuidAt(0, s.key),
										region: s.region,
										qty: BigInt(qty)
									}))
								)
								const seeded = yield* answered(
									writeOnce(member(seeds, "seed"))({
										params: {},
										facts: { insert: { Store: storeFacts, Item: itemFacts } }
									})
								)
								assert.equal(
									seeded.kind,
									Arr.isReadonlyArrayNonEmpty(c.stores) ? "accepted" : "unchanged",
									"the keeper's state"
								)
								const before = yield* itemCount
								const w = c.write
								const writer = defined(writers.get(roleName(w.holds, w.filter)), "the writer")
								const fact = { id: uuidAt(0, w.key), label: w.label }
								const outcome = yield* answered(
									writeOnce(member(writer, w.op))({
										params: {},
										facts: { [w.op]: { [entryName(w.holds, w.filter)]: [fact] } }
									})
								)
								const after = yield* rows
								const stored = Arr.sort(
									Arr.map(c.stores, rowOf),
									Order.mapInput(Order.String, (r: Row) => defined(r[0], "a store's id"))
								)
								const { expected, situation } = expectedOf(c)
								const laws =
									outcome.kind === "refused"
										? Arr.sort(
												Arr.map(refusedLaws(outcome.refused), (l) => l.kind),
												Order.String
											)
										: []
								const what = `${Formatter.format(c)}: ${outcome.kind} ${Formatter.format(laws)}, leaving ${Formatter.format(after)}`
								switch (expected.kind) {
									case "accepted": {
										const left = Arr.sort(
											Arr.map(expected.stores, rowOf),
											Order.mapInput(Order.String, (r: Row) => defined(r[0], "a store's id"))
										)
										assert.deepEqual(after, left, what)
										assert.equal(
											outcome.kind,
											deepEquals(left, stored) ? "unchanged" : "accepted",
											what
										)
										break
									}
									case "key law":
										assert.deepEqual([outcome.kind, laws], ["refused", ["primaryKey"]], what)
										break
									case "outside":
										assert.equal(outcome.kind, "outsideWorld", what)
										break
									case "outside or key law":
										assert.ok(
											outcome.kind === "outsideWorld" ||
												(outcome.kind === "refused" && Arr.contains(laws, "primaryKey")),
											what
										)
										break
								}
								if (expected.kind !== "accepted") {
									assert.deepEqual(after, stored, what)
								}
								const itemsAfter = yield* itemCount
								assert.equal(itemsAfter, before, `${what}: the Items`)
								run.note(situation)
								run.note(`a head holding ${w.holds}`)
							}).pipe(Effect.scoped)
						}).pipe(Effect.scoped),
						Substrate,
						seat
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the entry over the family: the north stores its filter admits, put in place, inserted at the family's starts"
		},
		budget: { runs: 32, steered: 120 },
		kept: [],
		kills: []
	})
