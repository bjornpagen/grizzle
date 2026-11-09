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

/**
 * Whether every own property of `value`, and of every unfrozen object it holds, is a data property, `opaque` values
 * read not at all. It reads each object's prototype too, as a builder does when it tests a value's class (instanceof, a
 * plain record), so a trap that throws there throws here, at the boundary.
 */
const dataOnly = (
	value: unknown,
	seen: Set<object>,
	opaque: (value: object) => boolean
): boolean => {
	if (typeof value !== "object" || value === null || seen.has(value) || opaque(value)) {
		return true
	}
	seen.add(value)
	Object.getPrototypeOf(value)
	const deep = !Object.isFrozen(value)
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			return false
		}
		if (deep && !dataOnly(descriptor.value, seen, opaque)) {
			return false
		}
	}
	return true
}

/** A reading that throws, which readsAsData answers as no data, with nothing to say. */
const noFault = (): undefined => undefined

/**
 * Whether every argument reads as data (dataOnly), a reading that throws counting as one that does not: what every
 * boundary reads a JavaScript caller's arguments by once, the builders' (query/build/host.ts hostArguments), whose
 * own values are `opaque`, and a running layer's and Db's, which trust none.
 */
export const readsAsData = (
	args: ReadonlyArray<unknown>,
	opaque: (value: object) => boolean
): boolean => {
	const seen = new Set<object>()
	const read = hostRead(noFault, () => Result.ok(args.every((a) => dataOnly(a, seen, opaque))))
	return read.ok && read.value
}

/** No value is opaque: a runtime boundary reads every object its caller passes. */
export const noOpaque = (): boolean => false
