import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { admissionBoxItems } from "#test/support/agreement/admission.ts"
import { argumentBoxItems } from "#test/support/agreement/arguments.ts"

/** The argument agreement's box: every shape against every form it has an argument of, once each. */
export const argumentBox = finite(word(dictionary(argumentBoxItems)))

/**
 * The admission agreement's box, every cell once: every position against every kind it draws (kindsAt), every
 * combinator over every shape under every wrapper, and every cell of the scope axis. Each is a closed roster read by
 * exhaustive switches, so a new position, kind, combinator, shape, wrapper, level, source or place is a cell here.
 */
export const admissionBox = finite(word(dictionary(admissionBoxItems)))
