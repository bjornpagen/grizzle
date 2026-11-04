import { layer } from "@effect/vitest"
import { exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	type Redacted,
	Result,
	Scope
} from "effect"
import { TestClock } from "effect/testing"
import { OpenError } from "#adapter/errors/execution.ts"
import { AcquisitionBudgetExceeded, LayerReleased } from "#adapter/errors/failures.ts"
import type { SessionPool } from "#adapter/wire/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import {
	backendPidOf,
	defaultPool,
	poolFor,
	roleDefaults,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { assert, matchesObject } from "#test/support/assert.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A lease's wait for a pooled session, under the fixed acquisition budget (packages/grizzle/src/adapter/pool/budgets.ts), as one finite
 * space exhausted: the pool's maximum (1 to 3) × the sessions already leased (none up to the maximum) × the wait budget
 * (1 ms or 2 s) × what ends the wait. With fewer sessions leased than the maximum the waiter's own connection is being
 * established, held at its password Effect until the case lets it through; with all of them leased it waits for one of
 * the pool's permits, and nothing ever waits in pg's queue. The wait ends one of three ways, or never begins:
 *
 * - the budget runs out: one millisecond short the waiter still waits, at the budget it fails with
 *   AcquisitionBudgetExceeded, at stage wait, which records the budget, the open and leased sessions and the maximum,
 *   and so whether every session up to the maximum was leased (a saturated pool) or one was still being established;
 * - the waiter is interrupted, with the clock standing still: the interruption completes at once, never as stage wait;
 * - a leased session is released within the budget: a waiter in the queue gets that very session, and one whose
 *   connection is being established gets a session;
 * - the layer is released first: the pool's scope closes with the leases still held, so pg's Pool is ending, and a
 *   lease then fails at once, the clock standing still, with LayerReleased, at stage released; pg is never asked for a
 *   client (where a waiter would have queued or opened a connection of its own),
 *   no connection is attempted, and the held leases end the pool once they are released.
 *
 * In every case the waiter holds nothing afterwards: a connection established for an abandoned wait joins the pool
 * idle, the leases taken before are the only ones, and then every session up to the maximum is leased at once without a
 * wait. The oracle is the pool's own counts (open and leased sessions) and the waiter's exit. The acquisition budget is
 * an Effect-clock timer, so the space runs on the TestClock; a wait that would need the clock to move is caught by a
 * wall-clock bound. The connection establishment budget, and sessions the server ended while idle, are reached only
 * through infrastructure faults (an unresponsive host, a killed backend), which are not tested.
 *
 * What ends the wait, or keeps it from beginning.
 */
type Ending = "budget expires" | "interrupted" | "released within budget" | "layer released"

/** Where the waiter waits: in the queue of a saturated pool, or for its own connection. */
type Where = "saturated" | "establishing"

interface Waiter {
	readonly max: number
	readonly held: number
	readonly waitMs: number
	readonly ending: Ending
}

type WaiterFeature = `${Where} ${Ending}`

const whereOf = (w: Pick<Waiter, "max" | "held">): Where =>
	w.held === w.max ? "saturated" : "establishing"

/** Every waiter, the maximum outermost: a release within the budget needs a session held to release. */
const waiters: Gen<Waiter> = (source) => {
	const max = source.draw(int(1, 3))
	const held = source.draw(int(0, max))
	const waitMs = source.draw(element([1, 2_000]))
	const ending = source.draw(
		element<Ending>([
			"budget expires",
			"interrupted",
			...(held > 0 ? (["released within budget"] as const) : []),
			"layer released"
		])
	)
	return { max, held, waitMs, ending }
}

const situations: Arr.NonEmptyReadonlyArray<WaiterFeature> = [
	"saturated budget expires",
	"saturated interrupted",
	"saturated released within budget",
	"establishing budget expires",
	"establishing interrupted",
	"establishing released within budget",
	"saturated layer released",
	"establishing layer released"
]

/** A lease as an operation sees it: a failed acquisition is its refusal, at the stage Db.open reports it at. */
const acquire = (pool: SessionPool) => pool.lease

/**
 * Counts the calls of pg's Pool#connect on `native` from now on: an own property in front of the method its class
 * defines, which the pool's lease calls on this very object, with its one callback.
 */
const connectCalls = (native: SessionPool["native"]): (() => number) => {
	let calls = 0
	const connect = native.connect.bind(native)
	Object.defineProperty(native, "connect", {
		configurable: true,
		value: (callback: unknown): unknown => {
			calls++
			return Reflect.apply(connect, native, [callback])
		}
	})
	return () => calls
}

/**
 * A password Effect that waits at a gate while the gate is closed, counting every connection attempt that evaluates it
 * and the attempts it holds at the gate.
 */
const gatedPassword = (secret: Redacted.Redacted) =>
	Effect.gen(function* () {
		const state = { closed: false, attempts: 0, holding: 0, gate: yield* Deferred.make<void>() }
		const password = Effect.suspend(() => {
			state.attempts++
			if (!state.closed) {
				return Effect.succeed(secret)
			}
			state.holding++
			return Effect.as(Deferred.await(state.gate), secret)
		})
		const close = Effect.sync(() => {
			state.closed = true
		})
		const open = Effect.flatMap(
			Effect.sync(() => {
				state.closed = false
			}),
			() => Deferred.succeed(state.gate, undefined)
		)
		return { state, password, close, open }
	})

layer(Substrate.layer)("a lease's wait for a pooled session", (it) => {
	it.effect(
		"ends at the budget as stage wait, at once when interrupted, or with a session released within the budget, and leaks nothing",
		(ctx) =>
			searched(
				ctx,
				Effect.gen(function* () {
					const s = yield* Substrate
					const schema = yield* s.schema(freshSchema)
					/**
					 * The waiter holds nothing: the leases taken before are the only ones, and nothing more than the
					 * maximum was opened.
					 */
					const reader = yield* substrateLogin(schema, "server", roleDefaults)
					return yield* exhaust(
						{
							suite: "serverless/pool waiter",
							generator: waiters,
							literal: Formatter.format,
							limit: 72,
							coverage: requiredInSpace<WaiterFeature>(situations),
							caseHang: Duration.minutes(2)
						},
						(w, c) =>
							Effect.gen(function* () {
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
										pool: { idleTimeoutMs: 60_000, min: 1, max: w.max },
										budgets: { waitMs: w.waitMs }
									}),
									poolScope
								)
								/**
								 * Each held lease in a scope of its own, a child of the case's, so a failing case still releases
								 * it and the pool can close.
								 *
								 * The clock stands still: a lease that waited for the budget would never end.
								 */
								const held: Array<{ readonly scope: Scope.Closeable; readonly pid: number }> = []
								for (let i = 0; i < w.held; i++) {
									const leaseScope = yield* Scope.fork(scope)
									const pid = yield* Effect.flatMap(
										Scope.provide(pool.lease, leaseScope),
										backendPidOf
									)
									held.push({ scope: leaseScope, pid })
								}
								const heldNow = yield* pool.leased
								assert.equal(heldNow, w.held)
								if (w.ending === "layer released") {
									/**
									 * The layer's release is under way at once and ends once the held leases are released.
									 */
									const release = yield* Effect.forkChild(Scope.close(poolScope, Exit.void))
									yield* until(Effect.sync(() => pool.native.ending))
									const asked = connectCalls(pool.native)
									const attempts = gate.state.attempts
									const refused = yield* Effect.forkChild(Effect.scoped(acquire(pool)))
									yield* until(Effect.sync(() => refused.pollUnsafe() !== undefined))
									const exit = yield* Fiber.await(refused)
									const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
									assert.ok(Result.isSuccess(error), "the lease fails")
									const failure = error.success
									assert.ok(failure instanceof LayerReleased, String(failure))
									assert.equal(new OpenError({ reason: failure }).stage, "released")
									assert.equal(asked(), 0, "pg is never asked for a client")
									assert.equal(gate.state.attempts, attempts, "no connection is attempted")
									assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
									const leased = yield* pool.leased
									assert.equal(leased, w.held)
									for (const h of held) {
										yield* Scope.close(h.scope, Exit.void)
									}
									yield* Fiber.join(release)
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
									Effect.scoped(Effect.flatMap(acquire(pool), backendPidOf)),
									{ startImmediately: true }
								)
								assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
								if (where === "establishing") {
									yield* until(Effect.sync(() => gate.state.holding === 1))
								}
								/** The established connection of an abandoned wait joins the pool, idle. */
								const letThrough = Effect.gen(function* () {
									if (where === "saturated") {
										return
									}
									yield* gate.open
									yield* until(Effect.map(pool.size, (size) => size === w.held + 1))
								})
								/**
								 * A saturated waiter takes the released session's permit, and with it the session itself.
								 */
								let leased = w.held
								switch (w.ending) {
									case "budget expires": {
										yield* TestClock.adjust(Duration.millis(w.waitMs - 1))
										yield* Effect.yieldNow
										assert.equal(
											waiter.pollUnsafe(),
											undefined,
											"one millisecond short, the waiter waits"
										)
										yield* TestClock.adjust(Duration.millis(1))
										const exit = yield* Fiber.await(waiter)
										const error = Exit.isFailure(exit)
											? Exit.findError(exit)
											: Result.fail(undefined)
										assert.ok(Result.isSuccess(error), "the wait fails")
										const failure = error.success
										assert.ok(failure instanceof AcquisitionBudgetExceeded, String(failure))
										const exceeded: AcquisitionBudgetExceeded = failure
										assert.equal(new OpenError({ reason: exceeded }).stage, "wait")
										matchesObject(exceeded, { millis: w.waitMs, leased: w.held, max: w.max })
										yield* letThrough
										break
									}
									case "interrupted": {
										/**
										 * The clock stands still: an interruption that had to wait for the budget would never end.
										 */
										const exit = yield* Effect.andThen(Fiber.interrupt(waiter), Fiber.await(waiter))
										assert.ok(Exit.hasInterrupts(exit), "the wait ends as an interruption")
										assert.ok(Result.isFailure(Exit.findError(exit)), "never as stage wait")
										yield* letThrough
										break
									}
									case "released within budget": {
										yield* TestClock.adjust(Duration.millis(w.waitMs - 1))
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
								const leasedNow = yield* pool.leased
								assert.equal(leasedNow, leased)
								const sizeNow = yield* pool.size
								assert.ok(sizeNow <= w.max)
								for (const h of held) {
									yield* Scope.close(h.scope, Exit.void)
								}
								const leasedAfter = yield* pool.leased
								assert.equal(leasedAfter, 0)
								/** Every session up to the maximum at once, without a wait. */
								const pids = yield* Effect.scoped(
									Effect.all(
										Array.from({ length: w.max }, () =>
											Effect.flatMap(acquire(pool), backendPidOf)
										),
										{ concurrency: w.max }
									)
								)
								assert.equal(new Set(pids).size, w.max)
								c.note(`${where} ${w.ending}`)
							})
					)
				}).pipe(Effect.scoped)
			)
	)
})
