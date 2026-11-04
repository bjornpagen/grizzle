import type { Json } from "#compiler/core/canonical.ts"

/**
 * The one door from an unchecked value to a typed one: it gives the value the type its caller names, checking nothing.
 * Only what grizzle may trust without a check comes through it: what PostgreSQL returns for grizzle's own statements
 * (rows, EXPLAIN, catalog reads), a file grizzle wrote whose digest it has verified first, and a test's own data. Every
 * foreign input (the environment, a CLI argument, a file grizzle did not write or cannot verify) is narrowed by a reader
 * of its own instead, and fails closed with a typed error.
 */
export const trusted = <T>(value: unknown): T => value as T

/** JSON text through the door: parsed once, then trusted. */
export const trustedJson = <T>(text: string): T => trusted<T>(JSON.parse(text))

/** The JSON text of a value grizzle writes: the one door to JSON.stringify outside the engine's own encoders. */
export const jsonText = (value: Json): string => JSON.stringify(value)

/** The JSON text of a file written for a person to read or edit: indented by tabs, one value per line. */
export const jsonDocument = (value: Json): string => JSON.stringify(value, null, "\t")
