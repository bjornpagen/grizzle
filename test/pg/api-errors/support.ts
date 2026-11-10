import { Effect } from "effect"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { testIdleTimeout } from "#test/support/limits.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap } from "#test/support/wire-tap.ts"

/**
 * Shared parts of the public-API error matrix (test/pg/api-errors): a tapped pool of one warmed session, which a served
 * Db's context runs its members on, so a window of the tap holds one call's traffic and a refusal before any SQL sends
 * no frontend message.
 *
 * The pool of one session for `credentials`, its login's, warmed, and its tap.
 */
export const tappedPool = (credentials: Credentials) =>
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
		return { pool, tap }
	})
