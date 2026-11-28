import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { citingFilesItems } from "#test/unit/dev/references.fixtures.ts"

/** Every file that may cite a document by heading, a box: each file's citations must all resolve, on every run. */
export const citingFiles = finite(
	word(
		dictionary(nonEmpty(citingFilesItems, "the repository holds files that may cite a document"))
	)
)
