/**
 * The session pool's lifecycle against the cluster (adapter/wire/session.ts).
 *
 * - Retirement: over drawn lease sequences on a pool of a drawn maximum (1 to 3), each step leasing a session,
 *   releasing one, retiring one and releasing it, or ending one's connection and releasing it, against a model of the
 *   pool's leased, idle and retired sessions: after every step the pool's leased count is the model's, a retired or
 *   lost session's release closes exactly that session where any other release keeps it, a leased session is never one
 *   the model retired, its backend never a retired one's, and every retired backend exits.
 * - Interruption: exhaustively over the pool's maximum, the statement (a sleep, or a wait for an advisory lock another
 *   session holds) and its flight (alone, or in a transaction ending with COMMIT), an interrupted statement stops on the
 *   server, its session is destroyed and its backend leaves pg_stat_activity, and the pool's next leases, its maximum
 *   at once, are other sessions on other backends.
 * - Release: exhaustively over where the one session of a stalled transport stands (idle, leased, or running a
 *   statement whose answer the tap's gate cuts after each of its first messages), releasing the layer awaits nothing
 *   and has ended the session once it returns, and a statement in flight fails, or delivers its whole answer, never a
 *   part of it.
 *
 * Features: each step kind, a lease after a retirement, an idle and a new session leased; every statement in every
 * flight; every standing, a release before any answer and mid-answer.
 */

import { assert, lacks } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Exit, Fiber, Scope } from "effect"
import type { Session } from "#adapter/wire/session.ts"
import {
	type Held,
	interruptedCases,
	type InterruptedFeature,
	lockKey,
	longStatement,
	type PoolFeature,
	runIn,
	sequenceGen,
	seriesSql,
	situations,
	type StalledFeature,
	standings
} from "#test/pg/adapter/pool.fixtures.ts"
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
import { testIdleTimeout } from "#test/support/limits.ts"
import { pickFrom } from "#test/support/pick.ts"
import { freshSchema, ownerSession, Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"

/**
 * Adapter session pool never hands out a retired or lost session again, over drawn lease sequences.
 *
 * Its pre-conversion budget: runs 20, coverage cases 20 (test/pg/adapter/pool.test.ts at 991e0f9ab).
 */
export const adapterSessionPoolNeverHandsOutARetiredOrLostSessionAgainOverDrawnLeaseSequences =
	property.explore(sequenceGen, {
		needs: { substrate: Substrate.installing },
		situations: situations satisfies ReadonlyArray<Reached<PoolFeature>>,
		check:
			({ substrate }, c: Case<PoolFeature>) =>
			({ max, steps }) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const reader = yield* substrateLogin(schema, "server", roleDefaults)

						const pool = yield* poolFor(reader, {
							...defaultPool,
							pool: { idleTimeoutMs: testIdleTimeout, min: 1, max }
						})
						const scope = yield* Effect.scope
						const held: Array<Held> = []
						const idle = new Set<Session>()
						const retired = new Set<Session>()
						const retiredPids = new Set<number>()
						const lease = Effect.gen(function* () {
							const leaseScope = yield* Scope.fork(scope)
							const before = yield* pool.size
							const session = yield* Scope.provide(pool.lease, leaseScope)
							lacks([...retired], session, "a retired session is never handed out again")
							assert.equal(session.state(), "open", "a leased session is open")
							const pid = yield* backendPidOf(session)
							lacks([...retiredPids], pid, "a retired backend is never reused")
							if (retired.size > 0) {
								c.note("leased after a retirement")
							}
							if (idle.has(session)) {
								idle.delete(session)
								c.note("leased an idle session")
							} else {
								const size = yield* pool.size
								assert.equal(size, before + 1, "a session not idle before is a new one")
								c.note("leased a new session")
							}
							held.push({ session, pid, scope: leaseScope })
						})
						/** Releases the held session `h`; a retired or lost one is closed, any other kept idle. */
						const release = (h: Held, ends: boolean) =>
							Effect.gen(function* () {
								const before = yield* pool.size
								held.splice(held.indexOf(h), 1)
								yield* Scope.close(h.scope, Exit.void)
								if (ends) {
									retired.add(h.session)
									retiredPids.add(h.pid)
									const size = yield* pool.size
									assert.equal(size, before - 1, "a retired session's release closes it")
								} else {
									idle.add(h.session)
									const size = yield* pool.size
									assert.equal(size, before, "a release keeps the session")
								}
							})
						for (const step of steps) {
							const [first, ...rest] = held
							if (first === undefined || (step.kind === "lease" && held.length < max)) {
								yield* lease
								continue
							}
							const h = pickFrom([first, ...rest], step.pick)
							switch (step.kind) {
								case "lease":
								case "release":
									yield* release(h, false)
									c.note("released")
									break
								case "retire":
									h.session.retire()
									yield* release(h, true)
									c.note("retired")
									break
								case "lose":
									h.session.destroy()
									assert.equal(h.session.state(), "ended", "a destroyed session is ended at once")
									yield* release(h, true)
									c.note("connection lost")
									break
							}
							const { leased } = yield* pool.state
							assert.equal(leased, held.length)
							const size = yield* pool.size
							assert.ok(size <= max)
						}
						for (const h of Arr.copy(held)) {
							yield* release(h, false)
						}
						const { leased } = yield* pool.state
						assert.equal(leased, 0)
						for (const pid of retiredPids) {
							yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
						}
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "second-implementation",
			name: "a model of the pool's leased, idle and retired sessions"
		},
		budget: { runs: 20, steered: 20 },
		kept: [],
		kills: []
	})

/**
 * Adapter session pool stops an interrupted statement's backend and never hands its session out again.
 */
export const adapterSessionPoolStopsAnInterruptedStatementsBackendAndNeverHandsItsSessionOutAgain =
	property.exhaust(finite(interruptedCases), {
		needs: { substrate: Substrate.installing },
		situations: [
			"sleep alone",
			"sleep transaction",
			"lock alone",
			"lock transaction"
		] satisfies ReadonlyArray<Reached<InterruptedFeature>>,
		check:
			({ substrate }, c: Case<InterruptedFeature>) =>
			(k) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const login = yield* substrateLogin(schema, "server", roleDefaults)

						const pool = yield* poolFor(login, {
							...defaultPool,
							pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: k.max }
						})
						if (k.statement === "lock") {
							const holder = yield* s.session({ ...ownerSession(), label: "lock holder" })
							yield* holder.query("SELECT pg_catalog.pg_advisory_lock($1::int8)", [lockKey])
						}
						const scope = yield* Effect.scope
						const leaseScope = yield* Scope.fork(scope)
						const session = yield* Scope.provide(pool.lease, leaseScope)
						const pid = yield* backendPidOf(session)
						const call = yield* Effect.forkChild(runIn(session, k.form, longStatement(k.statement)))
						yield* until(
							Effect.map(backendState(pid), (b) =>
								k.statement === "sleep"
									? b.state === "active" && b.waitEvent === "PgSleep"
									: b.state === "active" && b.waitEvent === "advisory"
							)
						)
						const exit = yield* Effect.andThen(Fiber.interrupt(call), Fiber.await(call))
						assert.ok(Exit.hasInterrupts(exit), "the call ends as its interruption")
						const stopped = yield* backendState(pid)
						assert.equal(
							stopped.state,
							"idle",
							"the server has stopped the statement once the call ended"
						)
						assert.equal(session.state(), "retired", "the interrupted session is never used again")
						const open = yield* pool.size
						yield* Scope.close(leaseScope, Exit.void)
						const kept = yield* pool.size
						assert.equal(kept, open - 1, "the released interrupted session is closed at once")
						yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
						const { leased } = yield* pool.state
						assert.equal(leased, 0)
						const again = yield* Effect.scoped(
							Effect.all(
								Array.from({ length: k.max }, () =>
									Effect.flatMap(pool.lease, (next) =>
										Effect.map(backendPidOf(next), (nextPid) => ({ next, nextPid }))
									)
								),
								{ concurrency: k.max }
							)
						)
						lacks(
							Arr.map(again, (a) => a.next),
							session,
							"the interrupted session is never handed out again"
						)
						lacks(
							Arr.map(again, (a) => a.nextPid),
							pid,
							"its backend is never reused"
						)
						c.note(`${k.statement} ${k.form}`)
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "README: an interrupted statement is cancelled and its session never used again"
		},
		box: "every maximum of 1 to 3, statement waited on and flight",
		kept: [],
		kills: []
	})

/**
 * Adapter session pool releases a layer whose transport stalls, awaiting nothing from it.
 */
export const adapterSessionPoolReleasesALayerWhoseTransportStallsAwaitingNothingFromIt =
	property.exhaust(finite(standings), {
		needs: { substrate: Substrate.installing },
		situations: [
			"released idle",
			"released leased",
			"released before any answer",
			"released mid-answer"
		] satisfies ReadonlyArray<Reached<StalledFeature>>,
		check:
			({ substrate }, c: Case<StalledFeature>) =>
			(standing) =>
				Effect.provideServiceEffect(
					Effect.gen(function* () {
						const s = yield* Substrate
						const schema = yield* s.schema(freshSchema)
						const login = yield* substrateLogin(schema, "server", roleDefaults)

						const tap = makeTap(s.cluster)
						const scope = yield* Effect.scope
						const layerScope = yield* Scope.fork(scope)
						const pool = yield* Scope.provide(
							poolFor(login, {
								...defaultPool,
								transport: { kind: "given", transport: tap.transport },
								pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
							}),
							layerScope
						)
						const leaseScope = yield* Scope.fork(scope)
						const session = yield* Scope.provide(pool.lease, leaseScope)
						const pid = yield* backendPidOf(session)
						switch (standing.kind) {
							case "idle":
							case "leased": {
								if (standing.kind === "idle") {
									yield* Scope.close(leaseScope, Exit.void)
								}
								tap.gate.hold(0, { kind: "any" })
								yield* Scope.close(layerScope, Exit.void)
								assert.equal(
									session.state(),
									"ended",
									"the layer's release ends its session at once"
								)
								c.note(`released ${standing.kind}`)
								break
							}
							case "running": {
								tap.gate.hold(standing.through, { kind: "any" })
								const call = yield* Effect.forkChild(
									rowsOn(session, seriesSql, [String(standing.rows)]),
									{ startImmediately: true }
								)
								yield* Effect.raceFirst(tap.gate.holding, Effect.asVoid(Fiber.await(call)))
								yield* Scope.close(layerScope, Exit.void)
								assert.equal(
									session.state(),
									"ended",
									"the layer's release ends its session at once"
								)
								const exit = yield* Fiber.await(call)
								if (Exit.isSuccess(exit)) {
									assert.deepEqual(
										exit.value,
										Array.from({ length: standing.rows }, (_, k) => [String(k + 1)]),
										"a statement that ends before the release delivers its whole answer"
									)
								} else {
									c.note(
										standing.through === 0 ? "released before any answer" : "released mid-answer"
									)
								}
								break
							}
						}
						yield* Scope.close(leaseScope, Exit.void)
						yield* until(Effect.map(backendState(pid), (b) => b.state === "gone"))
					}),
					Substrate,
					substrate
				),
		oracle: {
			kind: "specification",
			name: "a layer's release awaits nothing, and a statement it cuts fails or delivers its whole answer"
		},
		box: "a session idle, leased, or running a statement of up to three rows cut after each of its answer's first messages",
		kept: [],
		kills: []
	})
