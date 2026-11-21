import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary } from "@bjornpagen/testing/dictionary"
import { Record as Rec } from "effect"
import { patchVersion } from "#model/spec-section.ts"

/**
 * Every line the generator reads, by the roster the model publishes each line's patch release by (spec-section.ts
 * patchVersion): the specification's own list, never cases a person chose.
 */
export const specLines = dictionary(nonEmpty(Rec.keys(patchVersion), "the specification's lines"))
