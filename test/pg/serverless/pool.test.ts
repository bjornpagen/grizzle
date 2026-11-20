/**
 * A lease's wait for a pooled session (adapter/wire/session.ts makePool), which has no deadline of grizzle's: it holds
 * nothing, and an interruption, the caller's own timeout among them, ends it.
 *
 * - The waiter, as one finite space exhausted: the pool's maximum (1 to 3) by the sessions already leased (none up to
 *   the maximum) by what ends the wait. With fewer sessions leased than the maximum the waiter's own connection is being
 *   established, held at its password Effect until the case lets it through; with all of them leased it waits for one
 *   of the pool's permits, and nothing ever waits in pg's queue. The waiter interrupted, with the clock standing still,
 *   ends at once; a leased session released goes to a queued waiter, and one whose connection is being established gets
 *   a session; the layer released first closes the pool's scope at once, awaiting neither the leases nor the network,
 *   every leased session ended once it returns, and a lease then fails with LayerReleased, pg never asked for a client
 *   and no connection attempted. In every case the waiter holds nothing afterwards, every permit is free again, and
 *   then every session up to the maximum is leased at once. The oracle is the pool's own counts and the waiter's exit,
 *   against this specification; the clock stands still, so a wait that needed it to move would never end, which the
 *   case's hang bound reports.
 * - Cut leases, over drawn interleavings of up to eight leases started at once on a pool of one to three, each kept to
 *   its end or cut: after a drawn number of the scheduler's turns, once its own connection asks for its password, once
 *   it holds its session, or while its statement waits on a lock the case holds, once pg_stat_activity shows its
 *   backend waiting on that lock: a CancelRequest that reaches a backend still reading its statement is ignored
 *   (REL_19_0 src/backend/tcop/postgres.c 3536-3546), so a cut as the statement is sent cuts no statement that waits.
 *   Every cut point is reached by what the case observes, never by the clock. Once every lease has settled and pg has answered every connection, the pool is at
 *   its baseline (nothing leased, no client checked out of pg's Pool, nothing queued, no lease left asking, every
 *   permit free: free, attempting and leased permits are the maximum in all, and none attempting), every kept
 *   lease succeeded and every cut one ended as an interruption, the pool opens at most its maximum, and a further lease
 *   of the maximum at once succeeds, none of them a session a cut destroyed mid-statement, on a backend none of those
 *   ran on. The oracle is the pool's counts against that baseline.
 *
 * That a retired or lost session's release closes it is test/pg/adapter/pool.test.ts's: a lease closes and replaces a
 * pooled session that is not open (makePool's hygiene), so no case here can tell a retired session kept idle.
 *
 * Features: each place a waiter waits by each ending; each place a lease is cut, a lease kept to its end, and more
 * leases than the pool holds.
 */

import { appendAll } from "@bjornpagen/grizzle-text/base/array"
import { assert, lacks } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite, aimed } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Result,
	Scheduler,
	Scope
} from "effect"
import { LayerReleased } from "#adapter/errors/failures.ts"
import type { Session } from "#adapter/wire/session.ts"
import {
	backendPidOf,
	backendState,
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import {
	AskingLease,
	connectCalls,
	connectsInFlight,
	eventLoopTurn,
	gatedPassword,
	instant,
	type InterleavingFeature,
	interleavingGen,
	interleavingSituations,
	type LeasePlan,
	lockWait,
	type Progress,
	settledPermits,
	situations,
	statementLock,
	type WaiterFeature,
	waiters,
	whereOf,
	interleavingAims
} from "#test/pg/serverless/pool.fixtures.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A lease's wait for a pooled session ends at once when interrupted, or with a session released, has no deadline of its own, and leaks nothing.
 */
export const aLeasesWaitForAPooledSessionEndsAtOnceWhenInterruptedOrWithASessionReleasedHasNoDeadlineOfItsOwnAndLeaksNothing =
	property.exhaust(finite(waiters), {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<WaiterFeature>>,
		check:
			({ substrate }, c: Case<WaiterFeature>) =>
			(w) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						/**
						 * The waiter holds nothing: the leases taken before are the only ones, and nothing more than the
						 * maximum was opened.
						 */
						const reader = yield* substrateLogin(schema, "server", roleDefaults)

						const where = whereOf(w)
						const gate = yield* gatedPassword(reader.password)
						/**
						 * The pool in a scope of its own, a child of the case's: the layer's, which the released layer
						 * closes.
						 */
						const scope = yield* Effect.scope
						const poolScope = yield* Scope.fork(scope)
						const pool = yield* Scope.provide(
							poolFor(reader, {
								...defaultPool,
								password: { kind: "given", password: gate.password },
								pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: w.max }
							}),
							poolScope
						)
						/** Each held lease in a scope of its own, a child of the case's, so a failing case still releases it. */
						const held: Array<{
							readonly scope: Scope.Closeable
							readonly session: Session
							readonly pid: number
						}> = []
						for (let i = 0; i < w.held; i++) {
							const leaseScope = yield* Scope.fork(scope)
							const session = yield* Scope.provide(pool.lease, leaseScope)
							const pid = yield* backendPidOf(session)
							held.push({ scope: leaseScope, session, pid })
						}
						const { leased: heldNow } = yield* pool.state
						assert.equal(heldNow, w.held)
						if (w.ending === "layer released") {
							yield* Scope.close(poolScope, Exit.void)
							assert.ok(pool.native.ending, "pg's Pool is ending")
							for (const h of held) {
								assert.equal(
									h.session.state(),
									"ended",
									"the layer's release ends every leased session at once"
								)
							}
							const asked = connectCalls(pool.native)
							const attempts = gate.state.attempts
							const exit = yield* Effect.exit(Effect.scoped(pool.lease))
							const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
							assert.ok(Result.isSuccess(error), "the lease fails")
							const failure = error.success
							assert.ok(failure instanceof LayerReleased, String(failure))
							assert.equal(asked(), 0, "pg is never asked for a client")
							assert.equal(gate.state.attempts, attempts, "no connection is attempted")
							assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
							const { leased } = yield* pool.state
							assert.equal(leased, w.held)
							for (const h of held) {
								yield* Scope.close(h.scope, Exit.void)
							}
							const size = yield* pool.size
							assert.equal(size, 0, "the ended pool holds no session")
							c.note(`${where} ${w.ending}`)
							return
						}
						if (where === "establishing") {
							yield* gate.close
						}
						/** Started at once, the waiter runs until it waits: for a permit, or at its connection's password. */
						const waiter = yield* Effect.forkChild(
							Effect.scoped(Effect.flatMap(pool.lease, backendPidOf)),
							{ startImmediately: true }
						)
						assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
						if (where === "establishing") {
							yield* until(Effect.sync(() => gate.state.holding === 1))
						}
						let leased = w.held
						switch (w.ending) {
							case "interrupted": {
								const exit = yield* Effect.andThen(Fiber.interrupt(waiter), Fiber.await(waiter))
								assert.ok(Exit.hasInterrupts(exit), "the wait ends as an interruption")
								assert.ok(Result.isFailure(Exit.findError(exit)), "with no failure of its own")
								if (where === "establishing") {
									yield* gate.open
									yield* until(Effect.map(pool.size, (size) => size === w.held + 1))
								}
								break
							}
							case "released": {
								const [released, ...rest] = held
								if (released === undefined) {
									return yield* Effect.die(new Error("no lease to release"))
								}
								yield* Scope.close(released.scope, Exit.void)
								if (where === "establishing") {
									yield* gate.open
								}
								const pid = yield* Fiber.join(waiter)
								if (where === "saturated") {
									assert.equal(pid, released.pid)
								} else {
									assert.ok(pid > 0)
								}
								held.splice(0, held.length)
								appendAll(held, rest)
								leased = w.held - 1
								break
							}
						}
						const { leased: leasedNow } = yield* pool.state
						assert.equal(leasedNow, leased)
						const sizeNow = yield* pool.size
						assert.ok(sizeNow <= w.max)
						for (const h of held) {
							yield* Scope.close(h.scope, Exit.void)
						}
						const { leased: leasedAfter } = yield* pool.state
						assert.equal(leasedAfter, 0)
						yield* settledPermits(pool, w.max)
						/** Every session up to the maximum at once. */
						const pids = yield* Effect.scoped(
							Effect.all(
								Array.from({ length: w.max }, () => Effect.flatMap(pool.lease, backendPidOf)),
								{ concurrency: w.max }
							)
						)
						assert.equal(new Set(pids).size, w.max)
						c.note(`${where} ${w.ending}`)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a lease's wait holds nothing and has no deadline: the pool's counts and the waiter's exit"
		},
		box: "every maximum of 1 to 3, by the sessions already leased, by what ends the wait",
		kept: [],
		kills: []
	})

/**
 * A lease's wait for a pooled session loses no permit or client to leases cut at arbitrary points, over drawn interleavings.
 *
 * Its pre-conversion budget: runs 30, coverage cases 30 (test/pg/serverless/pool.test.ts at 991e0f9ab).
 */
export const aLeasesWaitForAPooledSessionLosesNoPermitOrClientToLeasesCutAtArbitraryPointsOverDrawnInterleavings =
	property.explore(aimed(interleavingGen, interleavingAims), {
		needs: { substrate: Substrate.installing },
		situations: interleavingSituations satisfies ReadonlyArray<Reached<InterleavingFeature>>,
		check:
			({ substrate }, c: Case<InterleavingFeature>) =>
			({ max, leases }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const reader = yield* substrateLogin(schema, "server", roleDefaults)

						/** The leases the pool started a connection for: each connection's password names its lease. */
						const connecting = new Set<number>()
						/** The gate of each lease cut once its connection asks for its password, which its cut opens. */
						const gates = yield* Effect.forEach(leases, () => Deferred.make<void>())
						const password = Effect.flatMap(AskingLease, (lease) => {
							if (Option.isNone(lease)) {
								return Effect.succeed(reader.password)
							}
							connecting.add(lease.value)
							const plan = leases[lease.value]
							const gate = gates[lease.value]
							return plan?.cut.kind === "cut" &&
								plan.cut.at.kind === "establishing" &&
								gate !== undefined
								? Effect.as(Deferred.await(gate), reader.password)
								: Effect.succeed(reader.password)
						})
						if (Arr.some(leases, (plan) => plan.cut.kind === "running")) {
							const holder = yield* s.session({ ...ownerSession(), label: "statement lock" })
							yield* holder.query("SELECT pg_catalog.pg_advisory_lock($1::int8)", [statementLock])
						}
						const pool = yield* poolFor(reader, {
							...defaultPool,
							password: { kind: "given", password },
							pool: { idleTimeoutMs: testIdleTimeout, min: 1, max }
						})
						const inFlight = connectsInFlight(pool.native)
						if (leases.length > max) {
							c.note("more leases than the pool holds")
						}
						/**
						 * What each lease reached; each session a lease runs statements on, from before its first; and that
						 * session's backend, once read.
						 */
						const progress: Array<Progress> = Arr.map(leases, (): Progress => ({
							kind: "asking"
						}))
						const ran = new Set<Session>()
						const backends = new Map<Session, number>()
						const leaseOf = (plan: LeasePlan, index: number) =>
							Effect.scoped(
								Effect.gen(function* () {
									const session = yield* pool.lease
									progress[index] = { kind: "holding" }
									if (plan.work === "statement") {
										ran.add(session)
										const pid = yield* backendPidOf(session)
										backends.set(session, pid)
										progress[index] = { kind: "running", backend: pid }
										yield* plan.cut.kind === "running"
											? rowsOn(session, lockWait, [statementLock])
											: rowsOn(session, instant, [])
										progress[index] = { kind: "holding" }
									}
									if (plan.cut.kind !== "kept") {
										return yield* Effect.never
									}
								})
							)
						const fibers = yield* Effect.forEach(leases, (plan, index) => {
							const lease = Effect.provideService(
								leaseOf(plan, index),
								AskingLease,
								Option.some(index)
							)
							return Effect.forkChild(
								plan.cut.kind === "cut" && plan.cut.at.kind === "turns"
									? Effect.provideService(lease, Scheduler.MaxOpsBeforeYield, plan.cut.at.ops)
									: lease,
								{ startImmediately: true }
							)
						})
						/** Whether a lease's fiber has ended, kept to its end or cut, as the fiber itself tells. */
						const ended = (i: number): boolean => fibers[i]?.pollUnsafe() !== undefined
						/**
						 * Whether the pool can hand no lease still running anything: each of them asks, no session is leased and pg
						 * answered every connection, and so still a turn of the event loop later, once the fibers its answers woke have
						 * run. A pool that keeps its permits never stays so, since a lease's release or pg's answer hands a permit on at
						 * once; a permit or client lost to a lease that left leaves the rest asking for good, so the drawn cuts and the
						 * settling end there rather than wait for it.
						 */
						const starvedNow = Effect.map(pool.state, ({ leased: leasedNow }) => {
							const running = Arr.filter(
								Arr.map(leases, (_, i) => i),
								(i) => !ended(i)
							)
							return (
								running.length > 0 &&
								Arr.every(running, (i) => progress[i]?.kind === "asking") &&
								leasedNow === 0 &&
								inFlight() === 0
							)
						})
						const starved = Effect.gen(function* () {
							if (!(yield* starvedNow)) {
								return false
							}
							yield* eventLoopTurn
							return yield* starvedNow
						})
						yield* Effect.forEach(
							leases,
							(plan, index) =>
								Effect.gen(function* () {
									const fiber = fibers[index]
									const cut = plan.cut
									if (cut.kind === "kept" || fiber === undefined) {
										return
									}
									if (cut.kind === "running") {
										yield* until(
											Effect.map(starved, (stuck) => stuck || progress[index]?.kind === "running")
										)
										const reaching = progress[index]
										if (reaching?.kind === "running") {
											yield* until(
												Effect.map(
													backendState(reaching.backend),
													(backend) => backend.waitEvent === "advisory"
												)
											)
										}
									} else {
										const at = cut.at
										switch (at.kind) {
											case "turns":
												for (let turn = 0; turn < at.turns; turn++) {
													yield* Effect.yieldNow
												}
												break
											case "held":
												yield* until(
													Effect.map(
														starved,
														(stuck) => stuck || progress[index]?.kind !== "asking"
													)
												)
												break
											case "establishing":
												yield* until(
													Effect.map(
														starved,
														(stuck) =>
															stuck || connecting.has(index) || progress[index]?.kind !== "asking"
													)
												)
												break
										}
									}
									const reached = progress[index]?.kind
									const establishing = connecting.has(index)
									yield* Fiber.interrupt(fiber)
									const gate = gates[index]
									if (gate !== undefined) {
										yield* Deferred.succeed(gate, undefined)
									}
									switch (reached) {
										case "asking":
											c.note(
												establishing
													? "cut while asking, a connection being established"
													: "cut while asking"
											)
											break
										case "holding":
											c.note("cut holding its session")
											break
										case "running":
											c.note("cut running a statement")
											break
										case undefined:
											break
									}
								}),
							{ concurrency: "unbounded", discard: true }
						)
						yield* until(
							Effect.map(starved, (stuck) => stuck || Arr.every(fibers, (_, i) => ended(i)))
						)
						/** The leases still asking once the pool could hand them nothing, cut here so the case settles. */
						const waiting = Arr.filter(
							Arr.map(leases, (_, i) => i),
							(i) => !ended(i)
						)
						yield* Effect.forEach(waiting, (i) => {
							const fiber = fibers[i]
							return fiber === undefined ? Effect.void : Fiber.interrupt(fiber)
						})
						yield* until(Effect.sync(() => inFlight() === 0))
						const { leased: leasedSettled } = yield* pool.state
						assert.equal(leasedSettled, 0, "once every lease settled, the pool leases nothing")
						assert.equal(
							pool.native.totalCount - pool.native.idleCount,
							0,
							"once every lease settled and pg answered every connection, no client is checked out of pg's Pool"
						)
						assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
						assert.deepEqual(waiting, [], "no lease waits on a permit the pool no longer hands on")
						yield* settledPermits(pool, max)
						const exits = yield* Fiber.awaitAll(fibers)
						for (const [index, exit] of exits.entries()) {
							const plan = leases[index]
							if (plan?.cut.kind === "kept") {
								assert.ok(Exit.isSuccess(exit), `kept lease ${index} succeeds`)
								c.note("kept to its end")
							} else {
								assert.ok(
									Exit.isSuccess(exit) || Exit.hasInterrupts(exit),
									`cut lease ${index} ends as an interruption`
								)
							}
						}
						const size = yield* pool.size
						assert.ok(size <= max, "the pool opens at most its maximum")
						yield* until(Effect.map(roleBackends(reader.role), (n) => n <= max))
						/**
						 * The sessions a cut destroyed mid-statement, as each one's own state tells once every lease has ended: a
						 * cut that landed once its statement had answered left the session open, for the pool to hand out again.
						 */
						const destroyed = Arr.filter(ran, (session) => session.state() !== "open")
						const again = yield* Effect.scoped(
							Effect.all(
								Array.from({ length: max }, () =>
									Effect.flatMap(pool.lease, (session) =>
										Effect.map(backendPidOf(session), (pid) => ({ session, pid }))
									)
								),
								{ concurrency: max }
							)
						)
						assert.equal(
							new Set(Arr.map(again, (a) => a.session)).size,
							max,
							"each further lease holds a session of its own"
						)
						for (const cut of destroyed) {
							lacks(
								Arr.map(again, (a) => a.session),
								cut,
								"a session destroyed mid-statement is never handed out again"
							)
							const pid = backends.get(cut)
							if (pid !== undefined) {
								lacks(
									Arr.map(again, (a) => a.pid),
									pid,
									"its backend is never reused"
								)
							}
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "the pool back at its baseline once every lease settled: no permit or client lost"
		},
		budget: { runs: 30, steered: 30 },
		kept: [],
		kills: []
	})
