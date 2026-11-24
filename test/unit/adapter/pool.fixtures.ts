/** What the properties of pool.test.ts read: its spaces, models and helpers. */

import { Buffer } from "node:buffer"
import type { TLSSocket } from "node:tls"
import { assert } from "@bjornpagen/testing/assert"
import {
	type Aimed,
	aimed,
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf
} from "@bjornpagen/testing/gen"
import { type Array as Arr, Clock, Duration, Effect, Exit, Result, type Scope } from "effect"
import type { PgSocket } from "#adapter/types/driver.ts"
import type { Transport } from "#adapter/types/layer.ts"
import type { Session } from "#adapter/wire/session.ts"
import { memoryEndpoint, memoryTransport, tlsMaterial } from "#test/support/memory-tls.ts"
import { pickGen } from "#test/support/pick.ts"
type Refusal = "refused" | "no key"
export type Startup = "ready" | Refusal

/** One step as drawn. */
type StepSketch =
	| { readonly kind: "lease" }
	| { readonly kind: "release"; readonly pick: number }
	| { readonly kind: "lose"; readonly pick: number }
	| { readonly kind: "pause" }
	| { readonly kind: "starve"; readonly leases: Leases }
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
	readonly steps: ReadonlyArray<StepSketch>
}

/**
 * How many leases a step takes at once, by the pool's size: one, exactly the size, one past it, or `by` past it, two
 * or more, so a lease past the free permits waits, and one past it waits behind another.
 */
type Leases =
	| { readonly kind: "one" }
	| { readonly kind: "the size" }
	| { readonly kind: "one past the size" }
	| { readonly kind: "past the size"; readonly by: number }

/** The leases `leases` takes on a pool of `max` sessions. */
export const leaseCount = (leases: Leases, max: number): number => {
	switch (leases.kind) {
		case "one":
			return 1
		case "the size":
			return max
		case "one past the size":
			return max + 1
		case "past the size":
			return max + leases.by
	}
}

/** The leases a step takes at once on a pool of `max`, a lease past it drawn up to the size past it again. */
const leasesGen = (max: number): Gen<Leases> =>
	oneOf<Leases>([
		constant({ kind: "one" }),
		constant({ kind: "the size" }),
		constant({ kind: "one past the size" }),
		map(int(2, max + 1), (by) => ({ kind: "past the size", by }))
	])

/** What the leases taken at once wait for, by how many the pool's free permits leave waiting. */
type Waiting = "no waiter" | "a waiter queued" | "a waiter queued behind another waiter"

export const waitingOf = (waiters: number): Waiting =>
	waiters === 0
		? "no waiter"
		: waiters === 1
			? "a waiter queued"
			: "a waiter queued behind another waiter"

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

/**
 * One step of a sequence on a pool of `max`. Every arm builds its step anew, so no two steps of a sequence are one
 * object: a sequence is a tree of values, read and kept as one.
 */
const stepGen = (max: number): Gen<StepSketch> =>
	oneOf<StepSketch>([
		() => ({ kind: "lease" }),
		(source) => ({ kind: "release", pick: source.draw(pickGen) }),
		(source) => ({ kind: "lose", pick: source.draw(pickGen) }),
		() => ({ kind: "pause" }),
		(source) => ({ kind: "starve", leases: source.draw(leasesGen(max)) }),
		() => ({ kind: "abandon" }),
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

const sequenceGen: Gen<Sequence> = (source) => {
	const max = source.draw(int(1, 3))
	return {
		max,
		steps: source.draw(array(stepGen(max), { min: 1, max: 12 }))
	}
}

/**
 * A cut lease's turn early in its acquisition: the first turns, while a fresh pool's connection is still crossing its
 * startup and TLS, so the cut lands before the lease holds a session.
 */
const earlyTurnGen: Gen<number> = int(0, 2)

/** A sequence of one cut, early in its lease's acquisition on a fresh pool: one that reaches "cut mid-acquisition". */
const earlyCutGen: Gen<Sequence> = (source) => ({
	max: source.draw(int(1, 3)),
	steps: [{ kind: "cut", at: source.draw(earlyTurnGen), ops: source.draw(opsGen) }]
})

export type PoolFeature =
	| "leased a new session"
	| "leased an idle session"
	| "released"
	| "lost a leased connection"
	| "lost an idle connection"
	| "a released session kept open while idle"
	| Waiting
	| "abandoned while connecting"
	| "abandoned while pg handed over an idle session"
	| "cut mid-acquisition"
	| "cut holding its session"
	| "cut as a release handed it the permit"
	| "a refused connection"
	| "a connection without a cancellation key"

export const situations: Arr.NonEmptyReadonlyArray<PoolFeature> = [
	"leased a new session",
	"leased an idle session",
	"released",
	"lost a leased connection",
	"lost an idle connection",
	"a released session kept open while idle",
	"no waiter",
	"a waiter queued",
	"a waiter queued behind another waiter",
	"abandoned while connecting",
	"abandoned while pg handed over an idle session",
	"cut mid-acquisition",
	"cut holding its session",
	"cut as a release handed it the permit",
	"a refused connection",
	"a connection without a cancellation key"
]

/**
 * The sequences, aimed at a cut mid-acquisition while it is pending: a cut lands there only at the first few of its 25
 * turns, so the drawn sequences seldom reach it.
 */
export const sequenceSpace: Aimed<Sequence, PoolFeature> = aimed(sequenceGen, [
	["cut mid-acquisition", earlyCutGen]
])

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
export class FakeServer {
	/** The connections not yet closed, from the socket pg opened for each. */
	readonly open = new Set<PgSocket>()
	/** The open connections that answered ready, in the order they did. */
	readonly ready = new Set<FakeConnection>()
	readonly #held: Array<() => void> = []
	/** The waits for a held startup, each run at the next one the server holds. */
	readonly #holding = new Set<() => void>()
	holding = false
	next: Startup = "ready"
	opened = 0
	/**
	 * The connections pg ended with a Terminate. Before the pool ends, only a lease refusing a connection that sent no
	 * cancellation key closes one: no step runs a statement, so no session is retired and closed on release, a lost
	 * connection is the server's own hang-up, and the pool closes no session for being idle.
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
		})
		return socket
	})

	/** Returns once the server holds a startup's answer: at once, or when the next startup arrives to be held. */
	startupHeld(): Effect.Effect<void> {
		return Effect.callback<void>((resume) => {
			const wait = (): void => {
				if (this.#held.length > 0) {
					resume(Effect.void)
				} else {
					this.#holding.add(wait)
				}
			}
			wait()
			return Effect.sync(() => {
				this.#holding.delete(wait)
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
			const waits = [...this.#holding]
			this.#holding.clear()
			for (const wait of waits) {
				wait()
			}
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
export const wallClock = (millis: number): Effect.Effect<void> =>
	Effect.suspend(() => Clock.Clock.defaultValue().sleep(Duration.millis(millis)))

/** Turns of the event loop: every exchange in memory that was under way has settled. */
export const settle: Effect.Effect<void> = Effect.andThen(wallClock(0), wallClock(0))

/** The typed failure an exit ended with; any other end fails the property. */
export const typedFailureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	const error = Exit.isFailure(exit) ? Exit.findError(exit) : Result.fail(undefined)
	assert.ok(Result.isSuccess(error), "the wait fails with a typed error")
	return error.success
}

/** A held lease: the session and the scope its lease lives in. */
export interface Held {
	readonly session: Session
	readonly scope: Scope.Closeable
}
