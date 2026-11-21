import { dictionary } from "@bjornpagen/testing/dictionary"
import { fixedMethods, queryMethod } from "#model/path-item.ts"

/** The UTF-16 code units a property name is spelled in: a letter, and the two halves of U+1F600. */
export type Unit = "letter" | "high surrogate" | "low surrogate"

/** How a method name is spelled as a key: as the Path Item Object's field, in capitals, or capitalized. */
export type Spelling = "lowercase" | "uppercase" | "capitalized"

/** Every code unit a property name is spelled in. */
export const units = dictionary<Unit>(["letter", "high surrogate", "low surrogate"])

/** Every spelling of a method name as a key. */
export const spellings = dictionary<Spelling>(["lowercase", "uppercase", "capitalized"])

/** Every method a Path Item Object has a field for, by the model's roster (path-item.ts), and `query`. */
export const methods = dictionary([...fixedMethods, queryMethod])
