import { Array as Arr, Predicate, Result } from "effect"
import { readHost } from "#adapter/engine.ts"
import { CallInputRefused } from "#adapter/errors/failures.ts"

/**
 * A call's input as any caller passes it, read once at the boundary that admits it (db/handles.ts), before any SQL: one
 * shape at the wire and in process (live/program.ts Input), `{ params, facts }`, both always present, `{}` where the
 * program takes none, and a paged member's `{ params, facts, window }`. Each member is read once, through its own
 * property's descriptor (exactRecord), never by a property read a getter or a proxy answers, and every later read is of
 * what this read left; each value stays opaque here, to be read at its own boundary: the parameters by the program's
 * declared names (reader/params.ts), the facts by the ChangeSet's array members (runtime/write/members.ts
 * memberFactsOf), the window by its anchor and size (page/window.ts). A value that is no record of exactly those
 * members, holds an accessor among them, or whose reading throws, is CallInputRefused at `envelope`.
 *
 * The own data properties of `value`, a record no list whose own keys are exactly `keys`, each read through its
 * descriptor; or none, for any other value, and for one whose own key among them is a getter or a setter. A caller of
 * it reads under readHost, since a proxy's descriptor trap may throw.
 */
export const exactRecord = (
	value: unknown,
	keys: ReadonlyArray<string>
): Readonly<Record<string, unknown>> | undefined => {
	if (
		!Predicate.isObject(value) ||
		Arr.isArray(value) ||
		Reflect.ownKeys(value).length !== keys.length
	) {
		return undefined
	}
	const read: Record<string, unknown> = {}
	for (const key of keys) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
		if (descriptor === undefined || !Predicate.hasProperty(descriptor, "value")) {
			return undefined
		}
		read[key] = descriptor.value
	}
	return read
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
	readHost(envelopeRefused, () => {
		const read = exactRecord(input, ["params", "facts"])
		return read === undefined
			? Result.fail(envelopeRefused)
			: Result.succeed({ params: read["params"], facts: read["facts"] })
	})

/** A paged member's call's input read off the caller's `input` (see the header). */
export const windowedInput = (input: unknown): Result.Result<WindowedInput, CallInputRefused> =>
	readHost(envelopeRefused, () => {
		const read = exactRecord(input, ["params", "facts", "window"])
		return read === undefined
			? Result.fail(envelopeRefused)
			: Result.succeed({ params: read["params"], facts: read["facts"], window: read["window"] })
	})

const factsRefused = new CallInputRefused({ fault: "facts" })

/** The facts of a call of a member that takes none: `{}`, a record with no own key, or CallInputRefused at `facts`. */
export const noFacts = (facts: unknown): Result.Result<void, CallInputRefused> =>
	readHost(factsRefused, () =>
		exactRecord(facts, []) === undefined ? Result.fail(factsRefused) : Result.void
	)
