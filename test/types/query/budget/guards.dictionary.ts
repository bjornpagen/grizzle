import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { guardCasesItems } from "#test/types/query/budget/guards.ts"

/** The guards gate's cases: the natural form's inserts over both bases, and the differing rows. */
export const guardCases = finite(word(dictionary(guardCasesItems)))
