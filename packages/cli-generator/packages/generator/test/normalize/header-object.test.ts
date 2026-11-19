/**
 * A Header Object's `required` and `deprecated` marks, as headerMarks reads them (normalize/header-object.ts): each is
 * true only when written as the boolean true, a mark of any other type reads as false without discarding its sibling,
 * and a use site that is a reference reads the header at the end of its chain.
 *
 * Oracle: the Header Object's fields as the specification types them (booleans, absent as false), applied to the
 * drawn header.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	actualOf,
	expectedOf,
	type HeaderFeature,
	headerFeatures,
	headerSpace
} from "#test/normalize/header-object.fixtures.ts"

/**
 * A header's marks read as the specification types them, through any chain of references. Its budget replaces the
 * four example readings of the suite it converts (bare, numeric, stringy, referenced), twice over.
 */
export const headerMarksRead = property.explore(headerSpace, {
	needs: {},
	situations: [
		"inline header",
		"header behind one reference",
		"header behind a chain of references",
		"a mark that is no boolean",
		"an absent mark",
		"a true mark behind a reference"
	] satisfies ReadonlyArray<Reached<HeaderFeature>>,
	check: (_, c: Case<HeaderFeature>) => (sketch) =>
		Effect.gen(function* () {
			c.noteAll(headerFeatures(sketch))
			const actual = yield* actualOf(sketch)
			assert.deepEqual(actual, expectedOf(sketch))
		}),
	oracle: {
		kind: "specification",
		name: "the Header Object's boolean marks, read at the end of the use site's references"
	},
	kept: [],
	budget: { runs: 8, steered: 64 },
	kills: [
		{
			file: "packages/generator/src/resolve/index.ts",
			original: "sites.push({ base, kind: item.kind, member, node, pointer, ref })",
			replacement: "{}",
			why: "Reference sites are never recorded, so a header behind a `$ref` reads as unmarked; the property fails (CATCH's evidence, mutant 1e272f42af)."
		}
	]
})
