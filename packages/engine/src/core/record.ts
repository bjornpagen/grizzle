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

/** A plain record: a non-null object that is no list, whose prototype is Object's or none, as a caller's record is read
 * at the boundary. */
export const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
	if (typeof value !== "object" || value === null || isList(value)) {
		return false
	}
	const proto: unknown = Object.getPrototypeOf(value)
	return proto === Object.prototype || proto === null
}
