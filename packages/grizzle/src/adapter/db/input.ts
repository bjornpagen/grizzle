import { Array as Arr, Predicate, Record as Rec, Result } from "effect"
import { readHost } from "#adapter/engine.ts"
import { CallInputRefused } from "#adapter/errors/failures.ts"

/**
 * A call's input as any caller passes it, read once at the boundary that admits it (db/handles.ts), before any SQL: one
 * shape at the wire and in process (live/program.ts Input), `{ params, facts }`, both always present, `{}` where the
 * program takes none, and a paged member's `{ params, facts, window }`. Each member is read once off the caller's record
 * (readHost) and every later read is of what this read left; each value stays opaque here, to be read at its own
 * boundary: the parameters by the program's declared names (reader/params.ts), the facts by the ChangeSet's array
 * members (runtime/write/members.ts memberFactsOf), the window by its anchor and size (page/window.ts). A value that is
 * no record of exactly those members, or whose reading throws, is CallInputRefused at `envelope`.
 *
 * Whether `value` is a record, no list, whose own keys are exactly `keys`.
 */
export const isExactRecord = (
	value: unknown,
	keys: ReadonlyArray<string>
): value is Readonly<Record<string, unknown>> => {
	if (!Predicate.isObject(value) || Arr.isArray(value)) {
		return false
	}
	const own = Reflect.ownKeys(value)
	return own.length === keys.length && Arr.every(keys, (key) => Rec.has(value, key))
}

/** A call's input: its parameters and its facts, each as the caller passed it. */
export interface CallInput {
	readonly params: unknown
	readonly facts: unknown
}

/** A paged member's call's input: its parameters, its facts and its window, each as the caller passed it. */
export interface WindowedInput extends CallInput {
	readonly window: unknown
}

const envelopeRefused = new CallInputRefused({ fault: "envelope" })

/** A call's input read off the caller's `input` (see the header). */
export const callInput = (input: unknown): Result.Result<CallInput, CallInputRefused> =>
	readHost(envelopeRefused, () =>
		isExactRecord(input, ["params", "facts"])
			? Result.succeed({ params: input["params"], facts: input["facts"] })
			: Result.fail(envelopeRefused)
	)

/** A paged member's call's input read off the caller's `input` (see the header). */
export const windowedInput = (input: unknown): Result.Result<WindowedInput, CallInputRefused> =>
	readHost(envelopeRefused, () =>
		isExactRecord(input, ["params", "facts", "window"])
			? Result.succeed({ params: input["params"], facts: input["facts"], window: input["window"] })
			: Result.fail(envelopeRefused)
	)

const factsRefused = new CallInputRefused({ fault: "facts" })

/** The facts of a call of a member that takes none: `{}`, a record with no own key, or CallInputRefused at `facts`. */
export const noFacts = (facts: unknown): Result.Result<void, CallInputRefused> =>
	readHost(factsRefused, () => (isExactRecord(facts, []) ? Result.void : Result.fail(factsRefused)))
