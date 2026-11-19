/**
 * Internal invariants: a value the surrounding code has already established is there, such as the frame on a
 * nonempty stack or the entry of an id the traversal has checked against its table.
 *
 * A violation is a defect of the compiler, never a property of its input, so it throws an Error rather than returning
 * a CompileError, as reading the missing value would have thrown.
 */
export const defined = <A>(value: A | undefined, invariant: string): A => {
	if (value === undefined) {
		throw new Error(`grizzle internal invariant: ${invariant}`)
	}
	return value
}

/**
 * A condition the surrounding code has already established, such as a value of a closed shape the code built itself.
 * It narrows like any assertion: after `invariant(isKey(value), ...)`, value is a key.
 */
export const invariant: (condition: boolean, what: string) => asserts condition = (
	condition,
	what
) => {
	if (!condition) {
		throw new Error(`grizzle internal invariant: ${what}`)
	}
}

/** The defect thrown, or an effect dies with, when an invariant breaks: `throw defect(what)`. */
export const defect = (what: string): Error => new Error(`grizzle internal invariant: ${what}`)
