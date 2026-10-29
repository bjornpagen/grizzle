/**
 * The engine's answer to a step that can refuse: a tagged union with no runtime dependency. Compiler passes return a
 * Result and never throw for an expected refusal; the public builders turn a refusal into a thrown CompileError at the
 * user's call, and the shell carries the same value in Effect's error channel. Read a Result by its tag
 * (`r.ok ? r.value : r.error`); the functions below are the data-first operations the engine uses.
 */
export type Result<A, E> = Ok<A> | Err<E>

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
