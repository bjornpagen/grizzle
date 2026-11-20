import { dictionary } from "@bjornpagen/testing/dictionary"

/**
 * Where the code a membership asks for comes from: the row's own closed id, a closed read's, or a handle. The kinds of
 * closed-id term a row check reads are the domain, never cases a person chose.
 */
export const codeSources = dictionary(["own", "picked", "handle"] as const)

/**
 * The set a membership asks of: a stored set, a closed row of a product key, a closed row of a dependent key whose last
 * field is a slot, a set value, or a union computed in the row: the kinds of set term a row check reads.
 */
export const setSources = dictionary(["stored", "row", "slotted row", "value", "union"] as const)
