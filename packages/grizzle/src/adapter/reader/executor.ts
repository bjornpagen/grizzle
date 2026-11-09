import { Effect } from "effect"
import { type DbContext, dbReadFrame } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import type { UnreadableAnswer } from "#adapter/errors/failures.ts"
import { asReadFailure, type Flight, runFramed } from "#adapter/wire/batch.ts"

/**
 * Where a read's one flight runs: on a session leased for it, in one read-only transaction of the Db's role, in one
 * round trip (../wire/batch.ts runFramed).
 */
export interface ReadExecutor {
	readonly run: <A>(flight: Flight<A, UnreadableAnswer>) => Effect.Effect<A, ReadError>
}

/**
 * Db's executor: each read leases a session of the Db's pool for its flight, runs it as the Db's role, and ends the lease
 * with the read.
 */
export const poolExecutor = (ctx: Pick<DbContext, "pool" | "prologue">): ReadExecutor => ({
	run: (flight) =>
		Effect.scoped(
			Effect.gen(function* () {
				const session = yield* Effect.mapError(
					ctx.pool.lease,
					(reason) => new ReadFailure({ reason })
				)
				const outcomes = yield* Effect.mapError(
					runFramed(session, dbReadFrame(ctx), flight.statements),
					asReadFailure
				)
				return yield* Effect.mapError(
					flight.read(outcomes),
					(reason) => new ReadFailure({ reason })
				)
			})
		)
})
