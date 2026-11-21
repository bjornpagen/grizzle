import { dictionary } from "@bjornpagen/testing/dictionary"

/** How a `paths` entry holds its Path Item Object: inline, by reference to a component, or by a chain of two. */
export type Holding = "inline" | "referenced" | "chained"

/** Every way a `paths` entry holds its item. */
export const holdings = dictionary<Holding>(["inline", "referenced", "chained"])
