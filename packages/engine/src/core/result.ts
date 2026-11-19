import type { Result as Public } from "effect"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"

/**
 * The engine's answer to a step that can refuse: a tagged union with no runtime dependency. Compiler passes return a
 * Result and never throw for an expected refusal; the public builders turn a refusal into a thrown CompileError at the
 * user's call, and the shell carries the same value in Effect's error channel. Read a Result by its tag
 * (`r.ok ? r.value : r.error`); the functions below are the data-first operations the engine uses. It is the engine's
 * own: every answer a caller reads is Effect's Result (PublicResult).
 */
export type Result<A, E> = Ok<A> | Err<E>

/**
 * How a public answer spells a Result: the shell's conversion of an engine Result into Effect's (packages/grizzle
 * adapter/engine.ts toResult), passed where the shell builds a public reader, rowEvaluator, insertPreview or codecText,
 * so the engine answers every item a caller reads as Effect's Result, where the item is computed, without a runtime
 * dependency on Effect.
 */
export type PublicResult = <A, E>(result: Result<A, E>) => Public.Result<A, E>

/** A step that succeeded, with its value. */
export interface Ok<A> {
	readonly ok: true
	readonly value: A
}

/** A step that refused, with its error. */
export interface Err<E> {
	readonly ok: false
	readonly error: E
}

export const ok = <A>(value: A): Ok<A> => ({ ok: true, value })

export const err = <E>(error: E): Err<E> => ({ ok: false, error })

/** `f` applied to the value, keeping a refusal. */
export const map = <A, B, E>(r: Result<A, E>, f: (a: A) => B): Result<B, E> =>
	r.ok ? ok(f(r.value)) : r

/** `f`'s answer for the value, keeping a refusal. */
export const flatMap = <A, B, E, F>(r: Result<A, E>, f: (a: A) => Result<B, F>): Result<B, E | F> =>
	r.ok ? f(r.value) : r

/** `f` applied to the error, keeping a success. */
export const mapError = <A, E, F>(r: Result<A, E>, f: (e: E) => F): Result<A, F> =>
	r.ok ? r : err(f(r.error))

/**
 * Each of `xs` mapped by `f`, with its position, in order, or the first refusal: the one traverse of the engine's
 * Result, which maps no item past the first that refuses.
 */
export const each = <A, B, E>(
	xs: ReadonlyArray<A>,
	f: (a: A, at: number) => Result<B, E>
): Result<ReadonlyArray<B>, E> => {
	const out: Array<B> = []
	for (const [at, x] of xs.entries()) {
		const y = f(x, at)
		if (!y.ok) {
			return y
		}
		out.push(y.value)
	}
	return ok(Object.freeze(out))
}

/** A non-empty list's `each`, its answer non-empty. */
export const eachNonEmpty = <A, B, E>(
	xs: NonEmptyReadonlyArray<A>,
	f: (a: A, at: number) => Result<B, E>
): Result<NonEmptyReadonlyArray<B>, E> => {
	const [head, ...tail] = xs
	const first = f(head, 0)
	if (!first.ok) {
		return first
	}
	return map(
		each(tail, (a, at) => f(a, at + 1)),
		(rest) => [first.value, ...rest] as const
	)
}
