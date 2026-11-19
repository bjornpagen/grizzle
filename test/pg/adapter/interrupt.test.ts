/**
 * Interrupted public calls: what an interruption leaves behind, at every point of a call's round trip (README "No
 * server-side timeouts": interrupting the Effect is the only cancellation).
 *
 * A case is a call on the worked example's Work, opened as its full role through its login's served file: a write (the
 * apply of a change member that inserts, deletes and puts task notes, each member valid against the state it starts
 * from) or a read (taskCards' member, plain or deferrable(...)), and a point in its round trip: the tap's gate holds
 * the server's bytes once a number of backend messages (ReadyForQuery messages, or any) have reached the client, drawn
 * against the call's own traffic, which one run of the call on a session of its own measures first: inside the call's
 * messages, at its last one, or past its end, where the call completes before the gate. Optionally an owner session
 * holds a row lock first, so a statement the call sends, or its COMMIT, waits on the server until the call is
 * interrupted; or, before a deferrable read, a SERIALIZABLE read-write transaction open with its snapshot taken, so the
 * read's prologue waits for a safe snapshot until the call is interrupted. The case waits on what it observes, never on
 * the clock.
 *
 * The oracle is the README's cancellation contract, restated per case:
 * - the exit is the interruption when the call had not completed when it came, and otherwise the call's success;
 * - the call sent a CancelRequest exactly when interrupted before its last statement answered;
 * - the task notes are exactly as before the call, or exactly as the accepted write leaves them, never in between;
 * - the pool has no session leased, and the next call succeeds.
 *
 * Features: how the call ended against the gate, where it was interrupted (a lock wait and a deferrable read's wait for
 * a safe snapshot among them), and what the interruption left (committed, rolled back).
 */

import type { Reached } from "@bjornpagen/testing/features"
import { steered } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Option } from "effect"
import { onceCalls } from "#adapter/db/handles.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { ChangeSet } from "#compiler/public/changeset.ts"
import { Uuid } from "#compiler/public/fields.ts"
import { deferrable } from "#compiler/public/workload.ts"
import {
	aimedSketchGen,
	applyFacts,
	gateCount,
	type InterruptFeature,
	type Note,
	resolveWrite,
	situations,
	interruptAims
} from "#test/pg/adapter/interrupt.fixtures.ts"
import { defaultPool, poolFor, rowsOn, until } from "#test/pg/adapter/support.ts"
import { openedIn, workSeatInstall, workSeatTemplate } from "#test/pg/reads/support.ts"
import { aimedSteered } from "#test/support/aims.ts"
import { assert, succeeded } from "#test/support/assert.ts"
import { oneOf, readOnce } from "#test/support/calls.ts"
import { exactValue } from "#test/support/equivalence.ts"
import * as W from "#test/support/fixtures/api/work.ts"
import { a1, t1, workFacts } from "#test/support/fixtures/golden/work.ts"
import { replaceMigrated as replace } from "#test/support/install-migrate.ts"
import { namesOf } from "#test/support/kernel/naming.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { member, withServedDb } from "#test/support/served-db.ts"
import { ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"

/**
 * Interrupted public calls leave the state before or after, and nothing running.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/adapter/interrupt.test.ts at 991e0f9ab).
 */
export const interruptedPublicCallsLeaveTheStateBeforeOrAfterAndNothingRunning = property.explore(
	aimedSteered(steered(aimedSketchGen), interruptAims),
	{
		needs: { fixture: Substrate.seat(workSeatTemplate) },
		situations: situations satisfies ReadonlyArray<Reached<InterruptFeature>>,
		check:
			({ fixture }, cx: Case<InterruptFeature>) =>
			(sketch) =>
				Effect.scoped(
					Effect.flatMap(fixture, (taken) =>
						Effect.provideService(
							Effect.gen(function* () {
								const s = yield* Substrate
								const o = yield* openedIn(W.Work, workFacts, workSeatInstall, taken)
								const names = namesOf(o.installed)
								const notes = names.table(W.TaskNote)
								const noteTask = names.column(W.TaskNote, "task")
								const noteText = names.column(W.TaskNote, "note")
								/** The login the call's backend logs in as, which pg_stat_activity names it by. */
								const writerRole = o.installed.as(o.server).role
								const reads = W.workReads(o.schema)
								const { context, members } = yield* Effect.scoped(
									withServedDb(o.installed, o.server.roles.app, {}, ({ ctx, load }) =>
										Effect.map(
											load({
												write: ChangeSet.empty(o.schema)
													.insert(W.TaskNote, [])
													.delete(W.TaskNote, [])
													.put(W.TaskNote, []),
												cards: reads.taskCards,
												deferredCards: deferrable(reads.taskCards),
												task: W.Task
											}),
											(loaded) => ({ context: ctx, members: loaded })
										)
									)
								)
								/** A member's calls over `pool`. */
								const on = (pool: SessionPool, name: string) =>
									onceCalls({ ...context, pool }, member(members, name))
								const notesNow = Effect.map(
									s.admin.queryValues(
										`SELECT ${noteTask}::text, ${noteText} FROM ${notes} ORDER BY ${noteTask}`,
										[]
									),
									(rows) =>
										Arr.map(rows, ([task, note]): Note => ({
											task: succeeded(Uuid.parse(task), "a stored note's task"),
											note: String(note)
										}))
								)
								return yield* Effect.scoped(
									Effect.gen(function* () {
										const before = yield* notesNow
										const write = resolveWrite(sketch.members, before, 1)
										/**
										 * Every call starts from the state written whole, the work facts with these notes
										 * (substrate/replace.ts): a write over the dead versions an earlier write left would be an SSI pivot
										 * under load, and fail with 40001.
										 */
										const restore = replace(o.installed, {
											...workFacts,
											TaskNote: Arr.map(before, (n) => ({ task: n.task, note: n.note }))
										})
										yield* restore
										/**
										 * The call through the members of the full role over `pool`; an uncaught failure of an uninterrupted
										 * one is a defect the exit check reports.
										 */
										const callOn = (pool: SessionPool) =>
											sketch.call === "write"
												? Effect.orDie(
														Effect.asVoid(
															applyFacts({ ...context, pool }, member(members, "write"), {
																insert: { TaskNote: write.inserts },
																delete: { TaskNote: write.deletes },
																put: { TaskNote: write.puts }
															})
														)
													)
												: Effect.orDie(
														Effect.asVoid(
															readOnce(on(pool, sketch.deferrable ? "deferredCards" : "cards"))({
																params: { account: a1 },
																facts: {}
															})
														)
													)
										/** A tapped pool of one fresh session, warmed, so a window holds one call's traffic alone. */
										const tappedDb = Effect.gen(function* () {
											const tap = makeTap(s.cluster)
											const pool = yield* poolFor(o.installed.as(o.server), {
												...defaultPool,
												transport: { kind: "given", transport: tap.transport },
												pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
											})
											yield* Effect.scoped(
												Effect.flatMap(pool.lease, (session) =>
													rowsOn(session, "SELECT 'warm'::text", [])
												)
											)
											return { tap, pool }
										})
										/**
										 * The call's own backend messages, from one uninterrupted run on a session of its own; a write's
										 * notes are put back after it, so the gated call starts from the same state.
										 */
										const traffic = yield* Effect.scoped(
											Effect.gen(function* () {
												const measuring = yield* tappedDb
												const mark = measuring.tap.mark()
												yield* callOn(measuring.pool)
												return measuring.tap.since(mark).backend
											})
										)
										if (sketch.call === "write") {
											yield* restore
										}
										const { tap, pool } = yield* tappedDb
										const call = callOn(pool)
										/**
										 * The owner's lock: on a note the write deletes or puts, or on the task of a note it inserts.
										 */
										const lockedNote = [...write.deletes, ...write.puts][0]
										const lockedTask = write.inserts[0]?.task
										/**
										 * A deferrable read's blocker: a SERIALIZABLE read-write transaction whose snapshot is taken, which every
										 * safe snapshot taken while it runs waits for; a plain read waits on no lock the owner can hold.
										 */
										const lock =
											sketch.call === "read"
												? sketch.deferrable && sketch.blocker !== "none"
													? "SELECT 1"
													: undefined
												: sketch.blocker === "statement" && lockedNote !== undefined
													? `SELECT 1 FROM ${notes} WHERE ${noteTask} = '${lockedNote.task}'::uuid FOR UPDATE`
													: sketch.blocker === "commit" && lockedTask !== undefined
														? `SELECT 1 FROM ${names.table(W.Task)} WHERE ${names.column(W.Task, "id")} = '${lockedTask}'::uuid FOR UPDATE`
														: undefined
										const locker =
											lock === undefined
												? undefined
												: yield* s.session({ ...ownerSession(), label: "locker" })
										if (locker !== undefined && lock !== undefined) {
											yield* locker.begin
											yield* locker.query(lock, [])
										}
										/**
										 * The ReadyForQuery that answers the call's last statement, counted among the call's own: a read's
										 * and a write's last both come before COMMIT's, behind BEGIN's and the prologue's. A write that
										 * sends nothing has none.
										 */
										const answersOf = (type: string) =>
											Arr.filter(traffic, (m) => m.type === type).length
										const lastAnswered = answersOf("Z") - 1
										const callMark = tap.mark()
										yield* tap.gate.settled
										/** The answers before the call, every one of which has reached the driver (Gate.settled). */
										const answeredBefore = tap.gate.delivered("Z")
										const answered = (): number => tap.gate.delivered("Z") - answeredBefore
										tap.gate.hold(
											gateCount(sketch.point, traffic),
											sketch.point.type === "Z" ? { kind: "type", type: "Z" } : { kind: "any" }
										)
										const fiber = yield* Effect.forkChild(call)
										/**
										 * Whether the call's backend waits on the owner: on a lock, which only the owner's can be, or, a
										 * deferrable read, for a safe snapshot, which the owner's open transaction withholds.
										 */
										const waitingOnLock = Effect.map(
											s.admin.queryValues(
												"SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usename = $1::name AND datname = pg_catalog.current_database() AND (wait_event_type = 'Lock'::text OR wait_event = 'SafeSnapshot'::text)",
												[writerRole]
											),
											(rows) => rows.length > 0
										)
										/**
										 * The call cannot complete while the lock is held, and the server reaches it. A
										 * statement's lock withholds the last statement's answer; COMMIT's comes after every
										 * statement answered, and those answers reach the call unless the gate holds them.
										 *
										 * The server runs on behind the gate until it has answered every query the call sent.
										 */
										const stopped = yield* locker === undefined
											? Effect.gen(function* () {
													const first = yield* Effect.raceFirst(
														Effect.as(tap.gate.holding, "held" as const),
														Effect.as(Fiber.await(fiber), "completed" as const)
													)
													if (first === "held") {
														yield* until(
															Effect.sync(
																() => tap.since(callMark).backend.length >= traffic.length
															)
														)
													}
													return first
												})
											: Effect.gen(function* () {
													yield* until(waitingOnLock)
													if (sketch.call === "write" && sketch.blocker === "commit") {
														yield* Effect.raceFirst(
															tap.gate.holding,
															until(Effect.sync(() => answered() >= lastAnswered))
														)
													}
													cx.note(
														sketch.call === "read"
															? "interrupted where the server waits for a safe snapshot"
															: "interrupted where the server waits on a lock"
													)
													return "waits" as const
												})
										/**
										 * An interruption before the last statement answered cancels the flight (batch.ts), and nothing
										 * can answer it meanwhile: the gate holds the answer, or the lock the statement.
										 */
										const cancels = stopped !== "completed" && answered() < lastAnswered
										if (stopped !== "completed") {
											/**
											 * The interruption reaches the call before anything else happens: the fork starts at once. A call
											 * that cancels holds the gate, and the lock where it waits on one, until its CancelRequest has
											 * reached the server and stopped the statement, or the interruption has ended, when the call has
											 * nothing left to send.
											 */
											const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber), {
												startImmediately: true
											})
											if (cancels) {
												yield* until(
													Effect.sync(
														() => tap.cancelsEnded() > 0 || interrupting.pollUnsafe() !== undefined
													)
												)
												if (locker !== undefined) {
													yield* until(
														Effect.map(
															waitingOnLock,
															(waiting) => !waiting || interrupting.pollUnsafe() !== undefined
														)
													)
												}
											}
											tap.gate.release()
											if (locker !== undefined) {
												yield* locker.rollback
											}
											yield* Fiber.join(interrupting)
										} else {
											tap.gate.release()
										}
										const exit = yield* Fiber.await(fiber)
										assert.equal(
											tap.cancels() > 0,
											cancels,
											"the call cancels exactly when interrupted before its last statement answered"
										)
										/**
										 * A call whose last answer was the one the gate held at completes as it is interrupted; any other
										 * interrupted call ends with the interruption.
										 */
										const interrupted = Exit.hasInterrupts(exit)
										if (stopped === "completed") {
											assert.ok(!interrupted, "a call that completed first is not interrupted")
										}
										if (!interrupted) {
											assert.ok(Exit.isSuccess(exit), "an uninterrupted call succeeds")
										}
										const after = yield* notesNow
										/** Whether the write changes the notes when accepted, and whether they changed. */
										const effective =
											sketch.call === "write" && Option.isSome(exactValue(write.after, before))
										const changed = Option.isSome(exactValue(after, before))
										assert.ok(
											!changed || (effective && Option.isNone(exactValue(after, write.after))),
											`the notes are as before the call or as the accepted write leaves them\nbefore: ${Formatter.format(before)}\nwrite: ${Formatter.format(write)}\nafter: ${Formatter.format(after)}`
										)
										if (interrupted) {
											cx.note(`${sketch.call} interrupted`)
											if (sketch.deferrable) {
												cx.note("deferrable read interrupted")
											}
											if (effective) {
												cx.note(
													changed
														? "committed after an interruption"
														: "rolled back after an interruption"
												)
											}
										} else {
											cx.note(`${sketch.call} completed before the gate`)
										}
										const { leased } = yield* pool.state
										assert.equal(leased, 0, "the pool has no session leased")
										const probe = yield* oneOf(
											readOnce(on(pool, "task"))({ params: { id: t1 }, facts: {} })
										)
										assert.ok(Option.isSome(probe), "the next call succeeds")
									})
								)
							}),
							Substrate,
							taken.substrate
						)
					)
				),
		oracle: {
			kind: "specification",
			name: "README: an interrupted call cancels exactly before its last answer and leaves the state before or after"
		},
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: []
	}
)
