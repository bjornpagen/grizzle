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

/**
 * A read member's call run through flights of a suite's own (adapter/db/handles.ts readCallOf): what a suite reads
 * when it sends a read's statement beside another's in one snapshot, or counts what it sends. The call's statement takes
 * its rows as they arrive (wire/batch.ts RowIntake), whichever flight carries it, so a flight that carries several
 * reads' statements hands each its own rows.
 *
 * Sends one flight's statements on a session leased from the Db's pool, in one transaction of its read frame.
 */
export const flown = (
	ctx: Pick<ServedDbContext, "pool" | "prologue">,
	statements: ReadonlyArray<BatchStatement>
): Effect.Effect<ReadonlyArray<BatchOutcome>, ReadError> =>
	Effect.scoped(
		Effect.flatMap(
			Effect.mapError(ctx.pool.lease, (reason) => new ReadFailure({ reason })),
			(session) =>
				Effect.mapError(runFramed(session, dbReadFrame(ctx, false), statements), asReadFailure)
		)
	)

/**
 * The rows of `call`, decoded, in delivery order: its statement sent by `send`, which answers once the flight that
 * carries it has run, and its intake's end read after (reader/run.ts ReadIntake). An encoding past a bound, a failed
 * flight and an answer that contradicts the program's proofs are each the read's failure.
 */
export const readThrough = (
	call: ReadCall,
	send: (statements: ReadonlyArray<BatchStatement>) => Effect.Effect<unknown, ReadError>
): Effect.Effect<ReadonlyArray<DecodedRow>, ReadError> =>
	Effect.gen(function* () {
		const rows: Array<DecodedRow> = []
		const opened = yield* Effect.mapError(
			call.open((row) => {
				rows.push(call.decode(row))
			}),
			(reason) => new ReadFailure({ reason })
		)
		yield* send([opened.statement])
		yield* Effect.mapError(Effect.fromResult(opened.end()), (reason) => new ReadFailure({ reason }))
		return rows
	})
