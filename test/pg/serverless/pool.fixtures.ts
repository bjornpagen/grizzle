/** What the properties of pool.test.ts read: its spaces, models and helpers. */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, oneOf, constant } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Clock,
	Context,
	Deferred,
	Duration,
	Effect,
	Option,
	type Redacted
} from "effect"
import type { SessionPool } from "#adapter/wire/session.ts"
import { until } from "#test/pg/adapter/support.ts"

/**
 * The pool's permits once every lease has returned and pg has answered every attempt (`attempting` 0, read one step at
 * a time until it is): every permit free and no lease waiting. Each read holds the pool's own law, that its permits
 * are free, attempting or leased, `max` in all, so a permit a lease left with fails here, at once, where a further lease
 * of the maximum would wait for it for ever.
 */
export const settledPermits = (pool: SessionPool, max: number) =>
	Effect.gen(function* () {
		yield* until(
			Effect.map(pool.state, (state) => {
				assert.equal(
					state.free + state.attempting + state.leased,
					max,
					"the pool's permits are max in all"
				)
				return state.attempting === 0
			})
		)
		const settled = yield* pool.state
		assert.deepEqual(
			{ free: settled.free, waiting: settled.waiting },
			{ free: max, waiting: 0 },
			"once every lease returned and pg answered every attempt, every permit is free and no lease waits"
		)
	})

/** What ends the wait, or keeps it from beginning. */
type Ending = "interrupted" | "released" | "layer released"

/** Where the waiter waits: in the queue of a saturated pool, or for its own connection. */
type Where = "saturated" | "establishing"

interface Waiter {
	readonly max: number
	readonly held: number
	readonly ending: Ending
}

export type WaiterFeature = `${Where} ${Ending}`

export const whereOf = (w: Pick<Waiter, "max" | "held">): Where =>
	w.held === w.max ? "saturated" : "establishing"

/** Every waiter, the maximum outermost: a release needs a session held to release. */
export const waiters: Gen<Waiter> = (source) => {
	const max = source.draw(int(1, 3))
	const held = source.draw(int(0, max))
	const ending = source.draw(
		element<Ending>(["interrupted", ...(held > 0 ? (["released"] as const) : []), "layer released"])
	)
	return { max, held, ending }
}

export const situations: Arr.NonEmptyReadonlyArray<WaiterFeature> = [
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
export const connectCalls = (native: SessionPool["native"]): (() => number) => {
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
 * Counts the calls of pg's Pool#connect on `native` from now on that pg has not answered yet: an own property in front
 * of the method its class defines, whose callback counts its call out when pg answers, before the pool reads the
 * answer.
 */
export const connectsInFlight = (native: SessionPool["native"]): (() => number) => {
	let pending = 0
	const connect = native.connect.bind(native)
	Object.defineProperty(native, "connect", {
		configurable: true,
		value: (callback: (error: unknown, client: unknown, release: unknown) => void): unknown => {
			pending++
			return Reflect.apply(connect, native, [
				(error: unknown, client: unknown, release: unknown): void => {
					pending--
					callback(error, client, release)
				}
			])
		}
	})
	return () => pending
}

/**
 * A password Effect that waits at a gate while the gate is closed, counting every connection attempt that evaluates it
 * and the attempts it holds at the gate.
 */
export const gatedPassword = (secret: Redacted.Redacted) =>
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
 * turn, so the cut lands at every step of its acquisition on the fiber's side; once its own connection asks for its
 * password, which waits at the lease's gate until the cut has landed, so the cut lands while that connection is being
 * established; or once the lease holds its session.
 */
type CutAt =
	| { readonly kind: "turns"; readonly turns: number; readonly ops: number }
	| { readonly kind: "establishing" }
	| { readonly kind: "held" }

/**
 * One lease of an interleaving: kept to its end or cut where CutAt says, holding its session idle or running a
 * statement on it; or a statement's lease cut once its statement runs, which waits on a lock the case holds until the
 * cut's CancelRequest stops it.
 */
export type LeasePlan =
	| {
			readonly cut: { readonly kind: "kept" } | { readonly kind: "cut"; readonly at: CutAt }
			readonly work: "idle" | "statement"
	  }
	| { readonly cut: { readonly kind: "running" }; readonly work: "statement" }

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
	() => ({ kind: "establishing" }),
	() => ({ kind: "held" })
])

const leasePlanGen: Gen<LeasePlan> = oneOf<LeasePlan>([
	(source) => ({
		cut: source.draw(
			oneOf<{ readonly kind: "kept" } | { readonly kind: "cut"; readonly at: CutAt }>([
				() => ({ kind: "kept" }),
				(cut) => ({ kind: "cut", at: cut.draw(cutAtGen) })
			])
		),
		work: source.draw(element<LeasePlan["work"]>(["idle", "statement"]))
	}),
	() => ({ cut: { kind: "running" }, work: "statement" })
])

/** Up to eight leases at once on a pool of one to three: often more than the pool holds, so some wait in its queue. */
export const interleavingGen: Gen<Interleaving> = (source) => ({
	max: source.draw(int(1, 3)),
	leases: source.draw(array(leasePlanGen, { min: 1, max: 8 }))
})

/**
 * How far a lease got before its end: what a cut lease was doing when the cut came, and a running lease's backend, which
 * the case watches until its statement waits on the case's lock.
 */
export type Progress =
	| Readonly<{ kind: "asking" }>
	| Readonly<{ kind: "holding" }>
	| Readonly<{ kind: "running"; backend: number }>

/**
 * The lease a connection attempt is for, by its index in the interleaving. The pool runs a new connection's password
 * Effect under the services of the lease whose ask constructs it (wire/session.ts makePool, passwordOf), so the
 * password reads the lease its connection is for.
 */
export const AskingLease = Context.Reference<Option.Option<number>>(
	"grizzle/test/serverless/AskingLease",
	{
		defaultValue: () => Option.none()
	}
)

export type InterleavingFeature =
	| "cut while asking"
	| "cut while asking, a connection being established"
	| "cut holding its session"
	| "cut running a statement"
	| "kept to its end"
	| "more leases than the pool holds"

export const interleavingSituations: Arr.NonEmptyReadonlyArray<InterleavingFeature> = [
	"cut while asking",
	"cut while asking, a connection being established",
	"cut holding its session",
	"cut running a statement",
	"kept to its end",
	"more leases than the pool holds"
]

/** One turn of the event loop, whatever the test's clock: the fibers the loop's last answers woke have run. */
export const eventLoopTurn: Effect.Effect<void> = Effect.suspend(() =>
	Clock.Clock.defaultValue().sleep(Duration.zero)
)

/** The advisory lock a case holds while any of its leases is cut running a statement, which no other test takes. */
export const statementLock = "7366231908012114002"

/** The statement of a lease cut while it runs: it waits on the case's lock until the cut's CancelRequest stops it. */
export const lockWait = "SELECT pg_catalog.pg_advisory_lock($1::int8)::text"

/** The statement of every other lease: it answers at once. */
export const instant = "SELECT 'ran'::text"

/**
 * The cases the search kept by value, which reached their situations on every run: each is the aim of the situations
 * it reaches (aimed), so a case whose turn aims at one draws it. None ever caught a bug (git log -S on the module).
 */
const interleavingCases: ReadonlyArray<{
	readonly why: string
	readonly value: Interleaving
	readonly reaches: ReadonlyArray<InterleavingFeature>
}> = [
	{
		why: "cuts while asking, holding and running on a pool of one",
		value: {
			max: 1,
			leases: [
				{ cut: { kind: "running" }, work: "statement" },
				{ cut: { kind: "cut", at: { kind: "turns", turns: 0, ops: 3 } }, work: "idle" },
				{ cut: { kind: "kept" }, work: "idle" },
				{ cut: { kind: "cut", at: { kind: "turns", turns: 2, ops: 3 } }, work: "idle" }
			]
		},
		reaches: ["cut while asking", "kept to its end", "more leases than the pool holds"]
	}
]

/** The property's aims (interleaving): each kept case's value at every situation it reaches. */
export const interleavingAims: ReadonlyArray<
	readonly [Reached<InterleavingFeature>, Gen<Interleaving>]
> = Arr.flatMap(interleavingCases, (c) =>
	Arr.map(c.reaches, (situation) => [situation, constant(c.value)] as const)
)
