/**
 * The session pool's lifetime bookkeeping (packages/grizzle/src/adapter/wire/session.ts makePool) over a PostgreSQL
 * server in memory, behind the SSLRequest and verify-full TLS of grizzle's public transport (test/support/memory-tls.ts):
 * the pool must hold no connection, session, waiter or permit past its life, whatever leases, interruptions and
 * connection losses happen.
 *
 * A property over drawn sequences on a pool of a drawn maximum (1 to 3), which keeps every session it opened for its
 * life. Each step leases a session and holds it, or releases a held one; ends one of the server's connections, a
 * leased session's or an idle one's; leases a second session where the maximum allows, releases one and lets it idle
 * past the least delay a Node timer waits, after which it is still open; leases at once, as many as
 * one, the pool's size, one past it or more past it, those its free permits admit connecting and the rest waiting for a
 * permit, until every one is interrupted, then releases a session; abandons a lease,
 * interrupted while pg connects it or hands it an idle session; cuts a lease, interrupted at a drawn turn of the
 * scheduler, which runs it a drawn few operations a turn, so the cut lands at every step of its acquisition and of its
 * hold; races such a cut, on a lease queued behind a saturated pool, with a release at another drawn turn, often a turn
 * or few before the cut, which hands it the permit; or has the server refuse a connection, at startup or by sending no
 * cancellation key. After every step, at a turn of the event loop: the sessions a release reaches are exactly the
 * server's open connections, pg's Pool
 * counts exactly those, nothing waits in pg's queue, and the leased count is the model's; the pool's permits
 * (SessionPool state) are each free, held by an attempt or leased, their sum its maximum, so a permit no one holds is
 * lost at the step that lost it, and no lease waits for one. A wait has no deadline of its own: it ends with a session,
 * or as an interruption. At the end every held session is released and, once pg has answered every attempt, every
 * permit is free; the pool leases its maximum at once with the clock standing still, and its end closes every
 * connection at once, no session left.
 *
 * How the server answers a startup: ready, with a cancellation key, or refused, at startup or with no key.
 *
 * Oracle: a model of the leases held after each step, against the server's own open connections and pg's Pool's
 * counts, both read apart from the pool's bookkeeping; the permits' conservation, free + attempting + leased = the
 * drawn maximum, with none waiting, after each step; at the end, every permit free and the pool's maximum leased at once
 * with the clock standing still.
 *
 * Features: each step's situation; of the leases taken at once, none waiting, one waiting for a permit, and one
 * waiting behind another; the kept case reaches every abandonment, loss, starvation and refusal on a pool of two.
 */

import { timerMinMs } from "@bjornpagen/grizzle/runtime"
import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Fiber, Formatter, Scheduler, Scope } from "effect"
import pgDriver from "pg"
import { makePool, type PoolState } from "#adapter/wire/session.ts"
import { servedSession } from "#compiler/program/served.ts"
import { noPassword } from "#test/support/pg.ts"
import { parsedConnection } from "#test/support/pg.ts"
import { pickFrom } from "#test/support/pick.ts"
import { upTo } from "#test/support/up-to.ts"
import {
	FakeServer,
	typedFailureOf,
	type Held,
	leaseCount,
	type PoolFeature,
	sequenceSpace,
	settle,
	situations,
	type Startup,
	waitingOf,
	wallClock
} from "#test/unit/adapter/pool.fixtures.ts"

/**
 * The session pool keeps exactly the open connections and recovers from every interruption, loss and refusal, over
 * drawn sequences.
 *
 * Budget: its suite's count before the conversion (unit/adapter/pool: 40 independent cases and 16 steered, Vitest at
 * grizzle 4ca3036a).
 */
export const theSessionPoolKeepsExactlyTheOpenConnectionsAndRecoversFromEveryInterruptionLossAndRefusalOverDrawnSequences =
	property.explore(sequenceSpace, {
		needs: {},
		situations: situations satisfies ReadonlyArray<Reached<PoolFeature>>,
		check:
			(_, c: Case<PoolFeature>) =>
			({ max, steps }) =>
				Effect.gen(function* () {
					const server = new FakeServer()
					/**
					 * The pool and its leases live in a scope of their own, which only a passing case closes: a
					 * failing case reports at once instead of waiting on an end that may never come, the wedge
					 * this suite exists to catch.
					 */
					const poolScope = yield* Scope.make()
					const pool = yield* Scope.provide(
						makePool({
							connection: parsedConnection(
								{
									driver: pgDriver,
									transport: server.transport,
									database: "fake",
									password: noPassword
								},
								"fake"
							),
							session: servedSession,
							bounds: { max }
						}),
						poolScope
					)
					const held: Array<Held> = []
					/**
					 * The pool's state once the event loop has settled twice: a session a step gave back closed (a lease
					 * refusing a connection that sent no cancellation key) ends at the server only after its Terminate and
					 * the server's end cross TLS in memory, more turns than one settle takes.
					 */
					const holds = Effect.gen(function* () {
						yield* settle
						yield* settle
						const open = server.open.size
						const size = yield* pool.size
						assert.equal(size, open, "pg's Pool counts exactly the open connections")
						assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
						const state = yield* pool.state
						assert.equal(state.leased, held.length, "the pool counts exactly the held leases")
						assert.equal(
							state.free + state.attempting + state.leased,
							max,
							`every permit is free, held by an attempt or leased, none lost: ${Formatter.format(state)}`
						)
						assert.equal(state.waiting, 0, "no lease waits for a permit once its step has ended")
					})
					const lease = Effect.gen(function* () {
						const scope = yield* Scope.fork(poolScope)
						const opened = server.opened
						const session = yield* Scope.provide(pool.lease, scope)
						c.note(server.opened > opened ? "leased a new session" : "leased an idle session")
						held.push({ session, scope })
					})
					const release = (h: Held) =>
						Effect.gen(function* () {
							held.splice(held.indexOf(h), 1)
							yield* Scope.close(h.scope, Exit.void)
							c.note("released")
						})
					/**
					 * A lease run `step.ops` operations a scheduler turn, which holds its session once it has one,
					 * cut at turn `step.at`: interrupted, whatever it holds by then. `onTurn` runs before each turn.
					 * It ends as an interruption.
					 */
					const cut = (
						step: { readonly at: number; readonly ops: number },
						onTurn: (turn: number) => Effect.Effect<void>
					) =>
						Effect.gen(function* () {
							const leasing = yield* Effect.forkChild(
								Effect.scoped(Effect.andThen(pool.lease, Effect.never)).pipe(
									Effect.provideService(Scheduler.MaxOpsBeforeYield, step.ops)
								),
								{ startImmediately: true }
							)
							for (let turn = 0; turn < step.at; turn++) {
								yield* onTurn(turn)
								yield* Effect.yieldNow
							}
							/** The pool counts the cut lease among its leased sessions beside the held ones. */
							const holding = (yield* pool.state).leased > held.length
							yield* Fiber.interrupt(leasing)
							const exit = yield* Fiber.await(leasing)
							assert.ok(Exit.hasInterrupts(exit), "only an interruption ends a cut lease's wait")
							return holding
						})
					/** Releases the held lease `pick` selects, or leases one when none is held. */
					const releaseOrLease = (pick: number) =>
						Effect.gen(function* () {
							const [first, ...rest] = held
							if (first === undefined) {
								return yield* lease
							}
							yield* release(pickFrom([first, ...rest], pick))
						})
					for (const step of steps) {
						switch (step.kind) {
							case "lease":
								if (held.length < max) {
									yield* lease
								} else {
									yield* releaseOrLease(0)
								}
								break
							case "release":
								yield* releaseOrLease(step.pick)
								break
							case "lose": {
								const [first, ...rest] = [...server.ready]
								if (first === undefined) {
									yield* lease
									break
								}
								pickFrom([first, ...rest], step.pick).hangUp()
								yield* settle
								const lost = Arr.filter(held, (h) => h.session.state() === "ended")
								for (const h of lost) {
									yield* release(h)
								}
								c.note(lost.length > 0 ? "lost a leased connection" : "lost an idle connection")
								break
							}
							case "pause": {
								while (held.length < Math.min(2, max)) {
									yield* lease
								}
								yield* releaseOrLease(0)
								yield* settle
								const open = server.open.size
								const terminated = server.terminated
								/**
								 * The released session idles past the least delay a Node timer waits: a timer set now runs
								 * after any pg's Pool set at the release, since Node keeps the timers of one delay in one list
								 * in the order they were set and runs a shorter one no later (node v26.13.0
								 * lib/internal/timers.js, "any timer added later will always have been scheduled to timeout
								 * later"), so an idle timeout of that delay would have closed it by then.
								 */
								const idled = Effect.andThen(wallClock(timerMinMs), settle)
								yield* idled
								assert.equal(server.terminated, terminated, "no session is closed for idling")
								assert.equal(server.open.size, open, "the released session is still open")
								c.note("a released session kept open while idle")
								break
							}
							case "starve": {
								const count = leaseCount(step.leases, max)
								const waiters = Math.max(0, count - (max - held.length))
								const leases = yield* Effect.forEach(
									upTo(count, (i) => i + 1),
									() =>
										Effect.forkChild(Effect.scoped(Effect.andThen(pool.lease, Effect.never)), {
											startImmediately: true
										})
								)
								yield* settle
								assert.equal(
									pool.native.waitingCount,
									0,
									"a lease waits for a permit, never in pg's queue"
								)
								yield* Fiber.interruptAll(leases)
								for (const exit of yield* Fiber.awaitAll(leases)) {
									assert.ok(
										Exit.hasInterrupts(exit),
										"a lease taken at once ends as an interruption"
									)
								}
								c.note(waitingOf(waiters))
								yield* releaseOrLease(0)
								break
							}
							case "abandon": {
								if (held.length === max) {
									yield* releaseOrLease(0)
									break
								}
								server.holding = true
								const opened = server.opened
								const waiter = yield* Effect.forkChild(Effect.scoped(pool.lease), {
									startImmediately: true
								})
								const connecting = server.opened > opened
								yield* Fiber.interrupt(waiter)
								const exit = yield* Fiber.await(waiter)
								server.releaseHeld()
								if (Exit.isSuccess(exit)) {
									break
								}
								assert.ok(Exit.hasInterrupts(exit), "the wait ends as an interruption")
								c.note(
									connecting
										? "abandoned while connecting"
										: "abandoned while pg handed over an idle session"
								)
								break
							}
							case "cut": {
								if (held.length === max) {
									yield* releaseOrLease(0)
									break
								}
								const holding = yield* cut(step, () => Effect.void)
								c.note(holding ? "cut holding its session" : "cut mid-acquisition")
								break
							}
							case "race": {
								while (held.length < max) {
									yield* lease
								}
								const [first] = held
								if (first === undefined) {
									break
								}
								const holding = yield* cut(step, (turn) =>
									turn === step.freeAt ? release(first) : Effect.void
								)
								if (step.freeAt >= step.at) {
									yield* release(first)
								} else {
									c.note(
										holding ? "cut holding its session" : "cut as a release handed it the permit"
									)
								}
								break
							}
							case "refuse": {
								while (pool.native.idleCount > 0 && held.length < max) {
									yield* lease
								}
								if (held.length === max) {
									yield* releaseOrLease(0)
									break
								}
								server.next = step.startup
								const scope = yield* Scope.fork(poolScope)
								const exit = yield* Effect.exit(Scope.provide(pool.lease, scope))
								yield* Scope.close(scope, Exit.void)
								assert.equal<Startup>(server.next, "ready", "the lease opened a connection")
								const failure = typedFailureOf(exit)
								if (step.startup === "refused") {
									assert.equal(failure._tag, "StartupRefused")
									c.note("a refused connection")
								} else {
									assert.equal(failure._tag, "NoCancelKey")
									c.note("a connection without a cancellation key")
								}
								break
							}
						}
						yield* holds
					}
					for (const h of Arr.copy(held)) {
						yield* release(h)
					}
					yield* holds
					/**
					 * Every attempt answered: pg's Pool answers each, a left lease's too, once the server has answered it.
					 * Then every permit is free, none lost to an attempt a lease left.
					 */
					const answered: Effect.Effect<PoolState> = Effect.filterOrElse(
						pool.state,
						(state) => state.attempting === 0,
						() => Effect.andThen(settle, answered)
					)
					const quiet = yield* answered
					assert.equal(
						quiet.free,
						max,
						`every permit is free once every lease returned: ${Formatter.format(quiet)}`
					)
					/** Every session up to the maximum at once, the clock standing still: no permit was lost. */
					const recovered = yield* Effect.scoped(
						Effect.all(
							Arr.map(
								upTo(max, (i) => i + 1),
								() => pool.lease
							),
							{ concurrency: max }
						)
					)
					assert.equal(new Set(recovered).size, max, "each lease holds a session of its own")
					yield* Scope.close(poolScope, Exit.void)
					yield* settle
					assert.equal(server.open.size, 0, "the ended pool closed every connection")
				}),
		oracle: {
			kind: "second-implementation",
			name: "a model of the leases held, against the server's open connections and pg's Pool's counts"
		},
		budget: { runs: 40, steered: 16 },
		kept: [
			{
				token: ReplayToken(
					"test/unit/adapter/pool.test.ts#theSessionPoolKeepsExactlyTheOpenConnectionsAndRecoversFromEveryInterruptionLossAndRefusalOverDrawnSequences:-:1.a.0.5.5.0.4.3.0.2.0.2.0.8.0.8.1.4.0"
				),
				reason:
					"abandonments, losses, leases waiting behind one another, and refusals on a pool of two",
				since: "2026-11-11"
			},
			{
				token: ReplayToken(
					"test/unit/adapter/pool.test.ts#theSessionPoolKeepsExactlyTheOpenConnectionsAndRecoversFromEveryInterruptionLossAndRefusalOverDrawnSequences:-:0.5.6.0.0.6.2.0.6.o.5.7.0.0.6.0.7.1.0.4.1"
				),
				reason: "cuts at every early turn, alone and racing a release, on a pool of one",
				since: "2026-10-29"
			}
		],
		kills: [
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\tclient?.release(false)\n\t\t\towner.permitBack()",
				replacement: "\t\t\tclient?.release(false)",
				why: "A lease abandoned while pg connects it never gives its permit back."
			},
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\t\t\tpermits = withdrawn(permits, ask)\n",
				replacement: "",
				why: "An interrupted waiter stays queued, so a permit goes to it and is lost."
			},
			{
				file: "packages/grizzle/src/adapter/wire/session.ts",
				original: "\t\t\tidleTimeoutMillis: 0\n",
				replacement: "\t\t\tidleTimeoutMillis: 1\n",
				why: "The pool closes a session idle for a millisecond, as it closed one idle past the caller's idleTimeoutMs: the next lease opens a cold session in its place."
			}
		]
	})
