import { dictionary } from "@bjornpagen/testing/dictionary"

/** The parameter locations every line lists for a parameter with a schema (the Parameter Object's `in`). */
const LISTED_LOCATIONS = ["query", "header", "cookie"] as const

/** OpenAPI 2.0's parameter locations, which no 3.x line lists. */
export const UNLISTED_LOCATIONS = ["body", "formData"] as const

export type Location = (typeof LISTED_LOCATIONS)[number] | (typeof UNLISTED_LOCATIONS)[number]

/** JSON Schema's simple types a Schema Object's `type` may name on every line. */
const LISTED_TYPES = ["object", "string", "integer", "number", "boolean"] as const

/** A misspelt type and OpenAPI 2.0's `file`, which no dialect lists. */
export const UNLISTED_TYPES = ["strng", "file"] as const

export type SchemaType = (typeof LISTED_TYPES)[number] | (typeof UNLISTED_TYPES)[number]

/** Every parameter location, listed and unlisted. */
export const locations = dictionary<Location>([...LISTED_LOCATIONS, ...UNLISTED_LOCATIONS])

/** Every schema type, listed and unlisted. */
export const schemaTypes = dictionary<SchemaType>([...LISTED_TYPES, ...UNLISTED_TYPES])
