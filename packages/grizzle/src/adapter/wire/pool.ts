/**
 * A login's session pool: the driver's Pool over the sessions of wire/session.ts, with the lease that hands a Db's
 * transaction one session at a time.
 *
 * The driver's own Pool, its most sessions the caller's (DbConfig.pool), which keeps every session it opened
 * for its life: it is built with an idle timeout of 0, pg's "never" (types/driver.ts PgPoolConfig), so no session is
 * closed for being idle, and a session's cold cost, its connection and its first plan of each statement, is paid once
 * in the pool's life, never again after a pause between requests. It opens no session before a lease asks for one,
 * and hands a lease the idle session released last (pg-pool's idle list is a stack), so one request at a time runs on
 * one session. A session leaves the pool only once it is not open or the pool ends (Release). The
 * wait for a session is the lease's own: its ask takes one of the pool's `max`
 * permits, or waits for one in order, before pg's Pool is asked for a client, and the permit is held until pg has
 * that client back, so pg's Pool always has an idle client or room and never keeps a lease waiting for one, holding
 * an ask only for the turn it takes to hand an idle client over. The lease waits, interruptibly and with no deadline
 * of its own, only for its ask to settle: the caller's own timeout bounds it. A permit and a client move between the
 * ask, pg's callback and the lease only in plain synchronous code, so no interruption at any step can drop one. A
 * wait that is interrupted leaves nothing behind: a client that arrives for a lease abandoned while pg connected it
 * goes back to the pool, and its permit with it. A lease of an ended pool is refused with LayerReleased, before pg is
 * asked for a client. A session that is not open (wire/session.ts SessionState) is released with an error, so pg's
 * Pool closes it instead of keeping it, and is counted out of the pool before its permit admits another lease.
 *
 * Release. The pool ends when the scope it was built in closes (a DbLayer's): pg's Pool ends, writing a Terminate to
 * each idle session; the socket of every client still connecting, handed to a lease or leased is destroyed at once;
 * every lease still waiting is refused with LayerReleased, whether queued for a permit or asking pg's Pool, which
 * drops the asks it queued for an idle client when it ends and so would never answer them; and the release returns
 * once the server has closed every other connection, which it does only once that session's backend has exited, its
 * temporary relations dropped and the backend out of the database's (makePool), so the database can be dropped at
 * once. That wait has no deadline: interrupting the release ends it, every connection still open destroyed.
 *
 * Reap. A session idle past its server's reap window (wire/reap.ts) may have been ended by its server unseen, as a
 * server ends a frozen client's session, so a lease that takes one probes it first: it reads the window again, one round
 * trip, before the caller's first statement. A dead session fails the read, is closed, and the lease takes another, a
 * new connection once none idle is left, so the caller's statements go out on a session its server answered, and a
 * write never answers commitUnknown for a session that was already gone. A session's first lease reads its window, a
 * round trip of the cold path beside its connection's; a lease of a session silent for less than its window sends
 * nothing more, so a warm call pays no probe.
 *
 * Silence is measured from the moment a lease last took the session, which precedes everything that lease sent and
 * read, so it never undercounts the server's own reckoning, on both of the clocks Effect's Clock reads, the larger
 * reading kept. Its monotonic time is process.hrtime, CLOCK_MONOTONIC (libuv uv_hrtime), which counts no time a
 * suspended Linux system spends asleep, where CLOCK_BOOTTIME, which Node does not offer, does (clock_gettime(2):
 * CLOCK_MONOTONIC "does not count time that the system is suspended"); and a Firecracker microVM paused and resumed
 * continues its guest's clocks from the pause, its wall clock until the guest sets it again (firecracker
 * docs/snapshotting/snapshot-support.md: "the wall-clock should be updated to the current time, on the guest-side").
 * Its current time is Date.now, that wall clock, which a time sync steps forward after a freeze. A process frozen while
 * its machine runs sees both advance. So the larger of the two readings sees a freeze whichever clock does; its one cost
 * is a probe nothing needed, after the wall clock jumps forward, and a freeze no clock of the process counted goes
 * unseen, as it would by any clock of the process.
 */
import { Array as Arr, Clock, Deferred, Effect, Exit, Result } from "effect"
import type { Context, Scope } from "effect"
import { type AcquireRefusal, LayerReleased, NoCancelKey } from "#adapter/errors/failures.ts"
import { ownServices } from "#adapter/services.ts"
import type { PgClient, PgPool, PgPoolClient, PgSocket } from "#adapter/types/driver.ts"
import type { PoolBounds } from "#adapter/types/layer.ts"
import { oneShotStatement, runApart } from "#adapter/wire/batch.ts"
import { type ReapWindow, reapWindowRow } from "#adapter/wire/reap.ts"
import {
	type AttemptServices,
	attemptFailed,
	closedAll,
	destroyWire,
	type Handshakes,
	type LoginConnection,
	type Session,
	type SessionSpec,
	sessionClient,
	terminated
} from "#adapter/wire/session.ts"
import { defect } from "#compiler/plan/runtime.ts"
import type { ServedSession } from "#compiler/plan/serve.ts"

/** The moment a lease took a session, on each of the process's clocks (see the header's Reap). */
interface Taken {
	readonly monotonic: bigint
	readonly wall: number
}

const nanosPerMillisecond = 1_000_000

/** Now, on both clocks. */
const takenNow: Effect.Effect<Taken> = Effect.map(
	Effect.all([Clock.monotonicTimeNanos, Clock.currentTimeMillis]),
	([monotonic, wall]) => ({ monotonic, wall })
)

/** The milliseconds since `taken`, the larger of the two clocks' readings. */
const silentFor = (taken: Taken): Effect.Effect<number> =>
	Effect.map(takenNow, (now) =>
		Math.max(Number(now.monotonic - taken.monotonic) / nanosPerMillisecond, now.wall - taken.wall)
	)

/** A session's reap window, read from its server, and the moment a lease last took it. */
interface Reaping {
	readonly window: ReapWindow
	readonly taken: Taken
}

/**
 * The reap window of `session`, read over it by its served file's statement (ControlTexts reapWindow), alone in its
 * flight: its answer is also the proof the session's server still holds it, and a dead session fails it as its
 * connection fails, with nothing of a caller's sent. A server that answers it anything but its one row of four settings
 * is a defect: every PostgreSQL 19 server reports each setting it reads.
 */
const readWindow = (session: Session) =>
	Effect.flatMap(
		runApart(session, [oneShotStatement(session.controls.reapWindow, [])]),
		([answer]) => {
			const [row, ...rest] =
				answer === undefined || Result.isFailure(answer) ? [] : answer.success.rows
			const window = row === undefined || rest.length > 0 ? undefined : reapWindowRow(row)
			return window === undefined
				? Effect.sync(() =>
						defect("a session's server answered the read of its reap window with no window")
					)
				: Effect.succeed(window)
		}
	)

/**
 * What one lease's ask for a client came to, once pg answered it: pg's client, held for the lease with its permit; or
 * its refusal, the permit back, with what the attempt failed with.
 */
type Settled =
	| { readonly _tag: "connected"; readonly client: PgPoolClient }
	| { readonly _tag: "refused"; readonly failure: Effect.Effect<never, AcquireRefusal> }

/**
 * Where one lease's ask for a client stands, and so who holds its permit: queued for a permit, holding none; connecting,
 * its permit given to pg's Pool, which was asked for a client and has not answered; or settled.
 */
type AskState =
	| { readonly _tag: "queued" }
	| { readonly _tag: "connecting"; readonly attempt: Attempt }
	| Settled

/**
 * One lease's ask for a client. It moves only in plain synchronous code, never across a fiber's steps: the lease waits
 * for `settled` alone, interruptibly, which carries what the ask came to; an interrupted lease withdraws its ask at once,
 * without interruption, so neither a permit nor a client is ever in flight between fibers where an interruption could
 * drop it.
 */
interface Ask {
	state: AskState
	/** The services of the lease the ask is for, under which its connection attempt's password runs. */
	readonly services: Context.Context<never>
	/** Done with what the ask came to, once it is connected or refused. */
	readonly settled: Deferred.Deferred<Settled>
}

/**
 * The pool's permits, one for each session up to `bounds.max`, as they stand between asks: some free and no ask waiting
 * (`free`, at least one), asks waiting for one in order and none free (`waiting`, at least one), or neither
 * (`exhausted`). A free permit and a waiting ask never stand side by side: a permit that comes back goes to the first
 * ask waiting, and only when none waits is it free.
 */
type Permits =
	| { readonly _tag: "free"; readonly count: number }
	| { readonly _tag: "waiting"; readonly queue: Arr.NonEmptyReadonlyArray<Ask> }
	| { readonly _tag: "exhausted" }

const exhausted: Permits = { _tag: "exhausted" }

/** The permits once `asks` wait in order: waiting, or exhausted when none does. */
const waitingFor = (asks: ReadonlyArray<Ask>): Permits =>
	Arr.isReadonlyArrayNonEmpty(asks) ? { _tag: "waiting", queue: asks } : exhausted

/** The permits with `ask` no longer among those waiting. */
const withdrawn = (permits: Permits, ask: Ask): Permits =>
	permits._tag === "waiting" ? waitingFor(Arr.filter(permits.queue, (w) => w !== ask)) : permits

/** Who pg's answer to one request for a client is for: the ask waiting for it, or nobody once that lease left. */
type AttemptWaiter = { readonly _tag: "waiting"; readonly ask: Ask } | { readonly _tag: "nobody" }

/** One request to pg's Pool for a client, made for an ask holding a permit. */
interface Attempt {
	waiter: AttemptWaiter
}

const nobody: AttemptWaiter = { _tag: "nobody" }

/** What an ask comes to once its pool has ended: the layer that built the pool was released. */
const layerReleased = (): Settled => ({
	_tag: "refused",
	failure: Effect.fail(new LayerReleased())
})

/**
 * What pg's answer to an attempt reaches in the pool that made it (makePool): that pg answered it, so it holds its
 * permit no longer as an attempt; the way a permit goes back; the client handed to the ask waiting for it, which then
 * holds the permit until its lease takes the client; and the one settling of an ask, its state and its `settled`
 * together.
 */
interface AttemptOwner {
	readonly answered: (attempt: Attempt) => void
	readonly permitBack: () => void
	readonly handOver: (ask: Ask, client: PgPoolClient) => void
	readonly settle: (ask: Ask, settled: Settled) => void
}

/**
 * pg's callback for one attempt. For the ask waiting for it, the client is held for the lease with its permit, or the
 * failure is the ask's and the permit goes back. When nobody waits, the lease having left or the pool having ended, the
 * client goes back to pg's Pool and the permit with it: the pool's end leaves no attempt waiting (makePool), so an
 * answer for a waiting ask always comes before it. pg keeps the callback for the client's life (the connection's
 * `connect` listener holds pg's own callback, which holds this), so it is made here, apart from any lease, and drops
 * the ask once it has answered: a connected client keeps no lease's context.
 */
const answerAttempt =
	(spec: SessionSpec, handshakes: Handshakes, attempt: Attempt, owner: AttemptOwner) =>
	(error: unknown, client: PgPoolClient | undefined): void => {
		owner.answered(attempt)
		const waiter = attempt.waiter
		attempt.waiter = nobody
		if (waiter._tag === "nobody") {
			client?.release(false)
			owner.permitBack()
			return
		}
		if (client !== undefined) {
			owner.handOver(waiter.ask, client)
			return
		}
		owner.settle(waiter.ask, {
			_tag: "refused",
			failure: attemptFailed(spec, handshakes, error)
		})
		owner.permitBack()
	}

interface PoolConfig {
	/** Where each of the pool's sessions connects. */
	readonly connection: LoginConnection
	/**
	 * What every session of the login sends that no program states: the startup options pinning its role's defaults and
	 * its transactions' control texts, its served file's (served/forms.ts ServedSession).
	 */
	readonly session: ServedSession
	/** The pool's bounds (DbConfig.pool). */
	readonly bounds: PoolBounds
}

/**
 * A pool's permits as they stand at one moment, one permit for each session up to its bounds' `max`: each free; held by
 * an ask that is no lease yet (`attempting`: an attempt pg's Pool has not answered, a left lease's among them, or a
 * client pg handed over that its lease has not taken yet); or held by a session handed to a lease and not yet released
 * (`leased`; a connection still being established is none). So free + attempting + leased is the pool's `max` at every
 * moment, and a permit that none of them holds is lost. `waiting` counts the leases queued for a permit, which wait only
 * while none is free.
 */
export interface PoolState {
	readonly free: number
	readonly attempting: number
	readonly leased: number
	readonly waiting: number
}

export interface SessionPool {
	readonly role: string
	/** pg's Pool, holding the pool's bounds. */
	readonly native: PgPool
	/** A session for the scope. */
	readonly lease: Effect.Effect<Session, AcquireRefusal, Scope.Scope>
	/** Open connections: leased, idle, or still being established. */
	readonly size: Effect.Effect<number>
	/** The pool's permits and its waiting leases, read in one step (PoolState). */
	readonly state: Effect.Effect<PoolState>
}

/**
 * Builds the pool in the current scope; it ends when that scope closes. A pool is a login's: each of its sessions
 * starts under the login's pinned defaults (SessionSpec startup), and is kept for the pool's life once opened, never
 * closed for being idle (see the header's Pool). pg's Pool reports an idle client that failed after it has closed and
 * dropped it, so its `error` event wants nothing. The lease's services hold only while pg constructs and starts connecting a client inside
 * `connect`, and that client keeps them only until its connection is set up.
 *
 * Its end, when the scope closes: pg's Pool ends, which writes a Terminate to each idle client, half-closes its
 * connection and refuses every later ask; the wire of every client still connecting, handed to a lease or leased is
 * destroyed; every ask still unsettled is refused with LayerReleased; and the end then waits for the server to close
 * every connection it did not destroy, an idle session's, or one a release was closing already. A backend's server
 * closes its connection only once the backend has exited: proc_exit runs the before_shmem_exit callbacks, among them
 * the drop of the session's temporary relations (REL_19_0 src/backend/catalog/namespace.c 4610
 * RemoveTempRelationsCallback), then the on_shmem_exit ones, which take the backend out of the database's backends
 * (src/backend/storage/lmgr/proc.c 554 ProcKill, 594 RemoveProcFromArray; backend_status.c 218, its pg_stat_activity
 * row), and only then the on_proc_exit ones, the connection's close among them (src/backend/storage/ipc/ipc.c 166
 * proc_exit_prepare; src/backend/libpq/pqcomm.c 287 socket_close, which leaves the socket open until the process dies
 * so that a client "can be sure the backend has exited"). So once the end returns, no backend of the pool's idle
 * sessions counts against the database: a DROP DATABASE after it finds none, where it found a backend still dropping
 * its session's temporary relations, the rule judge's deltas and its sentinel (physical/ddl/rules.ts addStandUps),
 * each a table with its TOAST table and index and its row types: 150 tables, 642 objects, the write's carriers then
 * among them, 1.8 s for one session of pantry's export suite and 6 to 13 s on its whole project (edullm P5,
 * 2026-11-21), where DROP DATABASE waits 5 s. The wait has no deadline of
 * grizzle's: interrupting the release, or the fiber whose scope it closes, your own timeout among the ways, ends it and
 * destroys every connection still open (closedAll), as the end of a session leased then is destroyed at once.
 */
export const makePool = (config: PoolConfig): Effect.Effect<SessionPool, never, Scope.Scope> =>
	Effect.gen(function* () {
		const { bounds } = config
		const spec: SessionSpec = {
			...config.connection,
			startup: { kind: "login", options: config.session.startup },
			controls: config.session
		}
		const own = yield* ownServices()
		const attemptServices: AttemptServices = { current: own, own }
		/**
		 * The session of each client pg's Pool connected, made when its client is ready, before anyone holds the
		 * client, and kept beside it; a client with none had no BackendKeyData, and an ended session goes with its
		 * client. `wires` holds every client constructed, with the socket the transport opened for it, until it ends: what the
		 * pool's end destroys or waits for.
		 */
		const sessions = new WeakMap<PgClient, Session>()
		const wires = new Map<PgClient, PgSocket>()
		const handshakes: Handshakes = new WeakSet()
		/** Each session's reap window and the moment a lease last took it, from its first lease on (see the header's Reap). */
		const reaping = new WeakMap<Session, Reaping>()
		const native = new spec.driver.Pool({
			Client: sessionClient(spec, attemptServices, handshakes, {
				opened: (client, socket) => {
					wires.set(client, socket)
					client.once("end", () => {
						wires.delete(client)
					})
				},
				ready: (client, session) => {
					if (session === undefined) {
						return
					}
					sessions.set(client, session)
				}
			}),
			max: bounds.max,
			idleTimeoutMillis: 0
		})
		native.on("error", () => undefined)
		/**
		 * The permits. An ask takes a permit before pg's Pool is asked for a client for it, and the permit comes back
		 * once pg has that client back or the attempt has failed; an attempt abandoned while pg connects or hands over
		 * its client keeps its permit until pg answers. So pg's Pool always has an idle client or room for the attempt,
		 * and never queues one but for the turn it takes to hand an idle client over.
		 */
		let permits: Permits = { _tag: "free", count: bounds.max }
		/**
		 * The clients handed to a lease and not yet released. pg's Pool counts a client still connecting in totalCount
		 * and not in idleCount, so its difference would count a session being established as leased.
		 */
		const leased = new Set<PgPoolClient>()
		/** The attempts pg's Pool has not answered, each holding the permit its ask took, a left lease's included. */
		const pending = new Set<Attempt>()
		/** The asks pg answered with a client their lease has not taken yet, each holding its permit, with that client. */
		const handed = new Map<Ask, PgPoolClient>()
		/**
		 * The asks not yet settled, whose leases wait: queued for a permit, or connecting. An ask leaves when it settles
		 * or its lease withdraws it, and the pool's end refuses every one still here: pg's Pool drops the asks it queued
		 * for an idle client when it ends, and answers none of them.
		 */
		const unsettled = new Set<Ask>()

		/** Settles `ask`: what it came to, for its lease to take. */
		const settle = (ask: Ask, settled: Settled): void => {
			unsettled.delete(ask)
			ask.state = settled
			Deferred.doneUnsafe(ask.settled, Exit.succeed(settled))
		}

		/**
		 * Asks pg's Pool for a client for `ask`, which holds a permit, under the services of its lease, pg's answer
		 * reaching `owner`; whether pg holds the permit now. pg's Pool ends only in this pool's finalizer, so an ending
		 * pool is a released layer: the ask is refused with LayerReleased, read in the same turn as `connect`, so no end
		 * can come between, and the permit is the caller's again, as it is when pg's Pool throws.
		 */
		const attemptFor = (ask: Ask, owner: AttemptOwner): boolean => {
			if (native.ending) {
				settle(ask, layerReleased())
				return false
			}
			const attempt: Attempt = { waiter: { _tag: "waiting", ask } }
			ask.state = { _tag: "connecting", attempt }
			pending.add(attempt)
			attemptServices.current = ask.services
			const started = Result.try(() => {
				native.connect(answerAttempt(spec, handshakes, attempt, owner))
			})
			attemptServices.current = own
			if (Result.isSuccess(started)) {
				return true
			}
			pending.delete(attempt)
			attempt.waiter = nobody
			settle(ask, { _tag: "refused", failure: Effect.die(started.failure) })
			return false
		}

		/**
		 * What pg's answers reach in this pool: the one settling of an ask, and a permit back, to the first ask waiting
		 * that pg's Pool takes it for, whose attempt's answer reaches this owner in turn, else free.
		 */
		const owner: AttemptOwner = {
			answered: (attempt) => {
				pending.delete(attempt)
			},
			handOver: (ask, client) => {
				handed.set(ask, client)
				settle(ask, { _tag: "connected", client })
			},
			settle,
			permitBack: () => {
				while (permits._tag === "waiting") {
					const [first, ...rest] = permits.queue
					permits = waitingFor(rest)
					if (attemptFor(first, owner)) {
						return
					}
				}
				permits = { _tag: "free", count: permits._tag === "free" ? permits.count + 1 : 1 }
			}
		}

		/** A new ask for the lease whose services are `services`: given a free permit and pg asked at once, or queued. */
		const newAsk = (services: Context.Context<never>): Ask => {
			const made: Ask = {
				state: { _tag: "queued" },
				services,
				settled: Deferred.makeUnsafe<Settled>()
			}
			unsettled.add(made)
			if (permits._tag !== "free") {
				permits = {
					_tag: "waiting",
					queue: permits._tag === "waiting" ? Arr.append(permits.queue, made) : [made]
				}
				return made
			}
			permits = permits.count === 1 ? exhausted : { _tag: "free", count: permits.count - 1 }
			if (!attemptFor(made, owner)) {
				owner.permitBack()
			}
			return made
		}

		/**
		 * An interrupted lease's ask, withdrawn in one step: from the queue; from pg's Pool, whose later answer goes back
		 * with its permit; or, when pg answered with a client the lease never took, that client back to pg's Pool and
		 * then its permit. A refused ask's permit is back already.
		 */
		const withdraw = (ask: Ask): void => {
			const state = ask.state
			switch (state._tag) {
				case "queued":
					unsettled.delete(ask)
					permits = withdrawn(permits, ask)
					return
				case "connecting":
					unsettled.delete(ask)
					state.attempt.waiter = nobody
					return
				case "connected":
					handed.delete(ask)
					state.client.release(false)
					owner.permitBack()
					return
				case "refused":
					return
			}
		}

		/**
		 * The pool's end (see makePool): pg's Pool ended, which gives each idle client its Terminate; the wire of every
		 * client no lease may still run on destroyed, one connecting, handed to a lease or leased, a ready one's through
		 * its session; every ask still unsettled refused with LayerReleased, the queue emptied with them; then the wait
		 * for every other session's close (closedAll), though the release runs uninterruptibly, so an interruption,
		 * the release's own or the one whose scope it closes, destroys every connection still open. A connecting ask's
		 * attempt answers nobody after: pg's later answer, if any comes, goes back to the ended pool with its permit.
		 */
		const end = (): Effect.Effect<void> => {
			native.end(terminated)
			const held = new Set<PgClient>([...leased, ...handed.values()])
			const closing: Array<Session> = []
			for (const [client, socket] of wires) {
				const session = sessions.get(client)
				if (session === undefined) {
					destroyWire(client, socket)
				} else if (held.has(client)) {
					session.destroy()
				} else {
					closing.push(session)
				}
			}
			permits = permits._tag === "waiting" ? exhausted : permits
			for (const ask of unsettled) {
				const state = ask.state
				if (state._tag === "connecting") {
					state.attempt.waiter = nobody
				}
				settle(ask, layerReleased())
			}
			return closedAll(closing)
		}
		yield* Effect.addFinalizer(() => Effect.suspend(end))

		/**
		 * `client` back to pg's Pool, which closes it when `close` holds, and then its permit: pg's Pool counts a closed
		 * client out at once, so the permit admits no lease before the pool has room for it.
		 */
		const giveBack = (client: PgPoolClient, close: boolean): void => {
			client.release(close)
			owner.permitBack()
		}

		/** The client pg handed to `ask` back, untaken by its lease, closed: the ask holds its permit no longer. */
		const untaken = (ask: Ask, client: PgPoolClient): Effect.Effect<void> =>
			Effect.sync(() => {
				handed.delete(ask)
				giveBack(client, true)
			})

		/**
		 * A lease's end: the client leaves the leased count and goes back to pg's Pool, which keeps it exactly when the
		 * session is open; a retired or ended one is released with an error, so pg's Pool closes it.
		 */
		const release = (client: PgPoolClient, session: Session): Effect.Effect<void> =>
			Effect.sync(() => {
				leased.delete(client)
				giveBack(client, session.state() !== "open")
			})

		/**
		 * One client as a session for the scope. A pooled client whose session is not open, its connection ended while it
		 * sat idle, is closed before anything runs on it and another leased in its place, while `replacements` remain:
		 * this is pool hygiene, never a retry, at most `bounds.max` times, so no flight is ever sent twice, and a
		 * connection attempt that fails is the acquisition's failure. A lease of a pool already ending is refused at once,
		 * before it asks for a permit.
		 *
		 * Only the wait for the ask to settle is interruptible, and it carries nothing and has no deadline: an interrupted
		 * lease withdraws its ask in one step, without interruption, so a client that arrived for it goes back with its
		 * permit, and a leased client is always released.
		 */
		const leaseWith = (replacements: number): Effect.Effect<Session, AcquireRefusal, Scope.Scope> =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					if (native.ending) {
						return yield* new LayerReleased()
					}
					const context = yield* Effect.context()
					const asked = newAsk(context)
					const waited = yield* Effect.exit(restore(Deferred.await(asked.settled)))
					if (Exit.isFailure(waited)) {
						withdraw(asked)
						return yield* Effect.failCause(waited.cause)
					}
					const settled = waited.value
					if (settled._tag === "refused") {
						return yield* settled.failure
					}
					const client = settled.client
					const session = sessions.get(client)
					if (session === undefined) {
						yield* untaken(asked, client)
						return yield* new NoCancelKey()
					}
					const known = reaping.get(session)
					const due = known === undefined || (yield* silentFor(known.taken)) >= known.window
					if (due && session.state() === "open") {
						const read = yield* Effect.exit(restore(readWindow(session)))
						if (Exit.isSuccess(read)) {
							reaping.set(session, { window: read.value, taken: yield* takenNow })
						} else if (Exit.hasInterrupts(read)) {
							yield* untaken(asked, client)
							return yield* Effect.interrupt
						} else if (session.state() === "open") {
							yield* untaken(asked, client)
							return yield* Effect.sync(() =>
								defect(
									"a pooled session's server answered the read of its reap window with no window"
								)
							)
						}
					}
					if (session.state() !== "open" && replacements > 0) {
						yield* untaken(asked, client)
						return yield* restore(leaseWith(replacements - 1))
					}
					const reaped = reaping.get(session)
					if (reaped !== undefined) {
						reaping.set(session, { window: reaped.window, taken: yield* takenNow })
					}
					handed.delete(asked)
					leased.add(client)
					yield* Effect.addFinalizer(() => release(client, session))
					return session
				})
			)

		return {
			role: spec.role,
			native,
			lease: leaseWith(bounds.max),
			size: Effect.sync(() => native.totalCount),
			state: Effect.sync((): PoolState => ({
				free: permits._tag === "free" ? permits.count : 0,
				attempting: pending.size + handed.size,
				leased: leased.size,
				waiting: permits._tag === "waiting" ? permits.queue.length : 0
			}))
		}
	})
