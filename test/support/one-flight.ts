import { assert } from "@bjornpagen/testing/assert"
import { Array as Arr, Effect, Formatter, type Scope } from "effect"
import type { ServedDbContext } from "#adapter/db/context.ts"
import { sqlstates } from "#compiler/core/sqlstate.ts"
import { defaultPool, poolFor, rowsOn } from "#test/support/pg/adapter/support.ts"
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
 * outcomes", Witness). A session's first call of a write stands the write up first, in a transaction of its own
 * (adapter/apply/stand-up.ts): one more round trip, before the call's, binding the stand-ups the session records by
 * name, and never again. No other call takes more.
 *
 * The context's pool is one session through a protocol tap (test/support/wire-tap.ts makeTap), warmed outside every
 * window, so a window holds one call's traffic alone. A call refused before any SQL, when its ChangeSet compiles or its
 * inputs are bound, sends nothing.
 */
export interface OneFlight<C extends ServedDbContext> {
	readonly context: C
	/** `effect`'s outcome, after asserting its traffic was one round trip, BEGIN and the transaction's end its only simple
	 * queries, after the session's stand-up of the write at its first call and before its diagnosis after a refusal at
	 * COMMIT by a deferred foreign key, or no traffic at all. */
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
			pool: { max: 1 }
		})
		const session = yield* Effect.orDie(
			Effect.scoped(Effect.tap(pool.lease, (leased) => rowsOn(leased, "SELECT 'warm'::text", [])))
		)
		const judged = <A, E, R>(
			label: string,
			effect: Effect.Effect<A, E, R>
		): Effect.Effect<A, E, R> =>
			Effect.gen(function* () {
				const before = new Set(session.stoodUp.held)
				const mark = tap.mark()
				const value = yield* Effect.result(effect)
				const window = tap.since(mark)
				const stood = Arr.filter([...session.stoodUp.held], (name) => !before.has(name))
				const flights = flightsOf(window)
				const [standUp, write, diagnosis] = Arr.isReadonlyArrayNonEmpty(stood)
					? flights
					: [undefined, ...flights]
				if (standUp !== undefined) {
					const bound = new Set(Arr.map(standUp.frontend, (message) => message.name))
					assert.ok(
						Arr.every(stood, (name) => bound.has(name)) && frameOf(standUp).kind === "framed",
						`${label}: the round trip before the call is the session's stand-up of the write, a transaction binding each stand-up it records`
					)
				}
				if (write !== undefined) {
					const diagnosed =
						diagnosis !== undefined && lastQueryRefusal(write) === sqlstates.foreignKeyViolation
					assert.equal(
						window.roundTrips,
						(standUp === undefined ? 0 : 1) + (diagnosed ? 2 : 1),
						`${label}: round trips on the wire${standUp === undefined ? "" : ", the session's stand-up's"}${diagnosed ? ", the write's and its diagnosis's" : ""}`
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
