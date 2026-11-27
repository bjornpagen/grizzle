import { dictionary } from "@bjornpagen/testing/dictionary"
import { draftInputOrder } from "#cli/draft-inputs.ts"

/**
 * Every member of the roster of a draft's inputs, in roster order (packages/grizzle/src/cli/draft-inputs.ts
 * draftInputOrder). The roster is the domain, never cases a person chose.
 */
export const draftInputMembers = dictionary(draftInputOrder)
