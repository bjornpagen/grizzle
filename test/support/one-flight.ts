import { assert } from "@bjornpagen/testing/assert"
import { Effect, Formatter, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import {
	flightsOf,
	frameOf,
	lastQueryRefusal,
	makeTap,
	type WireWindow
} from "#test/support/wire-tap.ts"

/**
 * The one-round-trip property of a write, judged on the wire: a call's BEGIN, every statement and its end go in one
 * pipelined flight, so the session writes once and reads every answer after (README "Transactions and concurrency").
 * A write whose COMMIT PostgreSQL refused by a deferred foreign key, 23503 at COMMIT, takes one more: its diagnosis
 * (packages/grizzle/src/adapter/apply/run.ts unmatchedWitness), the write's statements again and the key's witness
 * query in a transaction of the same frame that ends ROLLBACK, sent whole as the first was (README "Errors and
 * outcomes", Witness). No other call takes two, and none takes three.
 *
 * The context's pool is one session through a protocol tap (test/support/wire-tap.ts makeTap), warmed outside every
 * window, so a window holds one call's traffic alone. A call refused before any SQL, when its ChangeSet compiles or its
 * inputs are bound, sends nothing.
 */
export interface OneFlight<C extends ServedDbContext> {
	readonly context: C
	/** `effect`'s outcome, after asserting its traffic was one round trip, BEGIN and the transaction's end its only simple
	 * queries, or that and its diagnosis after a refusal at COMMIT by a deferred foreign key, or no traffic at all. */
	readonly judged: <A, E, R>(
		label: string,
		effect: Effect.Effect<A, E, R>
	) => Effect.Effect<A, E, R>
}

/**
 * Asserts `flight`'s BEGIN and its end are its only simple queries, a SERIALIZABLE write's, a diagnosis's ending
 * ROLLBACK.
 */
const writeFrame = (
	label: string,
	what: "the flight" | "the diagnosis",
	flight: WireWindow
): void => {
	const frame = frameOf(flight)
	assert.ok(
		frame.kind === "framed" &&
			frame.isolation === "SERIALIZABLE" &&
			frame.access === "read write" &&
			(what === "the flight" || frame.end === "rollback"),
		`${label}: ${what}'s BEGIN and its end are its only simple queries, a SERIALIZABLE write's${what === "the diagnosis" ? " ending ROLLBACK" : ""}: ${Formatter.format(frame)}`
	)
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
			pool: { idleTimeoutMs: testIdleTimeout, min: 1, max: 1 }
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
				const [write, diagnosis] = flightsOf(window)
				if (write !== undefined) {
					const diagnosed =
						diagnosis !== undefined && lastQueryRefusal(write) === sqlstates.foreignKeyViolation
					assert.equal(
						window.roundTrips,
						diagnosed ? 2 : 1,
						`${label}: round trips on the wire${diagnosed ? ", the write's and its diagnosis's" : ""}`
					)
					writeFrame(label, "the flight", write)
					if (diagnosis !== undefined) {
						writeFrame(label, "the diagnosis", diagnosis)
					}
				}
				return yield* Effect.fromResult(value)
			})
		return { context: { ...context, pool }, judged }
	})
