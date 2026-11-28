import { nonEmpty } from "@bjornpagen/testing/assert"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { finite } from "@bjornpagen/testing/gen"
import { oldNameFilesItems } from "#test/unit/dev/old-names.fixtures.ts"

/** Every file that may spell grizzle's public API, a box: none may hold an old spelling, on every run. */
export const oldNameFiles = finite(
	word(
		dictionary(nonEmpty(oldNameFilesItems, "the repository holds files that spell grizzle's API"))
	)
)
