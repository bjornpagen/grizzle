/**
 * Explain on PostgreSQL 19: a served change member's explain (adapter/served/explain.ts, through its handle's
 * operations, adapter/db/handles.ts memberExplains) plans exactly the named prepared statements the call it explains
 * would send, each under its served name, decodes each plan into the typed Plan whose every node names what it reads by
 * the login's served file, and writes nothing.
 *
 * The oracle of "the statements the call sends" is the call itself: each case runs on a Db whose pool of one session is
 * tapped (test/support/wire-tap.ts), explains the program, then runs it, and the plans must be exactly the statements
 * that run sent which have a plan, every Execute on the wire but a carrier's stand-up and its ANALYZE (utility
 * statements PostgreSQL never plans), in order: each plan under the name its statement was bound by, and each EXPLAIN
 * explain sent over exactly that statement's served text (sql/emit.ts explainOf). The oracle of what a node reads is the
 * catalog and the installation's names: a relation of the member's footprint, the Shop relations a ChangeSet writes and
 * reads back, and an index the catalog holds on that relation's table (physical/ddl/names.ts InstallNames relation).
 *
 * A ChangeSet drawn over the Shop fixture (one or two strata of inserts, puts and deletes, with or without read-backs of
 * delta.added and delta.removed, one joining Item's added facts with Stock), a change member whose first stratum's rows
 * are the call's facts and whose second's are query members over the call's relation parameters, is explained one plan
 * per plannable statement its apply sends, under its name, over its text, in a transaction that is rolled back: no fact
 * written, which EXPLAIN ANALYZE would have done; a read-back rides the statement that makes its delta, so no plan reads
 * a carrier but a staged member slot's, the call's own facts that two statements read (write/program/slot-carriers.ts).
 */
import { assert, assertVariant, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { memberExplains, memberCalls, variantOf } from "#adapter/db/handles.ts"
import { planNodes } from "#bench/harness/explain.ts"
import { type ParamMap } from "#compiler/plan/common.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { query, v } from "#compiler/public/query.ts"
import {
	catalogIndexes,
	changeCaseGen,
	type ChangeFeature,
	estimateOnly,
	estimating,
	explainShopInstall,
	explainShopTemplate,
	labels,
	laterStratum,
	observe,
	ofTheServed,
	plannedStatements,
	readsWithin,
	tappedPool
} from "#test/pg/reads/explain.fixtures.ts"
import { Item, Seat, Shop, Stock, uuidOf } from "#test/pg/reads/shop.ts"
import { openedIn } from "#test/pg/reads/support.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import { member, openServedDb } from "#test/support/served-db.ts"
import { flightSlotCarriers, textsNaming } from "#test/support/slot-carriers.ts"
import { tableState } from "#test/support/substrate/state.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Explains a drawn ChangeSet: its apply's plannable statements, by name and text, within its footprint, executing
 * nothing, each case on the worker's seat of the Shop fixture, opening its own tapped Db, its apply's rows emptied after
 * it.
 *
 * Its pre-conversion budget: runs 40, coverage cases 40 (test/pg/reads/explain.test.ts at d1a6ae9ac).
 */
export const explainsADrawnChangeSetItsApplysPlannableStatementsByNameAndTextWithinItsFootprintExecutingNothing =
	property.explore(changeCaseGen, {
		needs: { shop: Substrate.seat(explainShopTemplate) },
		situations: [
			"a seat inserted",
			"an insert",
			"a put",
			"a delete",
			"two strata",
			"a read-back",
			"a read-back joining a stored relation"
		] satisfies ReadonlyArray<Reached<ChangeFeature>>,
		check:
			({ shop }, notes: Case<ChangeFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(shop, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const o = yield* openedIn(Shop, {}, explainShopInstall, taken)
								const state = () =>
									Effect.all([
										tableState(o.installed, Seat),
										tableState(o.installed, Stock),
										tableState(o.installed, Item)
									])
								const indexes = yield* catalogIndexes
								const tableOf = (relation: string) =>
									o.installed.installation.names.relation(relation)
								/** The relations every drawn ChangeSet writes and reads back. */
								const footprint: ReadonlySet<string> = new Set(["Seat", "Item", "Stock"])
								const { ctx, loadWithTables } = yield* openServedDb(
									o.installed,
									o.server.roles.app,
									{}
								)
								const { pool, tap } = yield* tappedPool(o.installed.as(o.server))
								const context = { ...ctx, pool }
								/** A stratum's operations, each kind's facts together. */
								const strata = Arr.map(c.strata, (ops) => {
									const seats = Arr.flatMap(ops, (op) =>
										op.kind === "seat"
											? [{ no: BigInt(op.id), label: defined(labels[op.label]) }]
											: []
									)
									const items = Arr.flatMap(ops, (op) =>
										op.kind === "item"
											? [{ id: uuidOf(op.id), label: "bin", qty: BigInt(op.qty) }]
											: []
									)
									const puts = Arr.flatMap(ops, (op) =>
										op.kind === "put stock"
											? [
													{
														id: uuidOf(op.id),
														label: defined(labels[op.label]),
														qty: BigInt(op.qty)
													}
												]
											: []
									)
									const deletes = Arr.flatMap(ops, (op) =>
										op.kind === "delete stock" ? [{ id: uuidOf(op.id), label: "old", qty: 0n }] : []
									)
									if (seats.length > 0) {
										notes.note("a seat inserted")
									}
									if (items.length > 0) {
										notes.note("an insert")
									}
									if (puts.length > 0) {
										notes.note("a put")
									}
									if (deletes.length > 0) {
										notes.note("a delete")
									}
									return { seats, items, puts, deletes }
								})
								const [first, second] = strata
								const written = defined(first, "a first stratum")
								/** The first stratum's array members, each a call's facts. */
								const firstStratum = ChangeSet.empty(Shop)
									.insert(Seat, [])
									.insert(Item, [])
									.put(Stock, [])
									.delete(Stock, [])
								const sequenced =
									second === undefined
										? firstStratum
										: ChangeSet.sequence(firstStratum, laterStratum)
								if (second !== undefined) {
									notes.note("two strata")
								}
								const changes =
									c.readBack === "none"
										? sequenced
										: c.readBack === "items joined"
											? sequenced.read("items", (d) =>
													query(Shop).rule((r) => {
														const { id, label, qty } = v(Stock, "stock")
														return r
															.match(d.added(Item), { id })
															.match(Stock, { id, label, qty })
															.find({ id, label, qty })
													})
												)
											: sequenced.read("items", (d) =>
													query(Shop)
														.rule((r) => {
															const { id, label, qty } = v(Item, "item")
															return r
																.match(d.added(Item), { id, label, qty })
																.find({ side: "added", id, label, qty })
														})
														.rule((r) => {
															const { id, label, qty } = v(Item, "item")
															return r
																.match(d.removed(Item), { id, label, qty })
																.find({ side: "removed", id, label, qty })
														})
												)
								const facts = {
									insert: { Seat: written.seats, Item: written.items },
									put: { Stock: written.puts },
									delete: { Stock: written.deletes }
								}
								const params: ParamMap =
									second === undefined
										? {}
										: {
												seats: second.seats,
												items: second.items,
												puts: second.puts,
												deletes: second.deletes
											}
								const loaded = yield* loadWithTables({ changes })
								const change = member(loaded.members, "changes")
								const explains = memberExplains(context, loaded.tables, change)
								assertVariant(
									explains,
									"kind",
									"change",
									"a ChangeSet of array members explains with its call's facts"
								)
								const before = yield* state()
								const plans = yield* observe(tap, explains.explain({ params, facts }))
								const after = yield* state()
								assert.deepEqual(
									exactValue(after, before),
									Option.none(),
									"explain executes nothing"
								)
								for (const plan of plans.value) {
									estimateOnly(plan.plan)
									readsWithin(plan.plan, footprint, tableOf, indexes)
								}
								const calls = memberCalls(context, change)
								assertVariant(
									calls,
									"shape",
									"write",
									"a ChangeSet of array members takes its call's facts"
								)
								const applied = yield* observe(
									tap,
									Effect.result(writeAnswerOf(calls.once({ params, facts })))
								)
								ofTheServed(
									plans.value,
									plannedStatements(tap, applied.window, context.prologue),
									plannedStatements(tap, plans.window, context.prologue),
									estimating
								)
								if (applied.value._tag === "Failure") {
									notes.note("a refused apply")
								}
								if (c.readBack !== "none") {
									assertVariant(change, "kind", "change", "the changes member is a ChangeSet's")
									const flight = variantOf(context, change.variants).entry.program
									const staged = flightSlotCarriers(flight)
									assert.deepEqual(
										Arr.filter(
											flight.statements,
											(s) => s.step.kind === "carrier" && !staged.has(s.step.carrier)
										),
										[],
										"a read-back rides the statement that makes its delta: every carrier the flight creates is a staged member slot's"
									)
									const naming = textsNaming(flight, staged)
									assert.deepEqual(
										Arr.filter(
											Arr.flatMap(plans.value, (p) =>
												naming.has(p.statement) ? [] : [...planNodes(p.plan)]
											),
											(n) => n.on.kind === "carrier"
										),
										[],
										"a read-back rides the statement that makes its delta: no plan reads a carrier but a staged member slot's statements"
									)
									notes.note("a read-back")
								}
								if (c.readBack === "items joined") {
									notes.note("a read-back joining a stored relation")
								}
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "the application of the same call on a tapped session: one plan per plannable statement it sent, under its name, over its text, and the state before it unchanged by the explain; and the catalog's indexes of the footprint's tables"
		},
		show: Formatter.format,
		budget: { runs: 40, steered: 40 },
		kept: [],
		kills: []
	})
