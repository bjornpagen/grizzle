import type { Schema } from "effect"

/**
 * A schema of exactly the engine's plain type T: every value it decodes is a T, and every T is a value it encodes. A
 * schema that drifts from T either way does not typecheck, so each boundary decoder of the shell is typed against the
 * engine type it builds (the snapshot, its meta, the ledger, the error fields that carry an engine value).
 */
export const exact =
	<T>() =>
	<S extends Schema.Codec<T, unknown, unknown, unknown>>(
		schema: S & ([T] extends [S["Type"]] ? unknown : never)
	): S =>
		schema
