import { Effect, Queue, type Result, Stream } from "effect"
import { type ServedDbContext, dbReadFrame } from "#adapter/db/context.ts"
import { type ReadError, ReadFailure } from "#adapter/errors/execution.ts"
import type { InputTooLarge, UnreadableAnswer } from "#adapter/errors/failures.ts"
import { callErrorOf } from "#adapter/live/call-error.ts"
import { asReadFailure, type PreparedStatement, runFramed } from "#adapter/wire/batch.ts"
import {
	type CallError,
	type KeyFields,
	keyOf,
	type ListEvent,
	type RowKey,
	type SetEvent
} from "#compiler/live/index.ts"
import type { Row } from "#compiler/plan/common.ts"

/**
 * A read call as the stream of its events (live/events.ts), the one stream a read's every answer is: a call's once and
 * watch, and every re-run of its subscription (live/subscriptions.ts), so the initial value and each re-run send the
 * same named statement through the same frame by construction.
 *
 * It opens with `reset`, naming the key fields its rows are keyed by; sends one `upsert` per delivered row the moment
 * its Row is whole, provisional (reader/run.ts Emission: a one-part program's as its row arrives, every other's once its
 * statement has answered); and ends with `ready` once the read's COMMIT answered. A failure ends it with one `error` in
 * place of `ready`, which voids every upsert before it: the acquisition's refusal, the statement's encoding past a
 * bound, any failure of the flight (wire/batch.ts asReadFailure), and an answer that contradicts the program's proofs
 * (UnreadableAnswer), each classified once (live/call-error.ts callErrorOf). The stream itself never fails.
 *
 * Its session is leased for the flight alone and released as the flight ends, before `ready` is sent; interrupting the
 * stream while the flight runs interrupts the flight (wire/batch.ts: one CancelRequest, the session destroyed).
 *
 * A decoded row: the record a read's decoder assembles, its head fields by name.
 */
export type DecodedRow = Readonly<Record<string, unknown>>

/**
 * One call of a read, its input read at the boundary: the key fields its rows are keyed by (the served read's key), how
 * its statement is made with its rows' intake, and the decoder of its delivered Rows.
 */
export interface ReadCall {
	readonly fields: KeyFields
	/**
	 * The call's statement, its rows taken by an intake that hands each delivered Row to `emit` the moment it is whole,
	 * and the intake's end, called once the flight answered whole (reader/run.ts ReadIntake); or the statement's
	 * encoding past a bound of its transport.
	 */
	readonly open: (emit: (row: Row) => void) => Effect.Effect<OpenedRead, InputTooLarge>
	readonly decode: (row: Row) => DecodedRow
}

/** A read call's statement and its intake's end (ReadCall.open). */
export interface OpenedRead {
	readonly statement: PreparedStatement
	readonly end: () => Result.Result<void, UnreadableAnswer>
}

/**
 * How one call's events of one read shape are made (live/events.ts events): its reset under its key fields, the upsert
 * of each decoded row in delivery order, made by a closure of the call's own, its ready and its error.
 */
export interface ShapeEvents<E> {
	readonly reset: (fields: KeyFields) => E
	readonly upserts: (fields: KeyFields) => (row: DecodedRow) => E
	readonly ready: E
	readonly error: (error: CallError) => E
}

/** A set read's events: each upsert carries its row. */
export const setEvents: ShapeEvents<SetEvent<DecodedRow>> = {
	reset: (fields) => ({ kind: "reset", key: fields }),
	upserts: () => (row) => ({ kind: "upsert", row }),
	ready: { kind: "ready" },
	error: (error) => ({ kind: "error", error })
}

/** An ordered read's events: each upsert carries the key of the row before it too, null for the first. */
export const listEvents: ShapeEvents<ListEvent<DecodedRow>> = {
	reset: (fields) => ({ kind: "reset", key: fields }),
	upserts: (fields) => {
		let after: RowKey | null = null
		return (row) => {
			const event: ListEvent<DecodedRow> = { kind: "upsert", row, after }
			after = keyOf(fields, row)
			return event
		}
	},
	ready: { kind: "ready" },
	error: (error) => ({ kind: "error", error })
}

/**
 * The call's one flight on a session of the Db's pool, every delivered Row handed to `emit` as it is whole: the lease,
 * the statement, the flight in the Db's read frame, then the intake's end.
 */
const runRead = (
	ctx: Pick<ServedDbContext, "pool" | "prologue">,
	call: ReadCall,
	emit: (row: Row) => void
): Effect.Effect<void, ReadError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const session = yield* Effect.mapError(
				ctx.pool.lease,
				(reason) => new ReadFailure({ reason })
			)
			const opened = yield* Effect.mapError(
				call.open(emit),
				(reason) => new ReadFailure({ reason })
			)
			yield* Effect.mapError(
				runFramed(session, dbReadFrame(ctx), [opened.statement]),
				asReadFailure
			)
			return yield* Effect.mapError(
				Effect.fromResult(opened.end()),
				(reason) => new ReadFailure({ reason })
			)
		})
	)

/** The events of one read call through the Db's frame, each made by its shape's `events` (see the header). */
export const readStream = <E>(
	ctx: Pick<ServedDbContext, "pool" | "prologue">,
	call: ReadCall,
	events: ShapeEvents<E>
): Stream.Stream<E> =>
	Stream.callback<E>((queue) =>
		Effect.gen(function* () {
			Queue.offerUnsafe(queue, events.reset(call.fields))
			const upsert = events.upserts(call.fields)
			const last = yield* runRead(ctx, call, (row) => {
				Queue.offerUnsafe(queue, upsert(call.decode(row)))
			}).pipe(
				Effect.as(events.ready),
				Effect.catch((failure) => Effect.succeed(events.error(callErrorOf(failure))))
			)
			Queue.offerUnsafe(queue, last)
			Queue.endUnsafe(queue)
		})
	)
