import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Order } from "effect"
import {
	type BatchStatement,
	oneShotStatement,
	runApart,
	runTransaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/core/text.ts"
import { raceCases, type RaceFeature } from "#test/pg/adapter/cancel-race.fixtures.ts"
import { backendPidOf, until } from "#test/pg/adapter/support.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/**
 * An interrupted flight's cancellation ends only once the server has stopped its statement, the next round started by
 * the server's next answer when the first request landed before the read, and at once, its connection destroyed, when
 * the server is unreachable.
 */
export const anInterruptedFlightsCancellationEndsOnlyOnceTheServerHasStoppedItsStatementOrOnceItsServerIsUnreachable =
	property.exhaust(finite(raceCases), {
		needs: { substrate: Substrate.installing },
		situations: [
			"before the read",
			"during the wait",
			"unreachable",
			"apart",
			"transaction",
			["before the read", "apart"],
			["before the read", "transaction"],
			["during the wait", "apart"],
			["during the wait", "transaction"],
			["unreachable", "apart"],
			["unreachable", "transaction"]
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
								/** A flight the sent gate still holds never reaches the server once the case ends, whatever it asserted. */
								const cutHeld = Effect.addFinalizer(() =>
									Effect.sync(() => {
										tapped.sent.cut()
									})
								)
								yield* cutHeld
								const pid = yield* backendPidOf(tapped.session)
								/** The CancelRequests the caller has started, each a round's first half. */
								let started = 0
								const session: Session = {
									...tapped.session,
									cancel: Effect.suspend(() => {
										started += 1
										return tapped.session.cancel
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
								if (c.lands === "before the read") {
									tapped.sent.hold()
								}
								const call = yield* Effect.forkChild(flight)
								if (c.lands === "before the read") {
									yield* tapped.sent.holding
								} else {
									yield* until(waitsOnLock(pid))
								}
								if (c.lands === "unreachable") {
									tapped.unreachable()
								}
								const interrupting = yield* Effect.forkChild(Fiber.interrupt(call), {
									startImmediately: true
								})
								/**
								 * The race: the server has signalled the backend while it reads its next command, so the first
								 * CancelRequest stops nothing. The server's answers are then held while the flight reaches the
								 * backend, which waits on the case's lock, and let through only then, so the answer that starts
								 * the next round comes once the statement waits, and that round's CancelRequest finds it.
								 */
								const raceBeforeTheRead = Effect.gen(function* () {
									yield* until(Effect.sync(() => tapped.cancelsEnded() > 0))
									tapped.gate.hold(0, { kind: "any" })
									tapped.sent.release()
									yield* until(waitsOnLock(pid))
									tapped.gate.release()
								})
								if (c.lands === "before the read") {
									yield* raceBeforeTheRead
								}
								yield* Fiber.join(interrupting)
								const exit = yield* Fiber.await(call)
								assert.ok(Exit.hasInterrupts(exit), "the exit is the interruption")
								if (c.lands === "unreachable") {
									assert.equal(started, 1, "one CancelRequest, which never reaches the server")
									assert.equal(tapped.cancels(), 0, "no CancelRequest reached the server")
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
								assert.ok(
									tapped.cancels() >= (c.lands === "before the read" ? 2 : 1),
									`a CancelRequest per round, a second once the first landed before the read: ${tapped.cancels()}`
								)
								const committed = yield* s.admin.queryValues(
									`SELECT "label" FROM ${inserted} ORDER BY "label"`,
									[]
								)
								const labels = Arr.map(committed, ([label]) => String(label))
								if (c.runner === "transaction") {
									assert.deepEqual(
										labels,
										[],
										"a transaction whose statement was stopped commits nothing"
									)
								} else {
									assert.deepEqual(
										Arr.filter(labels, (label) => Arr.contains(before, label)),
										Arr.sort(before, Order.String),
										"statements apart commit every insert before the stopped one"
									)
									assert.ok(
										Arr.every(
											labels,
											(label) => Arr.contains(before, label) || Arr.contains(after, label)
										),
										"statements apart commit no insert of another flight; one after the stopped statement commits unless a later round's CancelRequest stopped it"
									)
								}
								yield* locker.rollback
							})
						)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "README: an interrupted call ends only once the server has stopped its statement, each round after the first started by the server's next answer, and a CancelRequest that cannot reach the server ends it, its connection destroyed"
		},
		box: "statements apart or one transaction, the locking statement among up to two inserts on either side, its CancelRequest landing before the read, during the wait, or unreachable",
		kept: [],
		kills: []
	})
