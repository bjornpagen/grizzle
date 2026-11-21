import { dictionary } from "@bjornpagen/testing/dictionary"

/** How one schema of the chain reaches the next. */
export type Link = "$ref" | "allOf" | "anyOf" | "oneOf"

/** How the request body reaches the chain: pointing straight at its first schema, or through one property. */
export type Entry = "direct" | "property"

/** The applicators a link is written with: JSON Schema's own, a bare reference or a one-member composition. */
export const links = dictionary<Link>(["$ref", "allOf", "anyOf", "oneOf"])

/** Both ways the request body reaches the chain. */
export const entries = dictionary<Entry>(["direct", "property"])
