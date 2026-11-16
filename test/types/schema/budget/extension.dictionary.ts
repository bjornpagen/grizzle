import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { extensionDimensionsItems } from "#test/types/schema/budget/extension.ts"

/** The extension's dimensions, each a case of its cost gate. */
export const extensionDimensions = finite(word(dictionary(extensionDimensionsItems)))
