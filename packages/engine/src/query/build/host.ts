import { hostRead } from "#compiler/core/host.ts"
import * as Result from "#compiler/core/result.ts"
import { queryState } from "#compiler/query/build/state.ts"
import { malformed } from "#compiler/schema/protocol.ts"

/**
 * Whether every own property of `value`, and of every unfrozen object it holds, is a data property. It reads each
 * object's prototype too, as the builder does when it tests a value's class (instanceof, a plain record), so a trap
 * that throws there throws here, at the boundary.
 */
const dataOnly = (value: unknown, seen: Set<object>): boolean => {
	if (
		typeof value !== "object" ||
		value === null ||
		seen.has(value) ||
		queryState(value) !== undefined
	) {
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
		if (deep && !dataOnly(descriptor.value, seen)) {
			return false
		}
	}
	return true
}

/** Whether every argument reads as data, a reading that throws counting as one that does not. */
const readableArguments = (args: ReadonlyArray<unknown>): boolean => {
	const seen = new Set<object>()
	const read = hostRead(undefined, () => Result.ok(args.every((a) => dataOnly(a, seen))))
	return read.ok && read.value
}

/**
 * A JavaScript caller's arguments at the builder's boundary, read once.
 *
 * A caller's value is untrusted until it has been read once, and reading it can run the caller's code: a proxy's
 * traps, a getter. Such code may throw, and an exception from it would escape the builder as a defect, or answer
 * differently the second time the builder reads the same property. So every argument of every builder entry (query,
 * v, the rule builder's members, a Finished's attach, the query and ordered query combinators) is read here first,
 * in one guarded pass that runs no code of the builder's own: its prototype and extensibility, and every own
 * property's descriptor, of the argument and of each unfrozen record and array it holds, at any depth. A value whose
 * reading throws, or that holds a getter or a setter, is refused as MalformedDescription at the entry's label. What
 * passes holds data properties only, so every later read of it is a read of data: it runs no caller code and answers
 * the same each time. A frozen object (a value the builder or the schema package made, a Decimal, a Money) is read one
 * level deep, since nothing it holds can change. A query or ordered query the builder made is read not at all: its
 * Description is a getter of the builder's own over its state (query.ts), and the builder trusts exactly the values it
 * made (state.ts). A function is the caller's callback, run as the entry documents.
 *
 * A proxy is no different here from the object it stands for: one whose traps answer this pass and throw later is
 * beyond what a JavaScript caller can be held to, and its later exception is its own.
 *
 * Reads every argument of the entry `label` once, refusing one whose reading throws or that holds a getter or setter.
 */
export const hostArguments = (label: string, ...args: ReadonlyArray<unknown>): void => {
	if (!readableArguments(args)) {
		throw malformed(
			label,
			"an argument whose properties can be read as data: no getter, setter or refusing proxy"
		)
	}
}
