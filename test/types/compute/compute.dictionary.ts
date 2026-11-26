import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { computeKeptItems } from "#test/support/agreement/compute.ts"

/**
 * The kept cases, each a construct and what it reaches by construction, which a drawn case may miss: a closed relation
 * read, a translate whose image names no domain and one over a map typed string, an arithmetic and a pattern the engine
 * once disagreed on, a digest, a byte guard, a match's overlap, a branch reading its subject outside its parameter, and a
 * guard's bounds of more digits than the term they are compared with holds.
 * A box of the source's own cases, each checked on every run.
 */
export const computeKept = finite(word(dictionary(computeKeptItems)))
