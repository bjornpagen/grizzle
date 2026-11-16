import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { statedRefusalsItems } from "#test/types/examples/documents.ts"

/** Every refusal the README states, a box: each must fail with the claim its directive names, on every run. */
export const statedRefusals = finite(word(dictionary(statedRefusalsItems)))
