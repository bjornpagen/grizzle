import { layer } from "@effect/vitest"
import { drawn, exhaust, explore, type Kept } from "@grizzle/testing/explore"
import { required, requiredInSpace } from "@grizzle/testing/features"
import { array, element, type Gen, int, oneOf } from "@grizzle/testing/gen"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { searched } from "@grizzle/testing/vitest"
import {
	Array as Arr,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	type Redacted,
	Result,
	Scheduler,
	Scope
} from "effect"
import { OpenError } from "#adapter/errors/execution.ts"
import { LayerReleased } from "#adapter/errors/failures.ts"
import type { Session, SessionPool } from "#adapter/wire/session.ts"
import { appendAll } from "#compiler/core/array.ts"
import {
	backendPidOf,
	defaultPool,
	poolFor,
	roleDefaults,
	rowsOn,
	substrateLogin,
	until
} from "#test/pg/adapter/support.ts"
import { roleBackends } from "#test/pg/serverless/support.ts"
import { assert, lacks } from "#test/support/assert.ts"
import { caseHang, testIdleTimeout } from "#test/support/limits.ts"
import { freshSchema, Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A lease's wait for a pooled session, which has no deadline of grizzle's (packages/grizzle/src/adapter/wire/session.ts
 * makePool): it holds nothing, and an interruption, the caller's own timeout among them, ends it.
 *
 * The waiter, as one finite space exhausted: the pool's maximum (1 to 3) × the sessions already leased (none up to the
 * maximum) × what ends the wait. With fewer sessions leased than the maximum the waiter's own connection is being
 * established, held at its password Effect until the case lets it through; with all of them leased it waits for one of
 * the pool's permits, and nothing ever waits in pg's queue. The wait ends one of two ways, or never begins:
 *
 * - the waiter is interrupted, with the clock standing still: the interruption completes at once;
 * - a leased session is released: a waiter in the queue gets that very session, and one whose connection is being
 *   established gets a session;
 * - the layer is released first: the pool's scope closes with the leases still held, at once, awaiting neither them nor
 *   the network, so pg's Pool is ending, and a lease then fails at once with LayerReleased, at stage released; pg is
 *   never asked for a client (where a waiter would have queued or opened a connection of its own), no connection is
 *   attempted, and the held leases' releases leave the ended pool holding no session.
 *
 * In every case the waiter holds nothing afterwards: a connection established for an abandoned wait joins the pool
 * idle, the leases taken before are the only ones, and then every session up to the maximum is leased at once. The
 * oracle is the pool's own counts (open and leased sessions) and the waiter's exit. The clock stands still, so a wait
 * that needed it to move would never end, which the case's hang bound reports.
 *
 * What ends the wait, or keeps it from beginning.
 */
type Ending = "interrupted" | "released" | "layer released"

/** Where the waiter waits: in the queue of a saturated pool, or for its own connection. */
type Where = "saturated" | "establishing"

interface Waiter {
	readonly max: number
	readonly held: number
	readonly ending: Ending
}

type WaiterFeature = `${Where} ${Ending}`

const whereOf = (w: Pick<Waiter, "max" | "held">): Where =>
	w.held === w.max ? "saturated" : "establishing"

/** Every waiter, the maximum outermost: a release needs a session held to release. */
const waiters: Gen<Waiter> = (source) => {
	const max = source.draw(int(1, 3))
	const held = source.draw(int(0, max))
	const ending = source.draw(
		element<Ending>(["interrupted", ...(held > 0 ? (["released"] as const) : []), "layer released"])
	)
	return { max, held, ending }
}

const situations: Arr.NonEmptyReadonlyArray<WaiterFeature> = [
	"saturated interrupted",
	"saturated released",
	"establishing interrupted",
	"establishing released",
	"saturated layer released",
	"establishing layer released"
]

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

/**
 * Where a drawn lease is cut: after a drawn number of the scheduler's turns, the lease run a drawn few operations a
 * turn, so the cut lands at every step of its acquisition on the fiber's side; or after a drawn number of milliseconds
 * of real time, so it lands while pg connects, while TLS and the startup run, or once the session is held.
 */
type CutAt =
	| { readonly kind: "turns"; readonly turns: number; readonly ops: number }
	| { readonly kind: "millis"; readonly millis: number }

/** One lease of an interleaving: kept to its end, or cut; holding its session idle, or running a statement on it. */
interface LeasePlan {
	readonly cut: { readonly kind: "kept" } | { readonly kind: "cut"; readonly at: CutAt }
	readonly work: "idle" | "statement"
}

interface Interleaving {
	readonly max: number
	readonly leases: ReadonlyArray<LeasePlan>
}

/**
 * Effect never finishes closing a scope at fewer than 3 operations a turn; a few more step through the acquisition one
 * operation at a time.
 */
const cutAtGen: Gen<CutAt> = oneOf<CutAt>([
	(source) => ({ kind: "turns", turns: source.draw(int(0, 24)), ops: source.draw(int(3, 8)) }),
	(source) => ({ kind: "millis", millis: source.draw(int(0, 30)) })
])

const leasePlanGen: Gen<LeasePlan> = (source) => ({
	cut: source.draw(
		oneOf<LeasePlan["cut"]>([
			() => ({ kind: "kept" }),
			(cut) => ({ kind: "cut", at: cut.draw(cutAtGen) })
		])
	),
	work: source.draw(element<LeasePlan["work"]>(["idle", "statement"]))
})

/** Up to eight leases at once on a pool of one to three: often more than the pool holds, so some wait in its queue. */
const interleavingGen: Gen<Interleaving> = (source) => ({
	max: source.draw(int(1, 3)),
	leases: source.draw(array(leasePlanGen, { min: 1, max: 8 }))
})

/** How far a lease got before its end: what a cut lease was doing when the cut came. */
type Progress = "asking" | "holding" | "running"

/**
 * The lease a connection attempt is for, by its index in the interleaving. The pool runs a new connection's password
 * Effect under the services of the lease whose ask constructs it (wire/session.ts makePool, passwordOf), so the
 * password reads the lease its connection is for.
 */
const AskingLease = Context.Reference<Option.Option<number>>(
	"grizzle/test/serverless/AskingLease",
	{
		defaultValue: () => Option.none()
	}
)

type InterleavingFeature =
	| "cut while asking"
	| "cut while asking, a connection being established"
	| "cut holding its session"
	| "cut running a statement"
	| "kept to its end"
	| "more leases than the pool holds"

const interleavingSituations: Arr.NonEmptyReadonlyArray<InterleavingFeature> = [
	"cut while asking",
	"cut while asking, a connection being established",
	"cut holding its session",
	"cut running a statement",
	"kept to its end",
	"more leases than the pool holds"
]

/**
 * Planted: on a pool of one, a lease held across a statement while three more wait for its one permit: one cut at once
 * on the fiber's side and one after a few milliseconds of real time, while pg connects the holder's session, both cut
 * asking with no connection of their own, and one kept to its end once the statement's lease is cut too.
 */
const interleavingKept: ReadonlyArray<Kept<Interleaving, InterleavingFeature>> = [
	{
		note: "cuts while asking, holding and running on a pool of one",
		sketch: {
			max: 1,
			leases: [
				{ cut: { kind: "cut", at: { kind: "millis", millis: 30 } }, work: "statement" },
				{ cut: { kind: "cut", at: { kind: "turns", turns: 0, ops: 3 } }, work: "idle" },
				{ cut: { kind: "kept" }, work: "idle" },
				{ cut: { kind: "cut", at: { kind: "millis", millis: 2 } }, work: "idle" }
			]
		},
		draws: "",
		reaches: ["cut while asking", "kept to its end", "more leases than the pool holds"]
	}
]

/** Real time passing, whatever the test's clock. */
const wallClock = (millis: number): Effect.Effect<void> =>
	Effect.suspend(() => Clock.Clock.defaultValue().sleep(Duration.millis(millis)))

/** A statement that runs long enough for a cut to land while it runs, and which a CancelRequest stops. */
const running = "SELECT pg_catalog.pg_sleep(0.05)::text"

/**
 * Leases cut at arbitrary points lose nothing, against the cluster: a property over drawn interleavings of up to
 * eight leases started at once on a pool of one to three, each kept to its end or cut, after a drawn number of the
 * scheduler's turns or of real milliseconds, while it asks (queued for a permit, while pg connects it over TLS, or
 * once pg answered and before the lease took the client), while it holds its session, or while a statement runs on
 * it. A lease cut while it asks was establishing a connection exactly when the pool had started one for it: its
 * connection's password ran under its own services (AskingLease), whatever connections other leases were
 * establishing. A client that arrives for an ask whose lease was cut goes straight back to the pool with its permit;
 * a session cut mid-statement sends its CancelRequest, is destroyed and is counted out of the pool.
 *
 * Once every lease has ended: every kept lease succeeded and every cut one ended as an interruption; the pool leases
 * nothing, opens at most its maximum, and queues nothing in pg's Pool; the role's backends fall to at most the
 * maximum; and a further lease of the maximum at once succeeds, each with a session of its own, none of them a session
 * cut mid-statement, on a backend none of those ran on: no permit or client was lost, and a destroyed session is never
 * handed out again.
 */
const cutLeases = Effect.gen(function* () {
	const s = yield* Substrate
	const schema = yield* s.schema(freshSchema)
	const reader = yield* substrateLogin(schema, "server", roleDefaults)
	return yield* explore(
		{
			suite: "serverless/pool interleavings",
			draw: drawn(interleavingGen),
			literal: Formatter.format,
			coverage: required<InterleavingFeature>(interleavingSituations, {
				cases: 30,
				sense: notesOnly
			}),
			kept: interleavingKept,
			runs: 30,
			shrink: completeShrink,
			concurrency: 1,
			steerEvery: 16,
			caseHang
		},
		({ max, leases }, c) =>
			Effect.gen(function* () {
				/** The leases the pool started a connection for: each connection's password names its lease. */
				const connecting = new Set<number>()
				const password = Effect.map(AskingLease, (lease) => {
					if (Option.isSome(lease)) {
						connecting.add(lease.value)
					}
					return reader.password
				})
				const pool = yield* poolFor(reader, {
					...defaultPool,
					password: { kind: "given", password },
					pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max }
				})
				if (leases.length > max) {
					c.note("more leases than the pool holds")
				}
				/**
				 * What each lease reached; each session a lease runs statements on, from before its first; and that
				 * session's backend, once read.
				 */
				const progress: Array<Progress> = Arr.map(leases, () => "asking")
				const ran = new Set<Session>()
				const backends = new Map<Session, number>()
				const leaseOf = (plan: LeasePlan, index: number) =>
					Effect.scoped(
						Effect.gen(function* () {
							const session = yield* pool.lease
							progress[index] = "holding"
							if (plan.work === "statement") {
								ran.add(session)
								const pid = yield* backendPidOf(session)
								backends.set(session, pid)
								progress[index] = "running"
								yield* rowsOn(session, running, [])
								progress[index] = "holding"
							}
							if (plan.cut.kind === "cut") {
								return yield* Effect.never
							}
						})
					)
				const fibers = yield* Effect.forEach(leases, (plan, index) => {
					const lease = Effect.provideService(leaseOf(plan, index), AskingLease, Option.some(index))
					return Effect.forkChild(
						plan.cut.kind === "cut" && plan.cut.at.kind === "turns"
							? Effect.provideService(lease, Scheduler.MaxOpsBeforeYield, plan.cut.at.ops)
							: lease,
						{ startImmediately: true }
					)
				})
				yield* Effect.forEach(
					leases,
					(plan, index) =>
						Effect.gen(function* () {
							const fiber = fibers[index]
							if (plan.cut.kind === "kept" || fiber === undefined) {
								return
							}
							const at = plan.cut.at
							if (at.kind === "turns") {
								for (let turn = 0; turn < at.turns; turn++) {
									yield* Effect.yieldNow
								}
							} else {
								yield* wallClock(at.millis)
							}
							const reached = progress[index]
							const establishing = connecting.has(index)
							yield* Fiber.interrupt(fiber)
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
				const leased = yield* pool.leased
				assert.equal(leased, 0, "once every lease ended, the pool leases nothing")
				const size = yield* pool.size
				assert.ok(size <= max, "the pool opens at most its maximum")
				yield* until(Effect.map(roleBackends(reader.role), (n) => n <= max))
				assert.equal(pool.native.waitingCount, 0, "nothing waits in pg's queue")
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
			})
	)
}).pipe(Effect.scoped)

layer(Substrate.layer)("a lease's wait for a pooled session", (it) => {
	it.effect(
		"ends at once when interrupted, or with a session released, has no deadline of its own, and leaks nothing",
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
							limit: 24,
							coverage: requiredInSpace<WaiterFeature>(situations),
							caseHang
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
										pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: w.max }
									}),
									poolScope
								)
								/** Each held lease in a scope of its own, a child of the case's, so a failing case still releases it. */
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
									yield* Scope.close(poolScope, Exit.void)
									assert.ok(pool.native.ending, "pg's Pool is ending")
									const asked = connectCalls(pool.native)
									const attempts = gate.state.attempts
									const exit = yield* Effect.exit(Effect.scoped(pool.lease))
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
								const leasedNow = yield* pool.leased
								assert.equal(leasedNow, leased)
								const sizeNow = yield* pool.size
								assert.ok(sizeNow <= w.max)
								for (const h of held) {
									yield* Scope.close(h.scope, Exit.void)
								}
								const leasedAfter = yield* pool.leased
								assert.equal(leasedAfter, 0)
								/** Every session up to the maximum at once. */
								const pids = yield* Effect.scoped(
									Effect.all(
										Array.from({ length: w.max }, () => Effect.flatMap(pool.lease, backendPidOf)),
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

	it.effect(
		"loses no permit or client to leases cut at arbitrary points, over drawn interleavings",
		(ctx) => searched(ctx, cutLeases)
	)
})
