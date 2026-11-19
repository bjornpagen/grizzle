import { dictionary } from "@bjornpagen/testing/dictionary"
import { takeBoxItems } from "#test/types/query/take.ts"

/** Every case: each bound a query takes its rows by, by each spelling of the bound. */
export const takeBox = dictionary(takeBoxItems)
