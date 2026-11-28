/**
 * An insert's computed fields hold the call's one value of each in every row the call writes, on PostgreSQL 19: an
 * insert's host rows leave out the fields it computes (ChangeSet.insertAllComputed), each a term over the call's
 * parameters and its reading of the database's clock, and the statement that writes the rows evaluates the record once,
 * one MATERIALIZED CTE of a row (write/insert/stamp.ts callValuesCte), which every row joins: a plain insert's own
 * statement (stampedInput), a nested insert's family statement, its owner's rows and every member that carries a computed
 * field of its owner's key, to any depth (write/family/additions.ts stampedSources).
 *
 * Computed holds Lease(id, until), no family; Flat(q, due, until, items) keyed (q, due), `held` generated over its
 * `until`, its ordered items FlatItem(q, due, at, v, cu) carrying (q, due) and copying its `until` along the owner axis
 * at `cu`; and Deep, as Flat, its items DeepItem(q, due, at, v, parts) nesting
 * DeepPart(q, due, at, bt, w), every member carrying (q, due). Its full world's login serves `lease`, `flat` and
 * `deep`, each clocked in micros: an insert of its depth's owner from the call's rows, `until` computed as the reading
 * plus `budget`, and an owner's `due` as the reading plus `delay`, each a Span, a contract bounded by its predicate,
 * under a guard into bigint; each reads the reading back, `now`, in its transaction. The schema is installed and served
 * as `grizzle generate` drafts it, once per member, each case on a clone of that installation of its own.
 *
 * Property, per case: the call of its depth's member over one to three owners, each nesting none, one or two items,
 * each of a Deep's items none, one or two parts, is accepted; its read-back holds one reading R; and the tables hold
 * exactly the call's rows, every owner's `until` R + budget and `due` R + delay, and every member's `due` its owner's,
 * R + delay, at every depth, a Flat's `held` and each of its items' `cu` its `until`; or, where a Flat's or a Deep's
 * queues start at 0, Listed or Queued refuses the call, witnessed by that owner's queue and its `due` named as the
 * database's clock's (Witness `drawn`), since the host holds no reading of the clock, which the statement reads as
 * transaction_timestamp, one value a call: never `unreported` and never a value guessed, a Flat's too, whose `held` is
 * generated over its clocked `until`, which the host cannot evaluate, and whose NOT NULL the CHECK's refusal proves
 * held. Oracle: the rule, every row of a call holds the call's one value
 * of each computed field, stated over the call's rows and its read-back reading, and a key the database supplies a field
 * of is named by its source.
 *
 * Kills: the database's clock read as clock_timestamp(), the instant a statement evaluates it, so the computed values
 * are no reading of the call's transaction and differ from the read-back's; the computed fields left to the host,
 * whose rows state none, so each call is refused as its rows' encoding; a computed field the host does not evaluate
 * left unnamed, so the clocked key's refusal is `unreported`; and the clock's term named the call's.
 *
 * Features: each depth, several owners in one call, an owner nesting no member, a member nesting parts, a Flat at queue
 * 0, a Deep at queue 0.
 *
 * A key over a computed field: Slot(env, at, v) keyed (env, at), its insert computing `at` as the call's parameter `t`
 * cast into Span, den's served rows' (environment, at). Every row of one call holds the call's one `at`, which the host
 * never holds, so the host compares a call's rows at their environment alone, two rows of one environment and two
 * values two facts of one key, and leaves a stored fact at the key to the statement's arbiter (write/normalize
 * normalize.ts computedChecks, runtime/write/normalize.ts KeyCompares). Property, per case: one or two calls of `slot`
 * in sequence, each of one to three rows, few environments, values and parameters; each call is refused at Slot's
 * primary key exactly when two of its distinct rows share an environment or one meets a stored fact of its key with
 * another value, and otherwise accepted, or unchanged when every row repeats a stored fact; after each call Slot holds
 * exactly the model's rows. Oracle: the model, every row holding the call's `t` at `at` and the key compared as the
 * table holds it (`slotAnswer`). Kills: the group's host checks the relation's own, which read `at` off host rows
 * that hold none, a defect at the call; and the inserted facts compared at no key of the computed field, so two rows of
 * one call at one environment reach the statement, which trusts the host's normalization and meets them at its own
 * index.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Order, Record as Rec } from "effect"
import { Db } from "#adapter/public/db.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { printObjectName } from "#compiler/sql/print.ts"
import {
	Computed,
	type ComputedFeature,
	computedFeatures,
	computedInstall,
	computedTemplate,
	type Computing,
	computingGen,
	situations,
	slotAnswer,
	type SlotFeature,
	slotFeatures,
	type SlotRow,
	slotSituations,
	slottingGen,
	toSpan,
	unqueuedOf
} from "#test/pg/write/computed/computed.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { openedIn } from "#test/support/pg/reads/support.ts"
import { refusedLaws } from "#test/support/refused.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { withLayer } from "#test/support/with-layer.ts"

/** Rows as the tables hold them, each a record of its fields' texts read as bigints, in key order. */
type Stored = ReadonlyArray<Readonly<Record<string, bigint>>>

/** The rows of `c` each table of its depth holds, given the call's reading `now`: the rule. */
const expectedOf = (c: Computing, now: bigint): Readonly<Record<string, Stored>> => {
	const due = now + c.delay
	const until = now + c.budget
	const owners = Arr.map(c.owners, (o) => ({ q: BigInt(o.q), due, until }))
	const items = Arr.flatMap(c.owners, (o) =>
		Arr.map(o.items, (item, at) => ({ q: BigInt(o.q), due, at: BigInt(at), v: BigInt(item.v) }))
	)
	switch (c.depth) {
		case 0:
			return { Lease: Arr.map(c.owners, (o) => ({ id: BigInt(o.q), until })) }
		case 1:
			return {
				Flat: Arr.map(owners, (o) => ({ ...o, held: until })),
				FlatItem: Arr.map(items, (item) => ({ ...item, cu: until }))
			}
		case 2:
			return {
				Deep: owners,
				DeepItem: items,
				DeepPart: Arr.flatMap(c.owners, (o) =>
					Arr.flatMap(o.items, (item, at) =>
						Arr.map(item.parts, (w, bt) => ({
							q: BigInt(o.q),
							due,
							at: BigInt(at),
							bt: BigInt(bt),
							w: BigInt(w)
						}))
					)
				)
			}
	}
}

/** The fields each table of the schema is read back by, its key first. */
const fieldsOf: Readonly<Record<string, ReadonlyArray<string>>> = {
	Lease: ["id", "until"],
	Flat: ["q", "due", "until", "held"],
	FlatItem: ["q", "due", "at", "v", "cu"],
	Deep: ["q", "due", "until"],
	DeepItem: ["q", "due", "at", "v"],
	DeepPart: ["q", "due", "at", "bt", "w"]
}

/** Every row an insert computes a field of holds the call's one value of it, its owner and every member alike, at every depth. */
export const everyRowOfACallHoldsItsOneValueOfEachComputedFieldTheOwnerAndEveryMemberAlikeAtEveryDepth =
	property.explore(computingGen, {
		needs: { fixture: Substrate.fresh(computedTemplate) },
		situations,
		check:
			({ fixture }, k: Case<ComputedFeature>) =>
			(c) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							k.noteAll(computedFeatures(c))
							const s = yield* Substrate
							const o = yield* openedIn(Computed, {}, computedInstall, taken)
							const names = o.installed.installation.names
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								const budget = toSpan(c.budget)
								const delay = toSpan(c.delay)
								const answer = yield* writeAnswerOf(
									c.depth === 0
										? db.workload.lease.once({
												params: { budget },
												facts: { insert: { Lease: Arr.map(c.owners, (w) => ({ id: w.q })) } }
											})
										: c.depth === 1
											? db.workload.flat.once({
													params: { budget, delay },
													facts: {
														insert: {
															Flat: Arr.map(c.owners, (w) => ({
																q: w.q,
																items: Arr.map(w.items, (i) => ({ v: i.v }))
															}))
														}
													}
												})
											: db.workload.deep.once({
													params: { budget, delay },
													facts: {
														insert: {
															Deep: Arr.map(c.owners, (w) => ({
																q: w.q,
																items: Arr.map(w.items, (i) => ({
																	v: i.v,
																	parts: Arr.map(i.parts, (p) => ({ w: p }))
																}))
															}))
														}
													}
												})
								)
								const unqueued = unqueuedOf(c)
								if (unqueued !== undefined) {
									assert.deepEqual(
										"witness" in answer ? answer.witness : undefined,
										{
											kind: "drawn",
											relation: unqueued.relation,
											values: { q: unqueued.q },
											drawn: { due: "clock" }
										},
										`${unqueued.relation === "Flat" ? "Listed" : "Queued"} refuses the ${unqueued.relation} at queue 0, its witness that owner's queue and its due, the call's reading of the database's clock plus its delay, named as the clock's, never a value guessed, whatever its generated fields over the clock: ${Formatter.format(answer)}`
									)
									return
								}
								if (answer.kind !== "accepted") {
									return assert.fail(`the call is accepted, not ${answer.kind}`)
								}
								const read = answer.reads.reading
								assert.equal(read.length, 1, "the call reads its reading back once")
								const now = Arr.getUnsafe(read, 0).now
								const expected = expectedOf(c, now)
								for (const [table, rows] of Rec.toEntries(expected)) {
									const fields = fieldsOf[table] ?? []
									const stored = yield* s.admin.queryValues(
										`SELECT ${Arr.join(
											Arr.map(fields, (f) => `${quoteIdent(names.column(table, f))}::text`),
											", "
										)} FROM ${printObjectName(names.relation(table))} ORDER BY ${Arr.join(
											Arr.map(fields, (_, i) => String(i + 1)),
											", "
										)}`,
										[]
									)
									assert.deepEqual(
										Arr.map(stored, (row) =>
											Rec.fromEntries(
												Arr.map(fields, (f, i) => [f, BigInt(String(row[i]))] as const)
											)
										),
										Arr.sort(
											rows,
											Order.mapInput(
												Order.Array(Order.BigInt),
												(r: Readonly<Record<string, bigint>>) => Arr.map(fields, (f) => r[f] ?? 0n)
											)
										),
										`${table} holds the call's rows, each computed field the reading ${now} plus its span`
									)
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "README's Writes: every row of a call holds the call's one value of each field its insert computes"
		},
		kept: [
			{
				token: ReplayToken(
					"test/pg/write/computed/computed.test.ts#everyRowOfACallHoldsItsOneValueOfEachComputedFieldTheOwnerAndEveryMemberAlikeAtEveryDepth:7f.1:2.0.0.0.0.0"
				),
				reason:
					"A clocked computed key refused: one Deep at queue 0, its key's due the call's reading of the database's clock plus a delay of 0. Queued refused it and the host found the row, `every`, but named no witness, `unreported`, since no host value holds the clock's reading, where main's ruling names the field as the clock's (after 2dfb79c4)",
				since: "2026-11-27"
			},
			{
				token: ReplayToken(
					"test/pg/write/computed/computed.test.ts#everyRowOfACallHoldsItsOneValueOfEachComputedFieldTheOwnerAndEveryMemberAlikeAtEveryDepth:ff.0:1.0.0.0.0.0"
				),
				reason:
					"A Flat at queue 0 refused by Listed, its held generated over its until, the call's reading of the database's clock plus a budget of 0, which the host cannot evaluate: the host left Listed's verdict unjudged for its generated NOT NULL and named no witness, `unreported`, where the CHECK's refusal proves the NOT NULL held and the witness is its queue and its due drawn by the clock (after 6d3eee35)",
				since: "2026-11-27"
			}
		],
		kills: [
			{
				file: "packages/engine/src/sql/print.ts",
				original: '"transaction_timestamp"',
				replacement: '"clock_timestamp"',
				why: "The clock is read when a statement evaluates it, not when the call's transaction began: the computed values are the instant the write's statement ran, which the read-back's later statement does not read, so no row holds the reading plus its span."
			},
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original: "\t\tconst computed = strataComputed[s]?.get(relation)\n",
				replacement: "\t\tconst computed = strataComputed[s + 1]?.get(relation)\n",
				why: "No insert computes a field, so its host rows must state every one: the call's rows, which leave the computed fields out, are refused as their encoding, and no call is accepted."
			},
			{
				file: "packages/engine/src/runtime/write/bind.ts",
				original: "\t\t\t\tdrawn.set(field.name, field.source)",
				replacement: "\t\t\t\tvoid field.source",
				why: "A computed field the host does not evaluate is left unnamed, as before main's ruling on the clocked key: Queued's refusal of the Deep at queue 0, whose key's due the database's clock supplies, is witnessed `unreported`."
			},
			{
				file: "packages/engine/src/write/program/decide.ts",
				original: '\t\t\t\t\t\t? ("clock" as const)\n\t\t\t\t\t\t: ("call" as const)',
				replacement: '\t\t\t\t\t\t? ("call" as const)\n\t\t\t\t\t\t: ("call" as const)',
				why: "A computed field that reads the call's clock is named as the statement's term, not the clock's: the Deep's due, the database's clock reading plus its delay, is witnessed drawn by the call."
			},
			{
				file: "packages/engine/src/runtime/write/witness.ts",
				original:
					'\t\t\tjudgedGeneration(field) !== undefined && reading.generated(field.name).kind === "null"',
				replacement:
					'\t\t\tjudgedGeneration(field) !== undefined && reading.generated(field.name).kind !== "value"',
				why: "A generated field the host cannot evaluate is read as its NOT NULL refusing its row, as before main's ruling on the generated field over a drawn value: Listed's refusal of the Flat at queue 0, whose held is generated over its until, the database's clock reading plus its budget, finds no row and is witnessed `unreported`."
			}
		]
	})

/** Slot's rows in key order. */
const bySlotKey = Order.combineAll([
	Order.mapInput(Order.Number, (r: SlotRow) => r.env),
	Order.mapInput(Order.BigInt, (r: SlotRow) => r.at),
	Order.mapInput(Order.Number, (r: SlotRow) => r.v)
])

/** An insert that computes a field of its relation's primary key is judged at the key as the table holds its rows. */
export const anInsertComputingAKeyFieldIsJudgedAtTheKeyAsTheTableHoldsTheRowsItWrites =
	property.explore(slottingGen, {
		needs: { fixture: Substrate.fresh(computedTemplate) },
		situations: slotSituations,
		check:
			({ fixture }, k: Case<SlotFeature>) =>
			(c) =>
				Effect.flatMap(fixture, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							k.noteAll(slotFeatures(c))
							const s = yield* Substrate
							const o = yield* openedIn(Computed, {}, computedInstall, taken)
							const names = o.installed.installation.names
							const column = (f: string) => quoteIdent(names.column("Slot", f))
							const slotRows = Effect.map(
								s.admin.queryValues(
									`SELECT ${column("env")}::text, ${column("at")}::text, ${column("v")}::text FROM ${printObjectName(
										names.relation("Slot")
									)} ORDER BY 1, 2, 3`,
									[]
								),
								(rows) =>
									Arr.sort(
										Arr.map(rows, (row): SlotRow => ({
											env: Number(String(row[0])),
											at: BigInt(String(row[1])),
											v: Number(String(row[2]))
										})),
										bySlotKey
									)
							)
							return yield* Effect.gen(function* () {
								const db = yield* Db.open(o.served.login.roles.app, {})
								let stored: ReadonlyArray<SlotRow> = []
								for (const [i, call] of c.calls.entries()) {
									const expected = slotAnswer(stored, call)
									const answer = yield* writeAnswerOf(
										db.workload.slot.once({
											params: { t: toSpan(call.t) },
											facts: { insert: { Slot: call.rows } }
										})
									)
									const what = `call ${i} at t ${call.t} of ${Formatter.format(call.rows)} on ${Formatter.format(stored)}`
									if (expected.kind === "refused") {
										assert.ok(
											answer.kind === "refused" &&
												Arr.every(refusedLaws(answer.refused), (l) => l.kind === "primaryKey"),
											`${what}: refused at Slot's primary key, not ${Formatter.format(answer)}`
										)
									} else {
										assert.equal(answer.kind, expected.kind, `${what}: ${Formatter.format(answer)}`)
										stored = Arr.sort([...stored, ...expected.added], bySlotKey)
									}
									const held = yield* slotRows
									assert.deepEqual<ReadonlyArray<SlotRow>>(
										held,
										stored,
										`${what}: Slot holds the model's rows`
									)
								}
							}).pipe(Effect.scoped, withLayer(o.served.layer))
						}).pipe(Effect.scoped),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "second-implementation",
			name: "slotAnswer, a model of Slot's rows: every row of a call holds the call's `t` at `at`, the key compared as the table holds it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/write/frontend/compile.ts",
				original:
					"\t\treturn computed.length === 0\n\t\t\t? relation.host\n\t\t\t: computedChecks(relation.keyLaws, relation.uniques, computed)\n",
				replacement: "\t\treturn relation.host\n",
				why: "The group's host checks are the relation's own, which read every row's `at` off host rows that leave it out: a defect at every call with a row."
			},
			{
				file: "packages/engine/src/write/normalize/normalize.ts",
				original:
					'\t\t\t\tObject.freeze({ ...k, compares: "put" as const }),\n\t\t\t\tObject.freeze({ ...k, fields: held(k.fields), compares: "insert" as const })\n',
				replacement: '\t\t\t\tObject.freeze({ ...k, compares: "put" as const })\n',
				why: "The inserted facts are compared at no key over a computed field: two rows of one call at one environment and two values reach the statement, which trusts the host's normalization of its input and meets the second at its own index, never as Slot's primary key refused."
			}
		]
	})
