/** The vocabularies registry.test.ts exhausts: the domain itself, never cases a person chose. */

import { dictionary } from "@bjornpagen/testing/dictionary"
import { carriers } from "#compiler/ir/scalar.ts"
import { spellings } from "#test/support/unit/scalar/support.ts"

/** Every carrier of the registry, in its order (ir/scalar.ts carriers). */
export const carrierWords = dictionary(carriers)

/** Every spelling of the pg namespace that is a descriptor (unit/scalar/support.ts spellings). */
export const spellingWords = dictionary(spellings)
