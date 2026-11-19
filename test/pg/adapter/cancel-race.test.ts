import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Clock, Effect, Exit, Fiber, Formatter, Order } from "effect"
import {
	type BatchStatement,
	oneShotStatement,
	runApart,
	runTransaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { manualClock, raceCases, type RaceFeature } from "#test/pg/adapter/cancel-race.fixtures.ts"
import { backendPidOf, until } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/**
 * An interrupted flight's cancellation ends only once the server has stopped its statement, and within the bound when the server never answers.
 */
export const anInterruptedFlightsCancellationEndsOnlyOnceTheServerHasStoppedItsStatementAndWithinTheBoundWhenTheServerNeverAnswers =
	property.exhaust(finite(raceCases), {
		needs: { substrate: Substrate.installing },
		situations: [
			"before the read",
			"during the wait",
			"never",
			"apart",
			"transaction",
			["before the read", "apart"],
			["before the read", "transaction"],
			["during the wait", "apart"],
			["during the wait", "transaction"],
			["never", "apart"],
			["never", "transaction"]
		] satisfies ReadonlyArray<Reached<RaceFeature>>,
		check:
			({ substrate }, k: Case<RaceFeature>) =>
			(c) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const caller = yield* s.role(schema, "caller")
						const inserted = `${quoteIdent(schema)}."inserted"`
						const locked = `${quoteIdent(schema)}."locked"`
						yield* s.admin.query(`CREATE TABLE ${inserted} ("label" text PRIMARY KEY)`, [])
						yield* s.admin.query(`CREATE TABLE ${locked} ("k" int4 PRIMARY KEY)`, [])
						yield* s.admin.query(`INSERT INTO ${locked} ("k") VALUES (1)`, [])
						const role = quoteIdent(caller.role)
						yield* s.admin.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${role}`, [])
						yield* s.admin.query(`GRANT SELECT, INSERT ON ${inserted} TO ${role}`, [])
						yield* s.admin.query(`GRANT SELECT, UPDATE ON ${locked} TO ${role}`, [])
						const lockRow = `SELECT "k"::text FROM ${locked} WHERE "k" = 1 FOR UPDATE`
						const insertOf = (label: string): BatchStatement =>
							oneShotStatement(testSql(`INSERT INTO ${inserted} ("label") VALUES ('${label}')`), [])
						/** Whether backend `pid` waits on a lock. */
						const waitsOnLock = (pid: number) =>
							Effect.map(
								s.admin.queryValues(
									"SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4 AND wait_event_type = 'Lock'::text",
									[pid]
								),
								(rows) => rows.length > 0
							)
						/**
						 * What backend `pid` runs: nothing once it is gone, or its state, whether it has a transaction id and a snapshot, and
						 * the locks it holds.
						 */
						const runningOn = (pid: number) =>
							s.admin.queryValues(
								"SELECT a.state::text, (a.backend_xid IS NOT NULL)::text, (a.backend_xmin IS NOT NULL)::text, (SELECT count(*) FROM pg_catalog.pg_locks l WHERE l.pid = a.pid)::text FROM pg_catalog.pg_stat_activity a WHERE a.pid = $1::int4",
								[pid]
							)
						return yield* Effect.scoped(
							Effect.gen(function* () {
								k.note(c.lands)
								k.note(c.runner)
								k.pair(c.lands, c.runner)
								yield* s.admin.query(`TRUNCATE ${inserted}`, [])
								const locker = yield* s.session({ ...ownerSession(), label: "locker" })
								yield* locker.begin
								yield* locker.query(lockRow, [])
								const tapped = yield* tappedSession({
									cluster: s.cluster,
									database: s.database,
									role: caller.role,
									password: caller.password
								})
								/** The flight a partition held never reaches the server, whatever the case asserted. */
								const cutHeld = Effect.addFinalizer(() =>
									Effect.sync(() => {
										tapped.sent.cut()
									})
								)
								yield* cutHeld
								const pid = yield* backendPidOf(tapped.session)
								const manual = manualClock()
								/**
								 * The CancelRequests the caller has started and ended, each a round's first half: while as many have
								 * ended as started, every sleep under way is a round's wait.
								 */
								let started = 0
								let cancelled = 0
								const session: Session = {
									...tapped.session,
									cancel: Effect.suspend(() => {
										started += 1
										return Effect.ensuring(
											tapped.session.cancel,
											Effect.sync(() => {
												cancelled += 1
											})
										)
									})
								}
								const before = Array.from({ length: c.before }, (_, i) => `before ${i}`)
								const after = Array.from({ length: c.after }, (_, i) => `after ${i}`)
								const statements: Arr.NonEmptyReadonlyArray<BatchStatement> = Arr.prependAll(
									[oneShotStatement(testSql(lockRow), []), ...Arr.map(after, insertOf)],
									Arr.map(before, insertOf)
								)
								const flight =
									c.runner === "apart"
										? Effect.asVoid(runApart(session, statements))
										: Effect.asVoid(
												runTransaction(session, statements, {
													access: "readWrite",
													isolation: "readCommitted",
													end: "COMMIT"
												})
											)
								if (c.lands !== "during the wait") {
									tapped.sent.hold()
								}
								if (c.lands === "never") {
									tapped.gate.hold(0, { kind: "any" })
									tapped.partitionCancels()
								}
								const call = yield* Effect.forkChild(
									Effect.provideService(flight, Clock.Clock, manual.clock)
								)
								if (c.lands === "during the wait") {
									yield* until(waitsOnLock(pid))
								} else {
									yield* tapped.sent.holding
								}
								const interrupting = yield* Effect.forkChild(Fiber.interrupt(call), {
									startImmediately: true
								})
								const interrupted = (): boolean => interrupting.pollUnsafe() !== undefined
								/** Whether every CancelRequest started has ended, so every sleep under way is a round's wait. */
								const inRoundWait = (): boolean => started === cancelled
								/**
								 * Ends the sleeps abandon starts, each once `wakeable` says so, until `done` holds or the interruption
								 * has ended.
								 */
								const wakeUntil = (done: () => boolean, wakeable: () => boolean) =>
									Effect.gen(function* () {
										while (!interrupted() && !done()) {
											yield* until(
												Effect.sync(
													() => interrupted() || done() || (manual.sleeping() > 0 && wakeable())
												)
											)
											manual.wake()
										}
									})
								/**
								 * The race: the server has signalled the backend while it reads its next command, so the first
								 * CancelRequest stops nothing; the flight then reaches the backend, which waits on the case's lock, and
								 * only then does the round's wait end, so the next round's CancelRequest finds the statement waiting.
								 */
								const raceBeforeTheRead = Effect.gen(function* () {
									yield* until(Effect.sync(() => tapped.cancelsEnded() > 0))
									tapped.sent.release()
									yield* until(waitsOnLock(pid))
									yield* wakeUntil(() => started > 1, inRoundWait)
								})
								/**
								 * The partition: every sleep abandon starts ends as it comes, a round's wait at once and a
								 * CancelRequest's bound once the tap holds its request, so every round's request reaches the
								 * partitioned server.
								 */
								const partitioned = wakeUntil(
									() => false,
									() => inRoundWait() || tapped.cancels() >= started
								)
								switch (c.lands) {
									case "during the wait":
										break
									case "before the read":
										yield* raceBeforeTheRead
										break
									case "never":
										yield* partitioned
										break
								}
								yield* Fiber.join(interrupting)
								const exit = yield* Fiber.await(call)
								assert.ok(Exit.hasInterrupts(exit), "the exit is the interruption")
								if (c.lands === "never") {
									assert.equal(
										tapped.cancels(),
										2,
										"a server that never answers is given one CancelRequest per round, up to the bound"
									)
									assert.equal(tapped.session.state(), "ended", "its connection is destroyed")
									yield* locker.rollback
									return
								}
								const running = yield* runningOn(pid)
								assert.ok(
									Arr.every(
										running,
										(row) =>
											row[0] === "idle" &&
											row[1] === "false" &&
											row[2] === "false" &&
											row[3] === "0"
									),
									`backend ${pid} runs nothing of the flight once the interruption has ended: ${Formatter.format(running)} (state, a transaction id, a snapshot, its locks)`
								)
								assert.equal(
									tapped.session.state(),
									"retired",
									"the session is retired, its connection kept until the server ended the flight"
								)
								assert.equal(
									tapped.cancels(),
									c.lands === "before the read" ? 2 : 1,
									"one CancelRequest per round: a second once the first landed before the read"
								)
								const committed = yield* s.admin.queryValues(
									`SELECT "label" FROM ${inserted} ORDER BY "label"`,
									[]
								)
								assert.deepEqual(
									Arr.map(committed, ([label]) => String(label)),
									c.runner === "apart" ? Arr.sort([...after, ...before], Order.String) : [],
									"a transaction whose statement was stopped commits nothing; statements apart commit every insert"
								)
								yield* locker.rollback
							})
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "README: an interrupted call ends only once the server has stopped its statement, and a silent server ends it after two silent rounds"
		},
		box: "statements apart or one transaction, the locking statement among up to two inserts on either side, its CancelRequest landing before the read, during the wait, or never answered",
		kept: [],
		kills: []
	})
