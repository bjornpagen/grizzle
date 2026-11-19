/**
 * The rows an insertion met (README, "Rows an insertion met"), against PostgreSQL 19, at both levels and in every form
 * an insert arbitrates by (write/insert/protocol.ts Arbitration).
 *
 * Four shapes of relation, each twice: K (k, a, b), keyed by k, complete facts with a payload; P (k, a), a pure set; D
 * (id, k, a), its id drawn by uuidv7() and declared keyed by k, a generated addition arbitrated at k with a payload;
 * and E (id, k), the same with none. The role `rc` inserts the four `…rc` relations and nothing else, so generate
 * certifies it READ COMMITTED (the case requires it): each insert is the `returned` form, ON CONFLICT DO SELECT, met
 * rows returned by the arbiter. The role `ser` inserts the four `…ser` relations, which the role `direct` deletes, so
 * it runs SERIALIZABLE: K and P are the `every` form, complete facts met under the transaction snapshot, and D and E the
 * `returned` form with each met row read again under it. Each relation's member inserts its rows and reads back
 * delta.added and delta.met of it, every field: K's and P's an array of them, and D's and E's a query over the call's
 * relation parameter `rows`, whose head leaves the id out, so every row is a generated addition. An array of D's or E's
 * rows would be two insertions, one of the rows that state the id and one of those that leave it out, so its added and
 * met sides would be two statements' and the read-back refused (README "Where a read-back runs").
 *
 * Each case stores up to three facts of one relation and inserts one to three requests into it, each a copy of a
 * stored fact (an exact repeat), a fact at a stored key with another payload, or a fact at a free key, at distinct keys.
 *
 * Properties, per case:
 * - A request at a stored key whose payload differs refuses the call on that key's law, its witness one of those keys,
 *   and the table is unchanged.
 * - Otherwise the call is accepted where it adds a request and unchanged where it adds none, with that count; it reads
 *   back as added exactly the rows it made, their drawn ids as stored, and as met exactly the stored rows at the keys
 *   it repeats, each whole, its id included; and the table holds the stored facts and the ones it made.
 *
 * Oracle: specification, the insertion over the stated rows: an exact repeat meets its stored fact, a differing one
 * refuses its key, any other is added.
 *
 * Features: each relation met, added beside met, unchanged with met rows only, and, where its facts have a payload,
 * refused at a differing key. A witness whose turn aims at a pending one runs a case constructed to reach it.
 */

import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Option } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import {
	aims,
	type Answer,
	answerOf,
	byKey,
	columnsOf,
	drawnRow,
	drawnSetRow,
	drawsId,
	type Fact,
	keyedRow,
	type MetFeature,
	metFeatures,
	metGen,
	metSchema,
	type Name,
	relations,
	type Request,
	type Row,
	sameKey,
	setRow,
	shapes
} from "#test/pg/write/met/met.fixtures.ts"
import { assert, deepEquals } from "#test/support/assert.ts"
import { answered } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { openRig } from "#test/support/schedules/rig.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * The rows an insertion met are read back whole, beside the rows it made, at both levels and in every form.
 *
 * Its pre-conversion budget: runs 400, coverage cases 400 (test/pg/write/met/met.test.ts at d8eed1786).
 */
export const theRowsAnInsertionMetAreReadBackWholeBesideTheRowsItMadeAtBothLevelsAndInEveryForm =
	property.explore(aimed(metGen, aims), {
		needs: { substrate: Substrate.installing },
		situations: metFeatures satisfies ReadonlyArray<Reached<MetFeature>>,
		check:
			({ substrate }, k: Case<MetFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const rig = yield* openRig(metSchema)
						const tables = namesOf(rig.installed)
						const rc = yield* rig.servedWriter(
							"rc",
							(context) => openServed(rig.served.roles.rc, {}).pipe(Effect.provideContext(context)),
							(db) =>
								db.workload.Krc.once({ params: {}, facts: { insert: { Krc: [] } } }).pipe(answered)
						)
						const ser = yield* rig.servedWriter(
							"ser",
							(context) =>
								openServed(rig.served.roles.ser, {}).pipe(Effect.provideContext(context)),
							(db) =>
								db.workload.Kser.once({ params: {}, facts: { insert: { Kser: [] } } }).pipe(
									answered
								)
						)
						assert.equal(rc.ctx.isolation, "readCommitted", "generate certifies rc READ COMMITTED")
						assert.equal(
							ser.ctx.isolation,
							"serializable",
							"ser, beside a deleter of its relations, runs SERIALIZABLE"
						)
						const columnOf = (n: Name, field: string): string =>
							quoteIdent(tables.columnIdent(relations[n], field))
						/** A relation's stored rows, each read as text and then as a Row, in key order. */
						const stateOf = (n: Name) => {
							const { shape } = shapes[n]
							const fields = columnsOf(n)
							return Effect.map(
								s.admin.queryValues(
									`SELECT ${Arr.join(
										Arr.map(fields, (c) => `${columnOf(n, c)}::text`),
										", "
									)} FROM ${tables.table(relations[n])}`,
									[]
								),
								(rows) =>
									Arr.sort(
										Arr.map(rows, (row): Row => {
											const value = (field: string): Option.Option<string> =>
												Option.flatMap(
													Arr.findFirstIndex(fields, (f) => f === field),
													(i) => Option.map(Arr.get(row, i), String)
												)
											const number = (field: string): number =>
												Option.getOrElse(Option.map(value(field), Number), () => 0)
											return {
												k: number("k"),
												a: number("a"),
												b: number("b"),
												id: drawsId(shape) ? value("id") : Option.none()
											}
										}),
										byKey
									)
							)
						}
						/** The call of relation `n`'s member with its requests, every row the shape states. */
						const call = (n: Name, facts: ReadonlyArray<Fact>): Effect.Effect<Answer> => {
							const keyed = Arr.map(facts, (f) => ({ k: f.k, a: f.a, b: f.b }))
							const set = Arr.map(facts, (f) => ({ k: f.k, a: f.a }))
							const drawnSet = Arr.map(facts, (f) => ({ k: f.k }))
							switch (n) {
								case "Krc":
									return answerOf(
										n,
										rc.db.workload.Krc.once({ params: {}, facts: { insert: { Krc: keyed } } }).pipe(
											answered
										),
										keyedRow
									)
								case "Prc":
									return answerOf(
										n,
										rc.db.workload.Prc.once({ params: {}, facts: { insert: { Prc: set } } }).pipe(
											answered
										),
										setRow
									)
								case "Drc":
									return answerOf(
										n,
										rc.db.workload.Drc.once({ params: { rows: set }, facts: {} }).pipe(answered),
										drawnRow
									)
								case "Erc":
									return answerOf(
										n,
										rc.db.workload.Erc.once({ params: { rows: drawnSet }, facts: {} }).pipe(
											answered
										),
										drawnSetRow
									)
								case "Kser":
									return answerOf(
										n,
										ser.db.workload.Kser.once({
											params: {},
											facts: { insert: { Kser: keyed } }
										}).pipe(answered),
										keyedRow
									)
								case "Pser":
									return answerOf(
										n,
										ser.db.workload.Pser.once({
											params: {},
											facts: { insert: { Pser: set } }
										}).pipe(answered),
										setRow
									)
								case "Dser":
									return answerOf(
										n,
										ser.db.workload.Dser.once({ params: { rows: set }, facts: {} }).pipe(answered),
										drawnRow
									)
								case "Eser":
									return answerOf(
										n,
										ser.db.workload.Eser.once({ params: { rows: drawnSet }, facts: {} }).pipe(
											answered
										),
										drawnSetRow
									)
							}
						}

						const { shape } = shapes[c.relation]
						const stated = Arr.filter(columnsOf(c.relation), (col) => col !== "id")
						const valueOf = (f: Fact, col: string): number =>
							col === "k" ? f.k : col === "a" ? f.a : f.b
						yield* rig.replace(
							Arr.isReadonlyArrayNonEmpty(c.stored)
								? [
										`INSERT INTO ${tables.table(relations[c.relation])} (${Arr.join(
											Arr.map(stated, (col) => columnOf(c.relation, col)),
											", "
										)}) VALUES ${Arr.join(
											Arr.map(
												c.stored,
												(f) =>
													`(${Arr.join(
														Arr.map(stated, (col) => String(valueOf(f, col))),
														", "
													)})`
											),
											", "
										)}`
									]
								: []
						)
						const before = yield* stateOf(c.relation)
						const answer = yield* call(
							c.relation,
							Arr.map(c.requests, (r) => r.fact)
						)
						const after = yield* stateOf(c.relation)
						const at = (rows: ReadonlyArray<Row>, requests: ReadonlyArray<Request>) =>
							Arr.filter(rows, (row) => Arr.some(requests, (r) => sameKey(shape, row, r.fact)))
						const differing = Arr.filter(c.requests, (r) => r.kind === "differing")
						if (Arr.isReadonlyArrayNonEmpty(differing)) {
							assert.ok(
								answer.kind === "refused",
								`a differing request refuses the call: ${Formatter.format(answer)}`
							)
							const witness = answer.witness
							assert.ok(
								witness.kind === "key" &&
									Arr.some(differing, (r) => deepEquals(witness.values, { k: r.fact.k })),
								`the witness is one of the differing keys: ${Formatter.format(witness)}`
							)
							assert.deepEqual(after, before, "a refused call changes nothing")
							k.note(`${c.relation}: refused at a differing key`)
							return
						}
						assert.ok(answer.kind === "committed", `the call commits: ${Formatter.format(answer)}`)
						const repeats = Arr.filter(c.requests, (r) => r.kind === "repeat")
						const free = Arr.filter(c.requests, (r) => r.kind === "free")
						assert.equal(
							answer.outcome,
							Arr.isReadonlyArrayNonEmpty(free) ? "accepted" : "unchanged",
							"accepted where it adds a request, unchanged otherwise"
						)
						assert.equal(answer.added, BigInt(free.length), "its count is the requests it adds")
						assert.deepEqual(
							Arr.sort(answer.addedRows, byKey),
							at(after, free),
							"added: exactly the rows it made, their drawn ids as stored"
						)
						assert.deepEqual(
							Arr.sort(answer.metRows, byKey),
							at(before, repeats),
							"met: exactly the stored rows it repeats, each whole"
						)
						assert.deepEqual(
							Arr.filter(after, (row) => !Arr.some(free, (r) => sameKey(shape, row, r.fact))),
							before,
							"the stored rows stay as they are"
						)
						if (Arr.isReadonlyArrayNonEmpty(repeats)) {
							k.note(`${c.relation}: met`)
							k.note(
								Arr.isReadonlyArrayNonEmpty(free)
									? `${c.relation}: added beside met`
									: `${c.relation}: unchanged, met only`
							)
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the insertion over the stated rows: an exact repeat meets its stored fact, a differing one refuses its key, any other is added"
		},
		budget: { runs: 400, steered: 400 },
		kept: [],
		kills: []
	})
