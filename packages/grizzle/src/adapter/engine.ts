import { Effect, Function, Option, Result } from "effect"
import {
	defect,
	type OptionVocabulary,
	type Result as EngineResult
} from "#compiler/plan/common.ts"

/**
 * The shell's bridge to the engine's vocabularies. The engine has no runtime Effect: its steps answer its own Result
 * (core/result.ts), absence is `T | undefined`, and the Option values of a delivered row are spelled by the constructors
 * the shell passes when it binds a decoder. The shell carries the same values in Effect.
 */

/** A Some, as Effect's own constructor builds it. */
const someOf = <A>(value: A): Option.Some<A> => {
	const option = Option.some(value)
	if (Option.isSome(option)) {
		return option
	}
	throw defect("Option.some answered a None")
}

/** The None, as Effect's own constructor builds it. */
const noneOf = (): Option.None<never> => {
	const option = Option.none()
	if (Option.isNone(option)) {
		return option
	}
	throw defect("Option.none answered a Some")
}

/**
 * How a delivered row spells an Option: Effect's Option, the public row shape (an attachment stated as an Option, a
 * get's answer). The one vocabulary every decoder the shell binds is given.
 */
export const rowOptions: OptionVocabulary = Object.freeze({ some: someOf, none: noneOf() })

/** An engine step's answer as an Effect: its value, or its refusal in the error channel. */
export const fromEngine = <A, E>(result: EngineResult<A, E>): Effect.Effect<A, E> =>
	result.ok ? Effect.succeed(result.value) : Effect.fail(result.error)

/** An engine step's answer as Effect's Result, for shell code that composes it with Effect's own. */
export const toResult = <A, E>(result: EngineResult<A, E>): Result.Result<A, E> =>
	result.ok ? Result.succeed(result.value) : Result.fail(result.error)

/**
 * A read of a caller's value at the boundary, over Effect's Result, as the engine's hostRead (core/host.ts) reads one
 * over its own: reading runs the caller's code (a proxy's traps, a getter), and a throw refuses the value with `fault`
 * instead of escaping as a defect.
 */
export const readHost = <A, F>(fault: F, read: () => Result.Result<A, F>): Result.Result<A, F> =>
	Result.flatMap(Result.try({ try: read, catch: () => fault }), Function.identity)
