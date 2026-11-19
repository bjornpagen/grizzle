import { dictionary } from "@bjornpagen/testing/dictionary"
import { hostedBoxItems } from "#test/types/compute/hosted.ts"

/** Every case: each Compute function the host does not evaluate, and a control it does, at each position. */
export const hostedBox = dictionary(hostedBoxItems)
