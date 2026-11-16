import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { handwrittenPatternsItems, keptPatternsItems } from "#test/types/text/contained.ts"

/** The kept patterns, a box: every one is checked on every run. */
export const keptPatterns = finite(word(dictionary(keptPatternsItems)))

/** Every family's handwritten patterns, a box: every one is checked on every run. */
export const handwrittenPatterns = finite(word(dictionary(handwrittenPatternsItems)))
