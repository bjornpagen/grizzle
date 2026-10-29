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
