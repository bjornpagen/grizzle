import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { documentedBlocksItems } from "#test/types/examples/documents.ts"

/** Every ts block of the documentation, a box: each must be mirrored in its fixture on every run. */
export const documentedBlocks = finite(word(dictionary(documentedBlocksItems)))
