import { dictionary } from "@bjornpagen/testing/dictionary"
import { callKeysBoxItems } from "#test/types/evidence/call-keys.ts"

/** Every case: each call a row's match reads, its id pinned or not, and each way it reads the call's place. */
export const callKeysBox = dictionary(callKeysBoxItems)
