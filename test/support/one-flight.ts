import { Effect, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { assert } from "#test/support/assert.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, queryTexts } from "#test/support/wire-tap.ts"

/**
 * The one-round-trip property of a write, judged on the wire: a call's BEGIN, every statement and its end go in one
 * pipelined flight, so the session writes once and reads every answer after (README "Transactions and concurrency").
 *
 * The context's pool is one session through a protocol tap (test/support/wire-tap.ts makeTap), warmed outside every
 * window, so a window holds one call's traffic alone. A call refused before any SQL, when its ChangeSet compiles or its
 * inputs are bound, sends nothing.
 */
export interface OneFlight<C extends ServedDbContext> {
	readonly context: C
	/** `effect`'s outcome, after asserting its traffic was one round trip, BEGIN and the transaction's end its only simple
	 * queries, or no traffic at all. */
	readonly judged: <A, E, R>(
		label: string,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E, R>
}

/**
 * `context`, a Db's context, with its pool replaced by one session through a tap, and the judge of each call's traffic
 * on it.
 */
export const oneFlight = <C extends ServedDbContext>(
	context: C,
	credentials: Credentials
): Effect.Effect<OneFlight<C>, never, Substrate | Scope.Scope> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const tap = makeTap(substrate.cluster)
		const pool = yield* poolFor(credentials, {
			...defaultPool,
			transport: { kind: "given", transport: tap.transport },
			pool: { idleTimeoutMs: testIdleTimeout.value, min: 1, max: 1 }
		})
		yield* Effect.orDie(
			Effect.scoped(
				Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
			)
		)
		const judged = <A, E, R>(
			label: string,
			effect: Effect.Effect<A, E, R>
		): Effect.Effect<A, E, R> =>
			Effect.gen(function* () {
				const mark = tap.mark()
				const value = yield* Effect.result(effect)
				const window = tap.since(mark)
				if (window.roundTrips > 0) {
					assert.equal(window.roundTrips, 1, `${label}: round trips on the wire`)
					const framing = queryTexts(window)
					assert.equal(
						framing.length,
						2,
						`${label}: the flight's BEGIN and its end, its only simple queries`
					)
					assert.equal(
						framing[0],
						"BEGIN ISOLATION LEVEL SERIALIZABLE",
						`${label}: the flight opens its transaction`
					)
				}
				return yield* Effect.fromResult(value)
			})
		return { context: { ...context, pool }, judged }
	})
