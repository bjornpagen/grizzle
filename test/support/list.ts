/**
 * A value as the list it is. Array.isArray narrows `unknown` to `any[]`, which would let an untyped element flow on;
 * this narrows it to a list of unknown elements, each of which its reader then checks.
 */
import { Array as Arr } from "effect"
export const isList = (value: unknown): value is ReadonlyArray<unknown> => Arr.isArray(value)

/** A list as a call's arguments: the tuple of its elements, at most eight, so spreading it is a call of fixed arity. */
export type Arguments<A> =
	| readonly []
	| readonly [A]
	| readonly [A, A]
	| readonly [A, A, A]
	| readonly [A, A, A, A]
	| readonly [A, A, A, A, A]
	| readonly [A, A, A, A, A, A]
	| readonly [A, A, A, A, A, A, A]
	| readonly [A, A, A, A, A, A, A, A]

/**
 * A drawn list passed to a variadic API as the arguments it is: its elements as one tuple. A test draws a handful of
 * arguments; a list longer than eight is a test that means something else, and fails here by name.
 */
export const argumentsOf = <A>(xs: ReadonlyArray<A>): Arguments<A> => {
	const at = (i: number): A => Arr.getUnsafe(xs, i)
	switch (xs.length) {
		case 0:
			return []
		case 1:
			return [at(0)]
		case 2:
			return [at(0), at(1)]
		case 3:
			return [at(0), at(1), at(2)]
		case 4:
			return [at(0), at(1), at(2), at(3)]
		case 5:
			return [at(0), at(1), at(2), at(3), at(4)]
		case 6:
			return [at(0), at(1), at(2), at(3), at(4), at(5)]
		case 7:
			return [at(0), at(1), at(2), at(3), at(4), at(5), at(6)]
		case 8:
			return [at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7)]
		default:
			throw new Error(`${xs.length} arguments: a test passes at most eight to one call`)
	}
}

/** A non-empty list as a call's arguments: the tuple of its elements, one to eight. */
export type NonEmptyArguments<A> = Exclude<Arguments<A>, readonly []>

/** A drawn non-empty list passed to a variadic API that needs one argument at least: argumentsOf, never empty. */
export const nonEmptyArgumentsOf = <A>(xs: Arr.NonEmptyReadonlyArray<A>): NonEmptyArguments<A> => {
	const args = argumentsOf(xs)
	if (!Arr.isReadonlyArrayNonEmpty(args)) {
		throw new Error("a non-empty list of no element")
	}
	return args
}
