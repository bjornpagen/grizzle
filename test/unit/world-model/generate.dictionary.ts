/** The dictionaries generate.test.ts draws from: the world model's invalid kinds, the vocabulary's closed roster. */

import { dictionary } from "@bjornpagen/testing/dictionary"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import { invalidKinds } from "#test/support/worlds/invalid/kinds.ts"

/** Every invalid kind, in the vocabulary's order. */
export const invalidKindWords = dictionary(knownNonEmpty(invalidKinds, "the invalid kinds"))
