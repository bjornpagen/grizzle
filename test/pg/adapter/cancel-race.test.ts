/**
 * An interrupted flight ends only once the server has stopped its statement (README "No server-side timeouts";
 * adapter/wire/batch.ts abandon), wherever its CancelRequest lands, and a server that never answers ends it within the
 * bound, its outcome unknown.
 *
 * PostgreSQL ignores a CancelRequest that reaches a backend while it reads a command (REL_19_RC2
 * src/backend/tcop/postgres.c 3536-3546, `if (!DoingCommandRead)`, and 4813-4823, which drops a cancel that arrived
 * while it was idle), so one that lands before the backend has read the statement stops nothing: the backend then reads
 * it and runs it. An abandon that destroyed its connection after one CancelRequest left that statement running, holding
 * its locks and its snapshot, on a backend that never reads its socket while it waits on a lock.
 *
 * A case is a flight on a tapped session (test/support/wire-tap.ts) of a login of the case's own: statements apart
 * (runApart), each its own implicit transaction, or one transaction of them (runTransaction), committing. One statement
 * locks the row the case holds locked (SELECT ... FOR UPDATE), so it waits until a CancelRequest stops it; the others,
 * before and after it, each insert a row. Where the interruption's CancelRequest lands:
 *
 * - before the read: the tap's sent gate holds the flight, so the backend sits reading its next command when the first
 *   CancelRequest reaches it. The gate lets the flight through once that CancelRequest's connection has ended (the
 *   server has signalled the backend by then: backend_startup.c 385-388 sends it before the connection closes), the
 *   backend reads the flight and its locking statement waits on the case's lock, and only then does the case end the
 *   round's wait;
 * - during the wait: the case interrupts once the backend waits on the lock;
 * - never: the tap partitions the server: it holds the flight, the server's bytes and every CancelRequest's connection,
 *   unanswered, and the case ends each wait abandon sleeps through as it comes.
 *
 * abandon's waits sleep on a clock the case owns (manualClock): a wait ends when the case ends it, never on the
 * machine's clock, so each round ends where the case observed what it waited for. The space is small, so it is
 * exhausted: every runner, every lone or framed position of the locking statement among up to two inserts on either
 * side, and every landing.
 *
 * The oracle is README's cancellation contract, restated per case:
 * - the exit is the interruption;
 * - answered (before the read, during the wait): once the interruption has ended, the session's backend runs nothing of
 *   the flight: it is idle outside any transaction or gone, with no lock (pg_locks), no transaction id and no snapshot
 *   (pg_stat_activity backend_xid, backend_xmin); the session was retired, its connection kept; a transaction committed
 *   nothing, since its locking statement was stopped, and statements apart committed every insert, those after the
 *   stopped statement included; and it took one CancelRequest per round: one during the wait, two when the first landed
 *   before the read;
 * - never: the interruption ends after exactly two CancelRequests, the excused silent round's and the one that severs,
 *   its connection destroyed.
 *
 * Features: each landing, each runner, and each landing with each runner.
 *
 * @plant test/plants/pg/adapter/abandon-cancel-once.patch abandon as it was before this property, one CancelRequest
 * and then the connection destroyed at once, so a request that lands before the read leaves the statement running; the
 * race case fails with its backend active, holding a snapshot and its locks, after the interruption ended.
 * @plant test/plants/pg/adapter/abandon-sever-excused-silence.patch A silent round severs the flight though its silence
 * was excused, so the round a CancelRequest lost to the read costs leaves the statement running; the race case of a
 * lone statement apart fails the same way.
 */
import { exhaust } from "@bjornpagen/testing/explore"
import { requiredInSpace } from "@bjornpagen/testing/features"
import { element, type Gen, int } from "@bjornpagen/testing/gen"
import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Array as Arr, Clock, Deferred, Effect, Exit, Fiber, Formatter, Order } from "effect"
import {
	type BatchStatement,
	oneShotStatement,
	runApart,
	runTransaction
} from "#adapter/wire/batch.ts"
import type { Session } from "#adapter/wire/session.ts"
import { quoteIdent } from "#compiler/sql/print.ts"
import { backendPidOf, until } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import { testSql } from "#test/support/sql.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { tappedSession } from "#test/support/wire-tap.ts"

/** Where the interruption's first CancelRequest lands (see the header). */
type Lands = "before the read" | "during the wait" | "never"

/** How the flight runs its statements: each alone, or in one transaction. */
type Runner = "apart" | "transaction"

interface RaceCase {
	readonly runner: Runner
	/** The inserts before the locking statement. */
	readonly before: number
	/** The inserts after the locking statement. */
	readonly after: number
	readonly lands: Lands
}

const landings = ["before the read", "during the wait", "never"] as const

const runners = ["apart", "transaction"] as const

/** Every case: each runner, up to two inserts on either side of the locking statement, and each landing. */
const raceCases: Gen<RaceCase> = (source) => ({
	runner: source.draw(element(runners)),
	before: source.draw(int(0, 2)),
	after: source.draw(int(0, 2)),
	lands: source.draw(element(landings))
})

type RaceFeature = Lands | Runner

/**
 * A clock whose sleeps end only when the case ends them (wake), each registered as it starts, so the case knows when
 * abandon sleeps; it reads the time from the machine's clock.
 */
const manualClock = () => {
	const live = Clock.Clock.defaultValue()
	const sleeping = new Set<Deferred.Deferred<void>>()
	const clock: Clock.Clock = {
		currentTimeMillisUnsafe: () => live.currentTimeMillisUnsafe(),
		currentTimeMillis: live.currentTimeMillis,
		currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
		currentTimeNanos: live.currentTimeNanos,
		monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
		monotonicTimeNanos: live.monotonicTimeNanos,
		sleep: () =>
			Effect.suspend(() => {
				const slept = Deferred.makeUnsafe<void>()
				sleeping.add(slept)
				return Effect.ensuring(
					Deferred.await(slept),
					Effect.sync(() => {
						sleeping.delete(slept)
					})
				)
			})
	}
	return {
		clock,
		/** How many sleeps are under way. */
		sleeping: (): number => sleeping.size,
		/**
		 * Ends every sleep under way now, and none a woken fiber starts meanwhile, which a Set's iteration would visit.
		 */
		wake: (): void => {
			for (const slept of Arr.fromIterable(sleeping)) {
				Deferred.doneUnsafe(slept, Exit.void)
			}
		}
	}
}

const suite = Effect.gen(function* () {
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
	return yield* exhaust(
		{
			box: "statements apart or one transaction, the locking statement among up to two inserts on either side, its CancelRequest landing before the read, during the wait, or never answered",
			oracle: {
				kind: "specification",
				name: "README: an interrupted call ends only once the server has stopped its statement, and a silent server ends it after two silent rounds"
			},
			suite: "pg/adapter/cancel-race",
			generator: raceCases,
			literal: Formatter.format,
			coverage: requiredInSpace<RaceFeature>([
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
			]),
			caseHang,
			concurrency: 1
		},
		(c, k) =>
			Effect.scoped(
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
								row[0] === "idle" && row[1] === "false" && row[2] === "false" && row[3] === "0"
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
	)
})

layer(Substrate.layer, { excludeTestServices: true })(
	"an interrupted flight's cancellation",
	(it) => {
		it.effect(
			"ends only once the server has stopped its statement, and within the bound when the server never answers",
			(ctx) => searched(ctx, suite)
		)
	}
)
