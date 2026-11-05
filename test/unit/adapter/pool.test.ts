import { Buffer } from "node:buffer"
import type { TLSSocket } from "node:tls"
import { describe, it } from "@effect/vitest"
import { drawn, explore, type Kept } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { array, constant, element, type Gen, int, map, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Clock,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Result,
	Scheduler,
	Scope
} from "effect"
import pgDriver from "pg"
import type { PgSocket } from "#adapter/types/driver.ts"
import type { Transport } from "#adapter/types/layer.ts"
import { makePool, noPassword, type Session } from "#adapter/wire/session.ts"
import { assert } from "#test/support/assert.ts"
import {
	caseHang,
	nodeTimerMin,
	testConnectTimeout,
	testIdleTimeout
} from "#test/support/limits.ts"
import { memoryEndpoint, memoryTransport, tlsMaterial } from "#test/support/memory-tls.ts"
import { parsedConnection } from "#test/support/pg.ts"
import { pickFrom, pickGen } from "#test/support/pick.ts"

/**
 * The session pool's lifetime bookkeeping (packages/grizzle/src/adapter/wire/session.ts makePool) over a PostgreSQL
 * server in memory, behind the SSLRequest and verify-full TLS of grizzle's public transport (test/support/memory-tls.ts):
 * the pool must hold no connection, session, waiter or permit past its life, whatever leases, interruptions and
 * connection losses happen.
 *
 * A property over drawn sequences on a pool of a drawn maximum (1 to 3) whose idle timeout is short (pg closes idle
 * sessions above the floor while the sequence runs) or long. Each step leases a session and holds it, or releases a
 * held one; ends one of the server's connections, a leased session's or an idle one's; leases a second session where
 * the maximum allows and releases one above the floor, which a short timeout then closes; starves a saturated pool with
 * 1, 64 or 2,000 leases that wait for a permit until they are interrupted, then releases a session; abandons a lease,
 * interrupted while pg connects it or hands it an idle session; cuts a lease, interrupted at a drawn turn of the
 * scheduler, which runs it a drawn few operations a turn, so the cut lands at every step of its acquisition and of its
 * hold; races such a cut, on a lease queued behind a saturated pool, with a release at another drawn turn, often a turn
 * or few before the cut, which hands it the permit; or has the server refuse a connection, at startup or by sending no
 * cancellation key. After every step, at a turn of the event loop, once every idle timeout due has closed its session
 * (a short one is due at once): the sessions a release reaches are exactly the server's open connections, pg's Pool
 * counts exactly those, nothing waits in pg's queue, and the leased count is the model's. A wait has no deadline of its
 * own: it ends with a session, or as an interruption. At the end every held session is released, the pool leases its
 * maximum at once with the clock standing still (no permit was lost), and its end closes every connection at once, no
 * session left.
 *
 * How the server answers a startup: ready, with a cancellation key, or refused, at startup or with no key.
 */
type Refusal = "refused" | "no key"
type Startup = "ready" | Refusal

/** One step as drawn. */
type StepSketch =
	| { readonly kind: "lease" }
	| { readonly kind: "release"; readonly pick: number }
	| { readonly kind: "lose"; readonly pick: number }
	| { readonly kind: "expire" }
	| { readonly kind: "starve"; readonly waiters: number }
	| { readonly kind: "abandon" }
	| { readonly kind: "cut"; readonly at: number; readonly ops: number }
	| {
			readonly kind: "race"
			readonly at: number
			readonly freeAt: number
			readonly ops: number
	  }
	| { readonly kind: "refuse"; readonly startup: Refusal }

interface Sequence {
	readonly max: number
	readonly idle: "short" | "long"
	readonly steps: ReadonlyArray<StepSketch>
}

/** A scheduler turn at which a cut lands. */
const turnGen: Gen<number> = int(0, 24)

/**
 * The operations the scheduler runs a cut lease for before it yields: a few, so the turns step through its acquisition.
 * Effect never finishes closing a scope at fewer than 3.
 */
const opsGen: Gen<number> = int(3, 8)

/**
 * The turns between a race's release and its cut when the cut follows closely: so few that the lease the release handed
 * the permit to is cut before it holds its session, which a cut at an independent turn seldom is.
 */
const leadGen: Gen<number> = int(1, 3)

const stepGen: Gen<StepSketch> = oneOf<StepSketch>([
	constant({ kind: "lease" }),
	(source) => ({ kind: "release", pick: source.draw(pickGen) }),
	(source) => ({ kind: "lose", pick: source.draw(pickGen) }),
	constant({ kind: "expire" }),
	(source) => ({ kind: "starve", waiters: source.draw(element([1, 64, 2_000])) }),
	constant({ kind: "abandon" }),
	(source) => ({ kind: "cut", at: source.draw(turnGen), ops: source.draw(opsGen) }),
	(source) => {
		const freeAt = source.draw(turnGen)
		return {
			kind: "race",
			at: source.draw(oneOf([turnGen, map(leadGen, (lead) => freeAt + lead)])),
			freeAt,
			ops: source.draw(opsGen)
		}
	},
	(source) => ({ kind: "refuse", startup: source.draw(element<Refusal>(["refused", "no key"])) })
])

const sequenceGen: Gen<Sequence> = (source) => ({
	max: source.draw(int(1, 3)),
	idle: source.draw(element<Sequence["idle"]>(["short", "long"])),
	steps: source.draw(array(stepGen, { min: 1, max: 12 }))
})

type PoolFeature =
	| "leased a new session"
	| "leased an idle session"
	| "released"
	| "lost a leased connection"
	| "lost an idle connection"
	| "idle churn closed a session"
	| "waiters for a permit interrupted"
	| "a flood of waiters"
	| "abandoned while connecting"
	| "abandoned while pg handed over an idle session"
	| "cut mid-acquisition"
	| "cut holding its session"
	| "cut as a release handed it the permit"
	| "a refused connection"
	| "a connection without a cancellation key"

const situations: Arr.NonEmptyReadonlyArray<PoolFeature> = [
	"leased a new session",
	"leased an idle session",
	"released",
	"lost a leased connection",
	"lost an idle connection",
	"idle churn closed a session",
	"waiters for a permit interrupted",
	"a flood of waiters",
	"abandoned while connecting",
	"abandoned while pg handed over an idle session",
	"cut mid-acquisition",
	"cut holding its session",
	"cut as a release handed it the permit",
	"a refused connection",
	"a connection without a cancellation key"
]

/**
 * Planted: every abandonment, loss, starvation and refusal on a pool of two with a long idle timeout, in an order that
 * reaches each; and the idle timeout closing a released session above the floor.
 */
const poolKept: ReadonlyArray<Kept<Sequence, PoolFeature>> = [
	{
		note: "abandonments, losses, a flood and refusals on a pool of two",
		draws: "",
		sketch: {
			max: 2,
			idle: "long",
			steps: [
				{ kind: "lease" },
				{ kind: "abandon" },
				{ kind: "abandon" },
				{ kind: "lease" },
				{ kind: "starve", waiters: 2_000 },
				{ kind: "lose", pick: 0 },
				{ kind: "lose", pick: 0 },
				{ kind: "refuse", startup: "refused" },
				{ kind: "refuse", startup: "no key" },
				{ kind: "starve", waiters: 1 }
			]
		},
		reaches: [
			"leased a new session",
			"leased an idle session",
			"released",
			"abandoned while connecting",
			"abandoned while pg handed over an idle session",
			"waiters for a permit interrupted",
			"a flood of waiters",
			"lost an idle connection",
			"lost a leased connection",
			"a refused connection",
			"a connection without a cancellation key"
		]
	},
	{
		note: "the idle timeout closes a released session above the floor",
		draws: "",
		sketch: {
			max: 2,
			idle: "short",
			steps: [
				{ kind: "lease" },
				{ kind: "lease" },
				{ kind: "release", pick: 0 },
				{ kind: "release", pick: 0 }
			]
		},
		reaches: ["idle churn closed a session", "released"]
	},
	{
		note: "cuts at every early turn, alone and racing a release, on a pool of one",
		draws: "",
		sketch: {
			max: 1,
			idle: "long",
			steps: [
				{ kind: "cut", at: 0, ops: 3 },
				{ kind: "cut", at: 2, ops: 3 },
				{ kind: "cut", at: 24, ops: 8 },
				{ kind: "race", at: 6, freeAt: 0, ops: 3 },
				{ kind: "race", at: 4, freeAt: 1, ops: 4 }
			]
		},
		reaches: [
			"cut mid-acquisition",
			"cut holding its session",
			"cut as a release handed it the permit",
			"released"
		]
	}
]

/**
 * The pool's idle timeouts, in milliseconds of real time: short, the least delay a Node timer waits (nodeTimerMin), so
 * a session released above the floor is closed at once, and long, which never fires while its test runs
 * (testIdleTimeout).
 */
const idleMillis: { readonly [I in Sequence["idle"]]: number } = {
	short: nodeTimerMin.value,
	long: testIdleTimeout.value
}

const frame = (type: string, body: Uint8Array): Buffer => {
	const out = Buffer.alloc(5 + body.length)
	out.write(type, 0, "latin1")
	out.writeInt32BE(4 + body.length, 1)
	out.set(body, 5)
	return out
}

const int32 = (n: number): Buffer => {
	const out = Buffer.alloc(4)
	out.writeInt32BE(n)
	return out
}

const authenticationOk = frame("R", int32(0))
const readyForQuery = frame("Z", Buffer.from("I", "latin1"))
const backendKeyData = (pid: number): Buffer => frame("K", Buffer.concat([int32(pid), int32(7)]))
/** A FATAL invalid_authorization_specification, which the server sends and then closes the connection. */
const startupRefusal = frame(
	"E",
	Buffer.from("SFATAL\0VFATAL\0C28000\0Mrefused by the fake server\0\0", "latin1")
)
/** The Terminate message's type, X. */
const terminate = 0x58

/**
 * One connection at the server, past its TLS: closed from the server's side by `hangUp`, as PostgreSQL closes one, after
 * the last message it wrote. The TLS socket ends, which flushes every byte written before the end and then the
 * close_notify, and the client's end closes both ends: destroying it would drop the bytes still on their way through
 * TLS, so pg would read a FATAL refusal as a connection that ended with no ErrorResponse.
 */
interface FakeConnection {
	readonly hangUp: () => void
}

/**
 * A PostgreSQL server in memory under trust authentication, behind grizzle's public transport: each connection
 * answers the SSLRequest and terminates verify-full TLS (test/support/memory-tls.ts), then reads its startup packet,
 * then typed messages, and closes on Terminate or when pg ends its side. The server answers each startup as `next` says
 * (which then goes back to ready), holds every answer while `holding`, counts the connections it was opened for and
 * those pg ended with a Terminate, and wakes whoever waits on the open connections at each close.
 */
class FakeServer {
	/** The connections not yet closed, from the socket pg opened for each. */
	readonly open = new Set<PgSocket>()
	/** The open connections that answered ready, in the order they did. */
	readonly ready = new Set<FakeConnection>()
	readonly #held: Array<() => void> = []
	/** The waits on the open connections, each run again at the next close. */
	readonly #closing = new Set<() => void>()
	holding = false
	next: Startup = "ready"
	opened = 0
	/**
	 * The connections pg ended with a Terminate. Before the pool ends, only pg's idle timeout does: no step runs a
	 * statement, so no session is retired and closed on release, and a lost connection is the server's own hang-up.
	 */
	terminated = 0
	#pid = 1
	readonly #material = tlsMaterial("fake-postgres.test")
	readonly #connect = memoryEndpoint(this.#material, (secure) => {
		this.#serve(secure)
	})

	/** The transport that reaches the server: a new connection for each socket pg opens. */
	readonly transport: Transport = memoryTransport(this.#material, () => {
		this.opened += 1
		const socket = this.#connect()
		this.open.add(socket)
		socket.once("close", () => {
			this.open.delete(socket)
			const waits = [...this.#closing]
			this.#closing.clear()
			for (const wait of waits) {
				wait()
			}
		})
		return socket
	})

	/** Returns once at most `count` connections are open: at once, or at the close that brings them down to it. */
	openAtMost(count: number): Effect.Effect<void> {
		return Effect.callback<void>((resume) => {
			const wait = (): void => {
				if (this.open.size <= count) {
					resume(Effect.void)
				} else {
					this.#closing.add(wait)
				}
			}
			wait()
			return Effect.sync(() => {
				this.#closing.delete(wait)
			})
		})
	}

	/** Answers every held startup, and holds none after. */
	releaseHeld(): void {
		this.holding = false
		for (const answer of this.#held.splice(0)) {
			answer()
		}
	}

	#serve(secure: TLSSocket): void {
		let read = Buffer.alloc(0)
		let started = false
		let hungUp = false
		const connection: FakeConnection = {
			hangUp: () => {
				if (hungUp) {
					return
				}
				hungUp = true
				secure.end()
			}
		}
		const take = (): void => {
			for (;;) {
				const header = started ? 5 : 4
				if (read.length < header) {
					return
				}
				const length = started ? 1 + read.readInt32BE(1) : read.readInt32BE(0)
				if (read.length < length) {
					return
				}
				const type = read[0]
				read = read.subarray(length)
				if (!started) {
					started = true
					this.#startup(connection, secure)
				} else if (type === terminate) {
					this.terminated += 1
					connection.hangUp()
					return
				}
			}
		}
		secure.on("data", (chunk: Buffer) => {
			read = Buffer.concat([read, chunk])
			take()
		})
		secure.once("end", connection.hangUp)
		secure.on("error", () => undefined)
		secure.once("close", () => {
			this.ready.delete(connection)
		})
	}

	#startup(connection: FakeConnection, secure: TLSSocket): void {
		const startup = this.next
		this.next = "ready"
		if (this.holding) {
			this.#held.push(() => {
				this.#answer(connection, secure, startup)
			})
		} else {
			this.#answer(connection, secure, startup)
		}
	}

	#answer(connection: FakeConnection, secure: TLSSocket, startup: Startup): void {
		if (!secure.writable) {
			return
		}
		switch (startup) {
			case "ready":
				this.ready.add(connection)
				secure.write(Buffer.concat([authenticationOk, backendKeyData(this.#pid++), readyForQuery]))
				return
			case "no key":
				secure.write(Buffer.concat([authenticationOk, readyForQuery]))
				return
			case "refused":
				secure.write(startupRefusal)
				connection.hangUp()
				return
		}
	}
}

/** Real time passing, whatever the test's clock. */
const wallClock = (millis: number): Effect.Effect<void> =>
	Effect.suspend(() => Clock.Clock.defaultValue().sleep(Duration.millis(millis)))

/** Turns of the event loop: every exchange in memory that was under way has settled. */
const settle: Effect.Effect<void> = Effect.andThen(wallClock(0), wallClock(0))

/** The typed failure an exit ended with; any other end fails the property. */
const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
	assert.ok(Result.isSuccess(error), "the wait fails with a typed error")
	return error.success
}

/** A held lease: the session and the scope its lease lives in. */
interface Held {
	readonly session: Session
	readonly scope: Scope.Closeable
}

describe("the session pool", () => {
	it.effect(
		"keeps exactly the open connections and recovers from every interruption, loss and refusal, over drawn sequences",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/adapter/pool",
						draw: drawn(sequenceGen),
						literal: Formatter.format,
						coverage: required<PoolFeature>(situations, { cases: 40, sense: notesOnly }),
						kept: poolKept,
						runs: 40,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					({ max, idle, steps }, c) =>
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
											password: noPassword,
											connectTimeoutMs: testConnectTimeout.value
										},
										"fake"
									),
									bounds: { idleTimeoutMs: idleMillis[idle], min: 1, max },
									attachPool: () => undefined
								}),
								poolScope
							)
							const held: Array<Held> = []
							/**
							 * The idle churn due. Under the short timeout: a Node timer of its delay, set after every idle timer
							 * pg's Pool has set and so run after them (Node keeps the timers of one delay in one list, in the
							 * order they were set: node v26.13.0 lib/internal/timers.js, "any timer added later will always
							 * have been scheduled to timeout later"), then the close of every session they removed, each an
							 * event at the server. Under the long timeout, which never fires while its test runs: none.
							 */
							const churned = Effect.gen(function* () {
								switch (idle) {
									case "short": {
										yield* wallClock(idleMillis.short)
										const size = yield* pool.size
										yield* server.openAtMost(size)
										return
									}
									case "long":
										return
								}
							})
							/** The pool's state at a turn of the event loop, once the idle churn due has closed its sessions. */
							const holds = Effect.gen(function* () {
								yield* settle
								yield* churned
								yield* settle
								if (server.terminated > 0) {
									c.note("idle churn closed a session")
								}
								const open = server.open.size
								const live = yield* pool.live
								assert.equal(
									live,
									open,
									"the sessions a release reaches are exactly the open connections"
								)
								const size = yield* pool.size
								assert.equal(size, open, "pg's Pool counts exactly the open connections")
								assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
								const leased = yield* pool.leased
								assert.equal(leased, held.length)
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
									const holding = (yield* pool.leased) > held.length
									yield* Fiber.interrupt(leasing)
									const exit = yield* Fiber.await(leasing)
									assert.ok(
										Exit.hasInterrupts(exit),
										"only an interruption ends a cut lease's wait"
									)
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
									case "expire":
										while (held.length < Math.min(2, max)) {
											yield* lease
										}
										yield* releaseOrLease(0)
										break
									case "starve": {
										while (held.length < max) {
											yield* lease
										}
										const waiters = yield* Effect.forEach(Arr.range(1, step.waiters), () =>
											Effect.forkChild(Effect.scoped(pool.lease), { startImmediately: true })
										)
										assert.equal(
											pool.native.waitingCount,
											0,
											"a lease waits for a permit, never in pg's queue"
										)
										yield* Fiber.interruptAll(waiters)
										for (const exit of yield* Fiber.awaitAll(waiters)) {
											assert.ok(Exit.hasInterrupts(exit), "the wait ends as an interruption")
										}
										c.note("waiters for a permit interrupted")
										if (step.waiters >= 2_000) {
											c.note("a flood of waiters")
										}
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
												holding
													? "cut holding its session"
													: "cut as a release handed it the permit"
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
										const failure = failureOf(exit)
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
							/** Every session up to the maximum at once, the clock standing still: no permit was lost. */
							const recovered = yield* Effect.scoped(
								Effect.all(
									Arr.map(Arr.range(1, max), () => pool.lease),
									{ concurrency: max }
								)
							)
							assert.equal(new Set(recovered).size, max, "each lease holds a session of its own")
							yield* Scope.close(poolScope, Exit.void)
							yield* settle
							assert.equal(server.open.size, 0, "the ended pool closed every connection")
							const live = yield* pool.live
							assert.equal(live, 0, "the ended pool keeps no session")
						})
				)
			)
	)
})
