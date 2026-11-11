import { nominal } from "#compiler/core/brand.ts"
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

declare const callerRecordBrand: unique symbol

/**
 * A caller's object as readCaller copied it: frozen, made by the read, every member a copy of the caller's data, so
 * reading it runs no caller code and answers the same each time. Only readCaller mints one, so a function that takes
 * a CallerRecord is never handed the caller's object itself.
 */
export type CallerRecord = Readonly<Record<string, unknown>> & {
	readonly [callerRecordBrand]: true
}

const callerRecord = nominal<Readonly<Record<string, unknown>>, CallerRecord>()

/**
 * A caller's object read once (readCaller): its own string keys in order, every one of them, those left unread among
 * them, and the copy every later read is of.
 */
export interface CallerObject {
	readonly keys: ReadonlyArray<string>
	readonly data: CallerRecord
}

/**
 * One read's copies: each copy by the caller's object it copies, so a value the caller shares or nests in itself is
 * copied once, and every copy made, frozen once the read is whole.
 */
interface Copies {
	readonly of: Map<object, object>
	readonly made: Array<object>
}

/** A getter or a setter met, or a property the copy cannot hold as stated: the whole value refused. */
const refusedRead: Result.Result<never, undefined> = Result.err(undefined)

/**
 * The copy of one member's value: a primitive as it is, a function by reference, as only a call runs it, and an
 * object, a list or a record, copied (copyInto).
 */
const copyOf = (value: unknown, copies: Copies): Result.Result<unknown, undefined> => {
	if (typeof value !== "object" || value === null) {
		return Result.ok(value)
	}
	const copied = copies.of.get(value)
	if (copied !== undefined) {
		return Result.ok(copied)
	}
	const copy: object = Array.isArray(value) ? [] : {}
	copies.of.set(value, copy)
	copies.made.push(copy)
	return Result.map(copyInto(value, copy, noKeys, copies), () => copy)
}

/** No key left unread: every own key of a member's object is copied. */
const noKeys: ReadonlySet<string> = new Set()

/**
 * Copies every own property of `value` but the string keys `unread` names onto `copy`, each read once, through its
 * descriptor, and answers the object's own string keys in order, the unread among them: a data property's value is
 * copied with its enumerability and configurability (a list's length is never configurable), and a getter or a setter
 * refuses the whole value, as does a property the copy cannot hold as the caller's object states it. Reading a
 * descriptor runs no getter, so the copy holds exactly what the caller's object holds.
 */
const copyInto = (
	value: object,
	copy: object,
	unread: ReadonlySet<string>,
	copies: Copies
): Result.Result<ReadonlyArray<string>, undefined> => {
	const keys: Array<string> = []
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "string") {
			keys.push(key)
			if (unread.has(key)) {
				continue
			}
		}
		const descriptor = Reflect.getOwnPropertyDescriptor(value, key)
		if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
			return refusedRead
		}
		const member: unknown = descriptor.value
		const copied = copyOf(member, copies)
		if (!copied.ok) {
			return copied
		}
		const defined = Reflect.defineProperty(copy, key, {
			value: copied.value,
			enumerable: descriptor.enumerable === true,
			writable: true,
			configurable: descriptor.configurable === true
		})
		if (!defined) {
			return refusedRead
		}
	}
	return Result.ok(keys)
}

/** A read that throws, which readCaller answers as unread, with nothing to say. */
const unreadable = (): undefined => undefined

/**
 * A caller's object that is no list, read once (CallerObject): every own property but the string keys `unread` names,
 * each through its descriptor, and every object and list it holds, at any depth, the same way; a function is kept by
 * reference, as only a call runs it, and an object is copied as a record or a list of its own properties, its class
 * not kept. A value whose reading throws (a refusing proxy), or that holds a getter or a setter anywhere it is read, is
 * refused. The keys `unread` names are left to the boundary, which reads each of them once off the caller's typed
 * value (a function, a class instance, a library's value) or not at all.
 *
 * What the read returns is all of the value anything after it sees: a boundary reads the copy, never the caller's
 * object again, so a value that answers its read and throws, or answers otherwise, later meets nothing that reads it.
 */
export const readCaller = (
	value: object,
	unread: ReadonlySet<string>
): Result.Result<CallerObject, undefined> =>
	hostRead(unreadable, () => {
		const data = {}
		const copies: Copies = { of: new Map([[value, data]]), made: [data] }
		return Result.map(copyInto(value, data, unread, copies), (keys) => {
			for (const copy of copies.made) {
				Object.freeze(copy)
			}
			return { keys, data: callerRecord(data) }
		})
	})
