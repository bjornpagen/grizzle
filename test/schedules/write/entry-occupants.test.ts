/**
 * A query entry's insertion races a commit at its key: an occupant its snapshot cannot see fails the call with 40001,
 * outside the entry or inside it, never a 42501, and the call's retry answers as the serial order W, then A, does.
 *
 * README, "Rows an insertion met": a role that inserts through a query entry runs at SERIALIZABLE, since the certifier
 * reads its precheck's key probe as a read it states no fact of (write/insert/protocol.ts buildInsert). Its precheck
 * refuses a row outside the entry that the snapshot holds at a key the call states, on the key's law; a row committed
 * after the snapshot fails the call with 40001 before PostgreSQL judges it by any policy (nodeModifyTable.c
 * ExecOnConflictSelect and ExecCheckTIDVisible, PostgreSQL 19, which judge the row's visibility first), a
 * SerializationFailure, and the retry's precheck refuses an outside row on the key's law. At READ COMMITTED,
 * PostgreSQL 19 would judge an outside row by the role's SELECT policy before any WHERE and raise 42501, which is why
 * the certificate's level is part of the contract.
 *
 * Seat(id, team, holder) is keyed by id. The role `holder` inserts MySeat, the seats of the session's subject, and Gate,
 * and nothing else. Its workload is `take`, an insertion of a seat through MySeat that reads back the seats it added
 * and met, and `held`, an insertion of a seat and then, in a later stratum, of a Gate row. Two served writers run as two
 * subjects: W runs `held` as carl or as ann, and the owner holds Gate in SHARE mode, so W's seat is written and
 * uncommitted when its Gate insert waits; A runs `take` as ann then, past its precheck, which cannot see W's seat, to
 * the arbiter, where it waits for W; the owner's COMMIT lets W commit, and A's statement meets W's seat. A is called as
 * an application calls it, again after each TransientFailure (schedules/grizzle.ts untilAnswered).
 *
 * Box: W's subject, carl (outside ann's entry) or ann (inside it); A's seat at W's id or at another, and at W's team or
 * at another. Exhausted.
 *
 * Properties, per case:
 * - generate certifies holder SERIALIZABLE.
 * - A waits for W exactly where it requests W's id, and never where it requests another.
 * - At W's id A's first calls fail with SerializationFailure alone, and at another id none fails.
 * - A answers the serial order W, then A: at W's id, carl's seat refuses the call on Seat's key law, the witness A's
 *   submitted id; ann's own seat met as an exact repeat is unchanged, read back whole as met; ann's own seat at another
 *   team refuses the call on the key law; at another id A inserts its seat, reading it back as added.
 * - The table ends as that serial order leaves it.
 *
 * Oracle: specification, the serial order W, then A, over the stated seats, with the SerializationFailure of a call
 * whose snapshot misses W's commit at its key.
 */

import { assert, deepEquals } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Fiber, Formatter, Option, Order, Result } from "effect"
import { openServed } from "#adapter/db/served.ts"
import {
	Gate,
	otherId,
	otherTeam,
	type RaceFeature,
	raceGen,
	Seat,
	seatOf,
	seats,
	seatsRig,
	wId,
	wTeam
} from "#test/schedules/write/entry-occupants.fixtures.ts"
import { writeAnswerOf } from "#test/support/calls.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { refusedEntries } from "#test/support/refused.ts"
import { openActors } from "#test/support/schedules/actors.ts"
import { untilAnswered } from "#test/support/schedules/grizzle.ts"
import { rigIn } from "#test/support/schedules/rig.ts"
import { lockWaitOf } from "#test/support/substrate/barrier.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { tokenOf } from "#test/support/worlds.ts"

/**
 * A query entry's insertion racing a commit at its key fails at an occupant past its snapshot, and its retry answers serially.
 */
export const aQueryEntrysInsertionRacingACommitAtItsKeyFailsAtAnOccupantPastItsSnapshotAndItsRetryAnswersSerially =
	property.exhaust(finite(raceGen), {
		needs: { rigged: Substrate.fresh(seatsRig) },
		situations: [
			"an outside seat committed past the snapshot: 40001, then refused on the key's law",
			"an own seat committed past the snapshot: 40001, then met as an exact repeat",
			"an own seat at another team committed past the snapshot: 40001, then refused on the key's law",
			"a free id, inserted without waiting"
		] satisfies ReadonlyArray<Reached<RaceFeature>>,
		check:
			({ rigged }, k: Case<RaceFeature>) =>
			(c) =>
				Effect.flatMap(rigged, (taken) =>
					Effect.provideService(
						Effect.gen(function* () {
							const s = yield* Substrate
							const rig = yield* rigIn(taken, seats)
							const names = namesOf(rig.installed)
							const seatTable = names.table(Seat)
							const gate = names.table(Gate)
							const column = (field: "id" | "team" | "holder") => names.column(Seat, field)
							const openAs =
								(sub: string) => (context: Parameters<Parameters<typeof rig.servedWriter>[1]>[0]) =>
									openServed(rig.served.roles.holder, { token: tokenOf({ sub }) }).pipe(
										Effect.provideContext(context)
									)
							const a = yield* rig.servedWriter("a", openAs("u_ann"), (db) =>
								writeAnswerOf(
									db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } })
								)
							)
							const carl = yield* rig.servedWriter("carl", openAs("u_carl"), (db) =>
								writeAnswerOf(
									db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } })
								)
							)
							const ann = yield* rig.servedWriter("ann", openAs("u_ann"), (db) =>
								writeAnswerOf(
									db.workload.take.once({ params: {}, facts: { insert: { MySeat: [] } } })
								)
							)
							assert.equal(
								a.ctx.isolation,
								"serializable",
								"generate certifies holder SERIALIZABLE"
							)
							const { owner } = yield* openActors(s, {
								owner: { kind: "raw", as: rig.installed.ambientOwner.credentials }
							})
							const state = Effect.map(
								s.admin.queryValues(
									`SELECT ${column("id")}::text, ${column("team")}::text, ${column("holder")}::text FROM ${seatTable} ORDER BY 1`,
									[]
								),
								(rows) => Arr.map(rows, (row) => Arr.join(Arr.map(row, String), ","))
							)
							/**
							 * Whether a backend `waiter` waited for `holder` before `fiber` ended (collisions.test.ts), each read at every
							 * poll, a grizzle actor's being the connection its call holds then.
							 */
							const waitedOrEnded = <A>(
								fiber: Fiber.Fiber<A>,
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

							yield* rig.replace([])
							const w = c.outside ? carl : ann
							const wSub = c.outside ? "u_carl" : "u_ann"
							const request = {
								id: c.sameId ? wId : otherId,
								team: c.sameTeam ? wTeam : otherTeam
							}
							yield* owner.perform({ _tag: "Begin" })
							yield* owner.perform({ _tag: "Sql", sql: `LOCK TABLE ${gate} IN SHARE MODE` })
							const fiberW = yield* Effect.forkChild(
								Effect.result(
									writeAnswerOf(
										w.db.workload.held.once({
											params: {},
											facts: { insert: { MySeat: [{ id: wId, team: wTeam }], Gate: [{ n: 0 }] } }
										})
									)
								),
								{ startImmediately: true }
							)
							const atGate = yield* waitedOrEnded(
								fiberW,
								w.actor.backend,
								Effect.succeedSome(owner.pid)
							)
							assert.equal(atGate, "waited", "W writes its seat and waits at Gate")
							const fiberA = yield* Effect.forkChild(
								a.db.workload.take
									.once({ params: {}, facts: { insert: { MySeat: [request] } } })
									.pipe(writeAnswerOf, untilAnswered, Effect.result),
								{ startImmediately: true }
							)
							const waited = yield* waitedOrEnded(fiberA, a.actor.backend, w.actor.backend)
							yield* owner.perform({ _tag: "Commit" })
							const ranW = yield* Fiber.join(fiberW)
							const ranA = yield* Fiber.join(fiberA)
							const final = yield* state
							assert.ok(Result.isSuccess(ranW), `W commits its seat: ${Formatter.format(ranW)}`)
							assert.equal(
								waited === "waited",
								c.sameId,
								"A waits for W exactly where it requests W's id"
							)
							const wRow = `${wId},${wTeam},${wSub}`
							const aRow = `${request.id},${request.team},u_ann`
							assert.ok(Result.isSuccess(ranA), `A answers, never fails: ${Formatter.format(ranA)}`)
							const { refused, answered: answer } = ranA.success
							assert.ok(
								c.sameId
									? Arr.isReadonlyArrayNonEmpty(refused) &&
											Arr.every(refused, (reason) => reason === "SerializationFailure")
									: refused.length === 0,
								`A's calls fail with SerializationFailure alone exactly where it requests W's id: ${Formatter.format(refused)}`
							)
							if (!c.sameId) {
								assert.ok(
									answer._tag === "accepted" &&
										deepEquals(Arr.map(answer.reads.added, seatOf), [
											{ id: request.id, team: request.team }
										]) &&
										answer.reads.met.length === 0,
									`A inserts its seat at a free id, reading it back as added: ${Formatter.format(answer)}`
								)
								assert.deepEqual(
									final,
									Arr.sort([wRow, aRow], Order.String),
									"the table holds both seats"
								)
								k.note("a free id, inserted without waiting")
								return
							}
							if (!c.outside && c.sameTeam) {
								assert.ok(
									answer._tag === "unchanged" &&
										answer.reads.added.length === 0 &&
										deepEquals(Arr.map(answer.reads.met, seatOf), [{ id: wId, team: wTeam }]),
									`A's exact repeat of ann's own seat is unchanged, met: ${Formatter.format(answer)}`
								)
								assert.deepEqual(final, [wRow], "the table holds W's seat")
								k.note(
									"an own seat committed past the snapshot: 40001, then met as an exact repeat"
								)
								return
							}
							assert.ok(
								answer._tag === "refused" &&
									Arr.length(refusedEntries(answer.refused)) === 1 &&
									answer.witness.kind === "key" &&
									deepEquals(answer.witness.values, { id: wId }),
								`A is refused on Seat's key law at its submitted id: ${Formatter.format(answer)}`
							)
							assert.deepEqual(final, [wRow], "the table holds W's seat alone")
							k.note(
								c.outside
									? "an outside seat committed past the snapshot: 40001, then refused on the key's law"
									: "an own seat at another team committed past the snapshot: 40001, then refused on the key's law"
							)
						}),
						Substrate,
						taken.substrate
					)
				),
		oracle: {
			kind: "specification",
			name: "the serial order W, then A, over the stated seats, with the SerializationFailure of a call whose snapshot misses W's commit at its key"
		},
		box: "W as carl or as ann; A's seat at W's id or another, at W's team or another",
		kept: [],
		kills: []
	})
