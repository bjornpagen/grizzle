import { Effect } from "effect"
import { dbReadFrame, type ServedDbContext } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import type { DecodedRow, ReadCall } from "#adapter/reader/stream.ts"
import {
	asReadFailure,
	type BatchOutcome,
	type BatchStatement,
	runFramed
} from "#adapter/wire/batch.ts"
import type { Advice } from "#compiler/sql/advice.ts"

/**
 * A read member's call run through a flight of a suite's own (adapter/db/handles.ts readCallOf): what a suite reads when
 * it sends a read's statement itself, or counts what it sends. The call's statement takes its rows as they arrive
 * (wire/batch.ts RowIntake).
 *
 * Sends the statement on a session leased from the Db's pool, in one transaction of its read frame, SERIALIZABLE
 * READ ONLY, as the Db's read runs.
 */
export const flown = (
	ctx: Pick<ServedDbContext, "pool" | "prologue">,
	statement: BatchStatement,
	advice: Advice
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.scoped(
		Effect.flatMap(
			Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason })),
			(session) =>
				Effect.mapError(runFramed(session, dbReadFrame(ctx, advice), [statement]), asReadFailure)
		)
	)

/**
 * The rows of `call`, decoded, in delivery order: its statement sent by `send`, which answers once the flight that
 * carries it has run, and its intake's end read after (reader/run.ts ReadIntake). An encoding past a bound, a failed
 * flight and an answer that contradicts the program's proofs are each the read's failure.
 */
export const readThrough = (
	call: ReadCall,
	send: (statement: BatchStatement, advice: Advice) => Effect.Effect<unknown, ReadError>
): Effect.Effect<ReadonlyArray<DecodedRow>, ReadError> =>
	Effect.gen(function* () {
		const rows: Array<DecodedRow> = []
		const opened = yield* Effect.mapError(
			call.open((row) => {
				rows.push(call.decode(row))
			}),
			(reason) => new ReadFailure({ reason })
		)
		yield* send(opened.statement, call.advice)
		yield* Effect.mapError(Effect.fromResult(opened.end()), (reason) => new ReadFailure({ reason }))
		return rows
	})
