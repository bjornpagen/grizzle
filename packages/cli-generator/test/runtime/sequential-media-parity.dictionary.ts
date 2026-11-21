import { dictionary } from "@bjornpagen/testing/dictionary"
import { Array as Arr } from "effect"
import { sequentialMediaTypes } from "#runtime-src/runtime/sequential.ts"

/** The runtime's sequential media table's types, its JSON-seq type first. */
const TABLE = Arr.dedupe(
	Arr.prepend(Arr.fromIterable(sequentialMediaTypes.keys()), "application/json-seq")
)

/**
 * The media types a case is drawn from: every type of the table, each type's `+json-seq` suffix form (RFC 8091: any
 * such type is JSON-seq), and each type with a `+xml` suffix, which neither side reads as sequential.
 */
export const essences = dictionary([
	...TABLE,
	...Arr.map(TABLE, (type) => `${type}+json-seq`),
	...Arr.map(TABLE, (type) => `${type}+xml`)
])
