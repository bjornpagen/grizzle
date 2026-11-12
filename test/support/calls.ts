import { Effect, Option } from "effect"
import type { OnceCalls, WrittenOutcome } from "#adapter/db/handles.ts"
import type { DecodedRow } from "#adapter/reader/stream.ts"
import type { CallError, CallErrorOf } from "#compiler/live/index.ts"
import { defect } from "#compiler/plan/runtime.ts"

/**
 * The tests' readings of a member's calls (adapter/db/handles.ts): a read's value as its rows in order, its at most one
 * row, and a write's answer with the refusals a test expects as values beside its outcome. Each reads the public
 * contract alone: a value at `ready`, an outcome after COMMIT, every failure one CallError.
 *
 * The rows of a read's value, in its order (a set's in the order its keys arrived, a list's the program's).
 */
export const rowsOf = <Row, E, R>(
	value: Effect.Effect<Iterable<Row>, E, R>
): Effect.Effect<ReadonlyArray<Row>, E, R> => Effect.map(value, (rows) => [...rows])

/**
 * The one row of a read's value, or none: the value of a key member or a read proved at most one row per binding,
 * whose value holds at most one; a second row is a defect of the proof the served key states.
 */
export const oneOf = <Row, E, R>(
	value: Effect.Effect<Iterable<Row>, E, R>
): Effect.Effect<Option.Option<Row>, E, R> =>
	Effect.map(value, (rows) => {
		const [first, second] = [...rows]
		if (second !== undefined) {
			throw defect("a value of at most one row holds two")
		}
		return Option.fromUndefinedOr(first)
	})

/** The refusals a write's answer holds beside its outcome: the laws', and a fact outside the world relation. */
export type WriteRefusal = CallErrorOf<"refused"> | CallErrorOf<"outsideWorld">

/** A write's answer as a test reads it: its outcome, or the refusal it ended with (WriteRefusal). */
export type WriteAnswer<O> = O | WriteRefusal

const isRefusal = (error: CallError): error is WriteRefusal =>
	error.kind === "refused" || error.kind === "outsideWorld"

/** A write's answer (WriteAnswer): its refusal moved into the value, every other CallError still its failure. */
export const answered = <O, R>(
	write: Effect.Effect<O, CallError, R>
): Effect.Effect<WriteAnswer<O>, CallError, R> =>
	Effect.catchIf(write, isRefusal, (refusal) => Effect.succeed<WriteAnswer<O>>(refusal))

/** A read member's once over its rows, from its untyped calls: a write member here is a defect of the test. */
export const readOnce =
	(calls: OnceCalls) =>
	(input: unknown): Effect.Effect<ReadonlyArray<DecodedRow>, CallError> => {
		switch (calls.shape) {
			case "set":
			case "instantSet":
				return rowsOf(calls.once(input))
			case "list":
			case "instantList":
				return rowsOf(calls.once(input))
			case "write":
				return Effect.die(defect("a read of a write member"))
		}
	}

/** A write member's once, from its untyped calls: a read member here is a defect of the test. */
export const writeOnce =
	(calls: OnceCalls) =>
	(input: unknown): Effect.Effect<WrittenOutcome, CallError> =>
		calls.shape === "write" ? calls.once(input) : Effect.die(defect("a write of a read member"))
