import * as Result from "#compiler/core/result.ts"

/**
 * Reading a caller's value at the boundary. A JavaScript value is untrusted until it has been read once, and reading it
 * runs the caller's code (a proxy's traps, a getter), which may throw: that refuses the value with the fault `refused`
 * makes, made only then, instead of escaping as a defect. Every read of a caller's value goes through here, once, and
 * what the read returns is all of the value anything after it sees.
 */
export const hostRead = <A, F>(
	refused: () => F,
	read: () => Result.Result<A, F>
): Result.Result<A, F> => {
	try {
		return read()
	} catch {
		return Result.err(refused())
	}
}
