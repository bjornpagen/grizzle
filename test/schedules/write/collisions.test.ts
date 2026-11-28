/**
 * Two writers of one certified READ COMMITTED role collide on an addition's keys, and each call answers as some serial
 * order does.
 *
 * Sitting(child, test, attempt, note, slot) is keyed by (child, test, attempt), its natural identity and its primary
 * key, the insert's arbiter, and by slot, a unique object besides it. The role `learner` holds Sitting and Gate by its
 * insert list alone, and its workload is `start`, an insertion of sittings, and `held`, an insertion of sittings and
 * then, in a later stratum, of a Gate row, each in two forms, drawn per case: the sittings an array of the call's
 * facts, or a query over the call's relation parameter `sittings`, as edullm's Start inserts its sitting, reading back
 * the sittings it added and the stored sittings it met (`startRead`, `heldRead`). The schema and its logins are installed and served as `grizzle generate` drafts them (schedules/rig.ts openRig):
 * `learner` runs at the level generate certifies, which the case requires to be READ COMMITTED, read off each
 * writer's served Db.
 *
 * Two writers A and B, two Dbs of `learner` over DbLayers of their own, run one call each over a stored state. In
 * `concurrent`, the schema's owner holds Gate in SHARE mode, which writes nothing, while A runs `held`: A's sittings
 * are written and uncommitted when its Gate insert waits on that lock (the lock barrier sees A blocked by the owner),
 * and B runs `start` then; the owner's COMMIT lets A finish. In `sequential`, A's call commits before B's begins. A
 * call the model refuses runs alone.
 *
 * Properties, per case:
 * - B waits for A exactly where it meets a row A holds uncommitted: at the arbiter, or at slot with its arbiter key
 *   free, unless a visible occupant refuses B's statement first; whether B's backend waited on A's is read from
 *   pg_locks until B's call ends, so a wait the model does not predict, and one it predicts that never comes, fails
 *   the case where it happens.
 * - Each call answers what the serial order A, then B, answers:
 *   - an exact repeat at the arbiter key, a row equal at every field, is no change, and a query member's call reads
 *     that stored row back whole through delta.met, a row in flight it waited for included, on the first try;
 *   - a differing row at the arbiter key refuses the key (child, test, attempt), its witness that key;
 *   - a row at slot with the arbiter key free refuses slot: by the probe, its witness the requested slot, where the
 *     statement's snapshot sees the occupant; otherwise by PostgreSQL's 23505 after the wait, a typed refusal on slot's
 *     law, never an abort or a defect, its witness the stated slot where an array states one distinct slot value, and
 *     `unreported` where it states several or the rows are a query's, which the host does not hold;
 *   - every other request is inserted, and a call that inserts any row is accepted with that count, a query member's
 *     reading back through delta.added exactly the rows it made.
 * - The table ends as the serial order leaves it: one row per key.
 *
 * Oracle: the serial model below, over the stated rows alone. The probe's refusal, both arbiter waits, every 23505
 * witness and both met rows read back are required features, among every other kind of answer; a witness whose turn
 * aims at a pending one that depends on the form or on two of B's requests runs a case constructed to reach it
 * (`aims`).
 */

import { assert, deepEquals, defined } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import { lawsByStatement, lawsOf } from "#compiler/program/laws.ts"
import { sameLaw } from "#compiler/public/changeset.ts"
import type { Law } from "#compiler/types/changeset/changeset.ts"
import {
	addedTo,
	aims,
	byKey,
	type CollisionFeature,
	collisionGen,
	collisions,
	type Expected,
	type Form,
	Gate,
	judge,
	type KeyName,
	plainSittings,
	type Ran,
	read,
	type Request,
	requestRows,
	sameKey,
	Sitting,
	slotKey,
	statedFields,
	storedSitting,
	textOf,
	unread,
	doubleStartAims,
	collisionsRig
} from "#test/schedules/write/collisions.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Colliding additions of a certified READ COMMITTED role answer as the serial order does.
 *
 * Its pre-conversion budget: runs 400, coverage cases 400 (test/schedules/write/collisions.test.ts at d8eed1786).
 */
export const collidingAdditionsOfACertifiedREADCOMMITTEDRoleAnswerAsTheSerialOrderDoes =
	property.explore(aimed(collisionGen, [...aims, ...doubleStartAims]), {
		needs: { rigged: Substrate.fresh(collisionsRig) },
		situations: [
			"an exact repeat of a row in flight, after waiting",
			"a differing row at the arbiter key in flight, refused after waiting",
			"a 23505 at slot after waiting, its stated slot the witness",
			"a 23505 at slot after waiting, unreported among several slots",
			"a 23505 at slot after waiting, unreported for a query's rows",
			"an exact repeat of a visible row",
			"a row in flight met, read back",
			"a visible row met, read back",
			"a differing row at a visible arbiter key",
			"a visible occupant at slot, refused by the probe",
			"an insert after waiting for a row in flight",
			"an insert without waiting"
		] satisfies ReadonlyArray<Reached<CollisionFeature>>,
		check:
			({ rigged }, k: Case<CollisionFeature>) =>
			(c) =>
				Effect.scoped(
					Effect.flatMap(rigged, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const rig = yield* rigIn(taken, collisions)
								const names = namesOf(rig.installed)
								const S = rig.worlds.schema
								const laws: { readonly [K in KeyName]: Law } = {
									sitting: defined(
										Option.getOrUndefined(
											Arr.findFirst(
												Arr.map(lawsOf(S), (l) => l.law),
												(l) => l.kind === "primaryKey" && l.relation === "Sitting"
											)
										),
										"the sitting key's law, Sitting's primary key's"
									),
									slot: defined(lawsByStatement(S)(slotKey)[0], "the slot key's law")
								}
								const sittings = names.table(Sitting)
								const gate = names.table(Gate)
								const column = (field: (typeof statedFields)[number]) =>
									names.column(Sitting, field)
								const open = (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
									openServed(rig.served.roles.learner, {}).pipe(Effect.provideContext(context))
								const a = yield* rig.servedWriter("a", open, (db) =>
									writeAnswerOf(
										db.workload.start.once({ params: {}, facts: { insert: { Sitting: [] } } })
									)
								)
								const b = yield* rig.servedWriter("b", open, (db) =>
									writeAnswerOf(
										db.workload.start.once({ params: {}, facts: { insert: { Sitting: [] } } })
									)
								)
								assert.equal(
									a.ctx.isolation,
									"readCommitted",
									"generate certifies learner READ COMMITTED"
								)
								assert.equal(
									b.ctx.isolation,
									"readCommitted",
									"generate certifies learner READ COMMITTED"
								)
								const { holder } = yield* openActors(s, {
									holder: { kind: "raw", as: rig.installed.ambientOwner.credentials }
								})
								const holderPid = holder.pid
								const stateQuery = `SELECT ${Arr.join(
									Arr.map(statedFields, (f) => `${column(f)}::text`),
									", "
								)} FROM ${sittings} ORDER BY 1, 2, 3`
								const state = Effect.map(s.admin.queryValues(stateQuery, []), (rows) =>
									Arr.map(rows, (row) => Arr.map(row, textOf))
								)
								/**
								 * Where a call's answer departs from its expectation, why; none where it is the expected one. An answer that
								 * inserts reads back as added exactly the stored rows at the keys it inserted at, and as met exactly the stored
								 * rows at the keys it repeats, each whole (`final`, the table's last state, every
								 * stored row of which is fixed once committed).
								 */
								const departure = (
									ran: Ran,
									expected: Expected,
									label: string,
									final: ReadonlyArray<ReadonlyArray<string>>
								): string | undefined => {
									if (expected.kind === "inserted") {
										if (
											!(
												Result.isSuccess(ran) &&
												ran.success._tag !== "refused" &&
												ran.success._tag !== "outsideWorld" &&
												(expected.rows.length === 0
													? ran.success._tag === "unchanged" ||
														addedTo(ran.success, "Sitting") === 0n
													: addedTo(ran.success, "Sitting") === BigInt(expected.rows.length))
											)
										) {
											return `${label} adds every free request, ${expected.rows.length}: ${Formatter.format(ran)}`
										}
										const at = (requests: ReadonlyArray<Request>) =>
											plainSittings(
												Arr.filter(Arr.map(final, storedSitting), (s) =>
													Arr.some(requests, (r) => sameKey(r, s))
												)
											)
										const reads = ran.success.reads
										if (Option.isNone(reads)) {
											return undefined
										}
										const added = plainSittings(reads.value.added)
										const met = plainSittings(reads.value.met)
										return deepEquals(added, at(expected.rows)) && deepEquals(met, at(expected.met))
											? undefined
											: `${label} reads back as added the rows it made, ${Formatter.format(at(expected.rows))}, and as met the stored rows it repeats, ${Formatter.format(at(expected.met))}: added ${Formatter.format(added)}, met ${Formatter.format(met)}`
									}
									if (Result.isFailure(ran) || ran.success._tag !== "refused") {
										return `${label} is a typed refusal of ${expected.law}, never an abort or a defect: ${Formatter.format(ran)}`
									}
									const outcome = ran.success
									const [refused, ...more] = refusedEntries(outcome.refused)
									if (more.length > 0 || !sameLaw(refused.law, laws[expected.law])) {
										return `${label} refuses ${expected.law} alone: ${Formatter.format(outcome.refused)}`
									}
									return Arr.some(expected.witnesses, (w) => deepEquals(outcome.witness, w))
										? undefined
										: `${label}'s witness ${Formatter.format(outcome.witness)} is one of ${Formatter.format(expected.witnesses)} (${expected.path})`
								}
								/**
								 * Whether a call's backend `waiter` waited for `holder` before the call ended, polled from the admin session
								 * until its fiber ends or pg_locks shows it blocked by `holder`: a wait that never comes ends the poll with
								 * the call, so it fails the case where it happens, never by the hang guard. Each backend is read at every
								 * poll, a grizzle actor's being the connection its call holds then, none before it leases one.
								 */
								const waitedOrEnded = (
									fiber: Fiber.Fiber<Ran>,
									waiter: Effect.Effect<Option.Option<number>>,
									holder: Effect.Effect<Option.Option<number>>
								) =>
									Effect.gen(function* () {
										for (;;) {
											if (fiber.pollUnsafe() !== undefined) {
												return "ended" as const
											}
											const backends = Option.all([yield* waiter, yield* holder])
											if (Option.isSome(backends)) {
												const [waiting, holding] = backends.value
												const wait = yield* lockWaitOf(s.admin, waiting)
												if (wait?.blockedBy.includes(holding) === true) {
													return "waited" as const
												}
											}
											yield* Effect.yieldNow
										}
									})
								const held = (form: Form, rows: ReadonlyArray<Request>): Effect.Effect<Ran> =>
									Effect.result(
										form === "array"
											? Effect.map(
													writeAnswerOf(
														a.db.workload.held.once({
															params: {},
															facts: { insert: { Sitting: requestRows(rows), Gate: [{ n: 0 }] } }
														})
													),
													unread
												)
											: Effect.map(
													writeAnswerOf(
														a.db.workload.heldRead.once({
															params: { sittings: requestRows(rows) },
															facts: { insert: { Gate: [{ n: 0 }] } }
														})
													),
													read
												)
									)
								const start = (form: Form, rows: ReadonlyArray<Request>): Effect.Effect<Ran> =>
									Effect.result(
										form === "array"
											? Effect.map(
													writeAnswerOf(
														b.db.workload.start.once({
															params: {},
															facts: { insert: { Sitting: requestRows(rows) } }
														})
													),
													unread
												)
											: Effect.map(
													writeAnswerOf(
														b.db.workload.startRead.once({
															params: { sittings: requestRows(rows) },
															facts: {}
														})
													),
													read
												)
									)

								yield* rig.replace(
									c.stored.length === 0
										? []
										: [
												`INSERT INTO ${sittings} (${Arr.join(
													Arr.map(statedFields, column),
													", "
												)}) VALUES ${Arr.join(
													Arr.map(
														c.stored,
														(r) => `(${r.child}, ${r.test}, ${r.attempt}, ${r.note}, ${r.slot})`
													),
													", "
												)}`
											]
								)
								const first = judge(c.form, c.a, c.stored, [])
								/** The sittings A's call makes, as the model has it. */
								const madeByA = first.expected.kind === "inserted" ? first.expected.rows : []
								const afterA = [...c.stored, ...madeByA]
								const together = c.mode === "concurrent" && first.expected.kind === "inserted"
								if (together) {
									yield* holder.perform({ _tag: "Begin" })
									yield* holder.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
								}
								const fiberA = yield* Effect.forkChild(held(c.form, c.a), {
									startImmediately: true
								})
								/** In `concurrent`, A reaches Gate holding its sittings, or ends before it, which departs. */
								const atGate = together
									? yield* waitedOrEnded(fiberA, a.actor.backend, Effect.succeedSome(holderPid))
									: "ended"
								const ranA = atGate === "ended" ? yield* Fiber.join(fiberA) : undefined
								const holding = together && atGate === "waited"
								const second = holding
									? judge(c.form, c.b, c.stored, madeByA)
									: judge(c.form, c.b, afterA, [])
								const fiberB = yield* Effect.forkChild(start(c.form, c.b), {
									startImmediately: true
								})
								const observed = holding
									? yield* waitedOrEnded(fiberB, b.actor.backend, a.actor.backend)
									: "ended"
								if (together) {
									yield* holder.perform({ _tag: "Commit" })
								}
								const ranHeld = ranA ?? (yield* Fiber.join(fiberA))
								const ranB = yield* Fiber.join(fiberB)
								const final = yield* state
								const departures = Arr.filter(
									[
										together && !holding
											? "A ended before its Gate insert, where the model has it write its sittings and wait at Gate"
											: undefined,
										departure(ranHeld, first.expected, "A", final),
										departure(ranB, second.expected, "B", final),
										holding && (observed === "waited") !== second.waits
											? `B ${second.waits ? "ended without waiting for A, where it meets a row A holds" : "waited for A, where it meets none of A's rows"}`
											: undefined
									],
									(d) => d !== undefined
								)
								assert.deepEqual(departures, [], "each call answers as the serial order does")
								k.noteAll(first.features)
								k.noteAll(second.features)
								const after = afterA.concat(
									second.expected.kind === "inserted" ? second.expected.rows : []
								)
								assert.deepEqual(
									final,
									Arr.map(Arr.sort(after, byKey), (r) =>
										Arr.map([r.child, r.test, r.attempt, r.note, r.slot], String)
									),
									"the table holds what the serial order leaves"
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "the serial order A, then B, over the stated rows: repeat, key refusal, slot refusal or insert"
		},
		budget: { runs: 400, steered: 400 },
		kept: [],
		kills: []
	})
