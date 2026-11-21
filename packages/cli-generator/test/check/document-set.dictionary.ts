import { dictionary } from "@bjornpagen/testing/dictionary"

/** Where a referenced component sits: the entry document, or the second document of the set. */
export type Site = "entry" | "second"

/** Both sites a referenced component may sit in. */
export const sites = dictionary<Site>(["entry", "second"])
