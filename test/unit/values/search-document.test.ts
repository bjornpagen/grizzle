/**
 * A stored search document's host boundary (scalar/values/tsvector.ts parseSearchDocument, through the codec's door,
 * values/identity.ts parseValue): pg.tsvector's values are the text tsvectorout prints, admitted exactly as they are.
 *
 * - Its one form: over drawn documents, raw ones of repeated and disordered lexemes, repeated, disordered and too great
 *   positions and labels of either case, and ones already in their one form, a document's text is admitted exactly
 *   where it is the text tsvectorin stores it as, and is admitted as itself; every other text is refused as
 *   searchDocumentForm, never sent to be stored as another document than it spells; and one tsvectorin refuses for its
 *   size, a lexeme past searchLexemeMaxBytes or the whole past textSearchStringMaxBytes, is refused as
 *   searchDocumentSize. Oracle: a model of tsvectorin and tsvectorout, the lexemes merged and sorted by their bytes and
 *   each one's positions cut, sorted, merged to their greatest weight and kept to the most, printed as tsvectorout
 *   prints them (search-document.fixtures.ts stored, printed), apart from the parser's single scan.
 * - Corruption: each corruption of a text in its one form no text tsvectorout prints survives is refused as
 *   searchDocumentForm. Oracle: tsvectorout's grammar's complement, each corruption a named case.
 *
 * Features: the empty document, a document in and out of its one form, each repeat and limit at and past it, a lexeme of
 * a quote and a backslash, and each corruption.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { parseValue } from "#compiler/scalar/values/identity.ts"
import { faulted, succeeded } from "#test/support/assert.ts"
import {
	type CorruptionFeature,
	corruptionSpace,
	type DocumentFeature,
	documentFeatures,
	documentSpace,
	oversized,
	printed,
	rawText,
	stored
} from "#test/support/unit/values/search-document.fixtures.ts"

/** A search document's text is admitted exactly where it is tsvectorin's one form of it, as itself, and refused as out of its form or past its size otherwise. */
export const aSearchDocumentsTextIsAdmittedExactlyWhereItIsTsvectorinsOneFormOfItAsItselfAndRefusedAsOutOfItsFormOrPastItsSizeOtherwise =
	property.explore(documentSpace, {
		needs: {},
		budget: { runs: 600, steered: 200 },
		situations: [
			"the empty document",
			"a document in its one form admitted",
			"a document out of its one form refused",
			"a repeated lexeme refused",
			"a repeated position refused",
			"a position past the greatest refused",
			"a lexeme of a quote and a backslash",
			"a lexeme of the most positions admitted",
			"a lexeme past the most positions refused",
			"a lexeme past its bytes refused",
			"a document at its bytes admitted",
			"a document past its bytes refused"
		] satisfies ReadonlyArray<Reached<DocumentFeature>>,
		check: (_, c: Case<DocumentFeature>) => (d) =>
			Effect.sync(() => {
				const text = rawText(d)
				const one = printed(stored(d))
				c.noteAll(documentFeatures(d, text, one))
				const admitted = parseValue({ carrier: "tsvector" }, text)
				if (oversized(stored(d))) {
					if (text === one) {
						faulted(admitted, "searchDocumentSize")
					} else {
						assert.ok(
							!admitted.ok,
							"a text past tsvectorin's size, out of its one form, is refused"
						)
					}
				} else if (text === one) {
					assert.equal(
						succeeded(admitted),
						text,
						"a document in its one form is admitted as itself"
					)
				} else {
					faulted(admitted, "searchDocumentForm")
					assert.equal(
						succeeded(parseValue({ carrier: "tsvector" }, one)),
						one,
						"the one form of a refused text is admitted"
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "a model of tsvectorin's one form of a document and tsvectorout's print of it"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/tsvector.ts",
				original:
					"\t\t\t(previous !== undefined && compareCodePoints(previous, quoted.lexeme) >= 0)",
				replacement:
					"\t\t\t(previous !== undefined && compareCodePoints(previous, quoted.lexeme) > 0)",
				why: "A repeated lexeme is admitted, which tsvectorin merges into one: a text stored as another document than it spells."
			},
			{
				file: "packages/engine/src/scalar/values/tsvector.ts",
				original: "\t\tif (position <= last || position > searchPositionMax) {",
				replacement: "\t\tif (position < last || position > searchPositionMax) {",
				why: "A repeated position is admitted, which tsvectorin merges into one."
			},
			{
				file: "packages/engine/src/scalar/values/tsvector.ts",
				original: "\t\t\treturn count > searchPositionsMax",
				replacement: "\t\t\treturn count >= searchPositionsMax",
				why: "A lexeme of the most positions tsvectorin keeps is refused."
			},
			{
				file: "packages/engine/src/scalar/values/identity.ts",
				original: "\ttsvector: (value) => parseSearchDocument(value),",
				replacement: "\ttsvector: (value) => validateText(value),",
				why: "The codec's door admits any text as a document, sending one tsvectorin stores as another."
			}
		]
	})

/** Every corruption of a search document's text in its one form is refused as out of its form. */
export const everyCorruptionOfASearchDocumentsTextInItsOneFormIsRefusedAsOutOfItsForm =
	property.exhaust(finite(corruptionSpace), {
		box: "each corruption of a text in tsvectorout's form",
		needs: {},
		situations: [
			"an unquoted lexeme",
			"an empty lexeme",
			"a lone backslash",
			"an unterminated quote",
			"a lowercase weight",
			"a weight D written",
			"a position of a leading zero",
			"a position of zero",
			"two spaces between lexemes",
			"a trailing space",
			"an empty position list"
		] satisfies ReadonlyArray<Reached<CorruptionFeature>>,
		check:
			(_, c: Case<CorruptionFeature>) =>
			({ name, text }) =>
				Effect.sync(() => {
					c.note(name)
					faulted(parseValue({ carrier: "tsvector" }, text), "searchDocumentForm")
				}),
		oracle: {
			kind: "specification",
			name: "tsvectorout's grammar: each corruption a text it never prints"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/tsvector.ts",
				original: "\t\tif (at === start || text.charCodeAt(start) === zero) {",
				replacement: "\t\tif (at === start) {",
				why: "A position of a leading zero, or zero itself, is admitted, which tsvectorout never prints."
			}
		]
	})
