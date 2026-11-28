/**
 * Every citation of a document by heading resolves. grizzle's sources, tests and documents cite the reference by
 * heading, `DOC "Heading"` (references.fixtures.ts): README, CONTRIBUTING and SKILL by name, a page of docs/ by its path.
 * A heading renamed, or a section moved to another page, leaves every citation of it pointing nowhere, and a reader of
 * the comment finds no such section: here each citation names exactly one heading of its document, and none is written
 * in another spelling, so a citation that goes stale fails where it stands.
 *
 * Oracle: the documents themselves, their markdown headings as the checkout holds them.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { citingFiles } from "#test/unit/dev/references.dictionary.ts"
import { citationProblems } from "#test/unit/dev/references.fixtures.ts"

/** Every citation of a document by heading names exactly one heading of its document, in the one spelling. */
export const everyCitationOfADocumentByHeadingNamesExactlyOneHeadingOfItsDocument =
	property.exhaust(citingFiles, {
		box: "every file that may cite a document: grizzle's sources, its tests, AGENTS.md, the README, CONTRIBUTING.md, SKILL.md and docs/",
		needs: { checkout: Checkout.dir },
		situations: [],
		check: (resources) => (file) =>
			Effect.gen(function* () {
				const checkout = yield* resources.checkout
				const problems = yield* citationProblems(checkout, file)
				assert.deepEqual(problems, [])
			}),
		oracle: {
			kind: "specification",
			name: "the documents' own headings, as the checkout holds them"
		},
		show: (file) => file,
		kept: [],
		kills: [
			{
				file: "docs/reads-and-writes.md",
				original: "### Places\n",
				replacement: "### Placing rows\n",
				why: 'A heading renamed while the sources still cite it, docs/reads-and-writes.md "Places": a citation to a missing heading.'
			}
		]
	})
