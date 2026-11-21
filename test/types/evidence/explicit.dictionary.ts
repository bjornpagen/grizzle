import { dictionary } from "@bjornpagen/testing/dictionary"
import { explicitEvidenceBoxItems } from "#test/types/evidence/explicit.ts"

/** Every public type that takes an evidence, each a cell of the explicit-evidence box. */
export const explicitEvidenceBox = dictionary(explicitEvidenceBoxItems)
