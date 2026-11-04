import { Effect, type Scope } from "effect"
import { makeDb } from "#adapter/db/db.ts"
import type { Db } from "#adapter/public/db.ts"
import { defaultPool, poolFor, rowsOn } from "#test/pg/adapter/support.ts"
import { contextOf } from "#test/support/runtime-db.ts"
import type { Credentials } from "#test/support/substrate/session.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"
import { makeTap, type Tap } from "#test/support/wire-tap.ts"

/**
 * Shared parts of the public-API error matrix (test/pg/api-errors): a Db on a tapped pool of one warmed session, so a
 * window of the tap holds one call's traffic and a refusal before any SQL sends no frontend message.
 *
 * `db`'s runtime on a tapped pool of one session for `credentials`, its login's, warmed: a Db of no workload program.
 */
export const tappedDb = <R>(
	db: Db<R, unknown>,
	credentials: Credentials
): Effect.Effect<
	{ readonly db: Db<R, unknown>; readonly tap: Tap },
	never,
	Substrate | Scope.Scope
> =>
	Effect.gen(function* () {
		const substrate = yield* Substrate
		const tap = makeTap(substrate.cluster)
		const pool = yield* poolFor(credentials, {
			...defaultPool,
			transport: { kind: "given", transport: { _tag: "stream", open: tap.open } },
			pool: { idleTimeoutMs: 60_000, min: 1, max: 1 }
		})
		yield* Effect.orDie(
			Effect.scoped(
				Effect.flatMap(pool.lease, (session) => rowsOn(session, "SELECT 'warm'::text", []))
			)
		)
		return { db: makeDb<R, unknown>({ ...contextOf(db), pool }, {}), tap }
	})
