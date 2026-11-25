/**
 * Structural reading of an unknown value, each predicate claiming no more than it checks: every property of a non-null
 * object reads as some value, which `unknown` describes. Callers check each property or element they read.
 *
 * A non-null object.
 */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

/**
 * A value that carries properties: a non-null object, or a function, since a builder's value (a query, a schema, a
 * field descriptor) is a function with properties.
 */
export const hasProperties = (value: unknown): value is Readonly<Record<string, unknown>> =>
	(typeof value === "object" || typeof value === "function") && value !== null

export const isList = (value: unknown): value is ReadonlyArray<unknown> => Array.isArray(value)

/** A host value a relation parameter can be read from: an object whose Symbol.iterator is a method. */
export const isIterable = (value: unknown): value is Iterable<unknown> =>
	typeof value === "object" &&
	value !== null &&
	Symbol.iterator in value &&
	typeof value[Symbol.iterator] === "function"

/** A plain record: a non-null object that is no list, whose prototype is Object's or none, as a caller's record is read
 * at the boundary. */
export const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || isList(value)) {
		return false
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}

/**
 * `value` frozen throughout, stopping at what is frozen already: a value built over parts frozen when they were built,
 * such as a node's inputs and expressions or a decoded Description's parts, is walked in its own new containers only.
 */
export const deepFreeze = <A>(value: A): A => {
	if (isRecord(value) && !Object.isFrozen(value)) {
		Object.freeze(value)
		if (isList(value)) {
			for (const child of value) {
				deepFreeze(child)
			}
		} else {
			for (const key in value) {
				if (Object.hasOwn(value, key)) {
					deepFreeze(value[key])
				}
			}
		}
	}
	return value
}

/**
 * A frozen record of `entries` without a prototype, so a key named like a member of `Object.prototype` is an own
 * property like any other: the one record grizzle's builders assemble (schema/record.ts), its decoders deliver
 * (live/codec.ts) and its records' facts are (runtime/records.ts).
 */
export const frozenRecordOf = (
	entries: Iterable<readonly [string, unknown]>
): Readonly<Record<string, unknown>> => {
	const out: Record<string, unknown> = { __proto__: null }
	for (const [key, value] of entries) {
		out[key] = value
	}
	return Object.freeze(out)
}

/** `record` with each value mapped by `f`, its keys in their order. */
export const mapRecord = <A, B>(
	record: Readonly<Record<string, A>>,
	f: (value: A, key: string) => B
): Readonly<Record<string, B>> =>
	Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value, key)]))
