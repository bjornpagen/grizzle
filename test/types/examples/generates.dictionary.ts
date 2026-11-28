import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { readmeSqlBlocksItems } from "#test/types/examples/documents.ts"
import { readmeProgramsItems } from "#test/types/examples/generates.fixtures.ts"

/** Every program the README's program exports, a box: each must be served by a login it generates, on every run. */
export const readmePrograms = finite(
	word(dictionary(nonEmpty(readmeProgramsItems, "the README's program exports programs")))
)

/** Every sql block of the README, a box: each must be SQL `grizzle generate` drafts for its program, on every run. */
export const readmeSqlBlocks = finite(word(dictionary(readmeSqlBlocksItems)))
