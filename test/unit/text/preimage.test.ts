/**
 * XML Schema's whiteSpace facets read backwards over the regex IR (packages/text/src/regex/preimage.ts), over drawn
 * languages of whole texts, nodes of no assertion built from sets of an alphabet with the space and the breaks, and
 * drawn texts over that alphabet:
 *
 * - replacePreimage holds exactly the texts whose `replace`d form the language holds;
 * - collapsePreimage holds exactly the texts whose `collapse`d form the language holds, or is refused where merging two
 *   spaces may leave the language, a refusal its proof never gives where every two spaces a word holds merge;
 * - tokenOf holds exactly the language's nonempty texts of no whitespace.
 *
 * Oracle: ECMAScript's RegExp test (test/support/regex.ts jsMatcher) of the language and of each pre-image printed in grizzle's
 * grammar (print.ts printSource), against grizzle-text's own `replaced` and `collapsed` of each text, XML Schema's
 * definitions by code points.
 *
 * Features: a text held and refused by each pre-image; a collapse refused; a language whose words begin or end with a
 * space and one whose words hold two together.
 */

import { end, type RegexNode, seq, start } from "@bjornpagen/grizzle-text/regex/ir"
import { collapsePreimage, replacePreimage, tokenOf } from "@bjornpagen/grizzle-text/regex/preimage"
import { printSource } from "@bjornpagen/grizzle-text/regex/print"
import {
	codePoints,
	codePointsText,
	collapsed,
	replaced,
	xmlWhitespace
} from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter } from "effect"
import { jsMatcher } from "#test/support/regex.ts"
import { stringsOver, wholeLanguageGen, wordOf } from "#test/support/unit/text/generators.ts"

type PreimageFeature =
	| "replace held"
	| "replace refused"
	| "collapse held"
	| "collapse refused"
	| "collapse unmerged"
	| "a run of whitespace read as one space"
	| "token held"
	| "token refused"

/** The alphabet a case draws its sets and texts from: two letters, the space and the three breaks. */
const alphabet: Arr.NonEmptyReadonlyArray<number> = [0x61, 0x62, 0x20, 0x09, 0x0a, 0x0d]

interface PreimageCase {
	readonly node: RegexNode
	readonly texts: ReadonlyArray<string>
}

/** A text with each of its spaces written as a run of one to four whitespace code points, as a value may be written. */
const spacesWritten =
	(text: string): Gen<string> =>
	(source) =>
		codePointsText(
			Arr.flatMap(codePoints(text), (cp) =>
				cp === 0x20
					? source.draw(array(element([0x20, 0x09, 0x0a, 0x0d]), { min: 1, max: 4 }))
					: [cp]
			)
		)

const preimageCaseGen: Gen<PreimageCase> = (source) => {
	const node = source.draw(wholeLanguageGen(alphabet, 3))
	const texts = source.draw(array(stringsOver(element(alphabet), 6), { min: 6, max: 16 }))
	const members = source.draw(array(wordOf(node), { min: 4, max: 8 }))
	return {
		node,
		texts: [
			...texts,
			...Arr.map(members, (member) => source.draw(spacesWritten(codePointsText(member))))
		]
	}
}

/** A run of two or more whitespace code points between two that are not whitespace. */
const innerRun = regex("\\S[\\t\\n\\r ]{2,}\\S", "u")

/** Whether a node holds a whole text, by ECMAScript's test of `^(?:node)$` printed in grizzle's grammar. */
const holds = (node: RegexNode): ((text: string) => boolean) => {
	const whole = seq([start, node, end])
	return whole.kind === "never"
		? () => false
		: jsMatcher(
				printSource(whole, (s) => s),
				"u"
			)
}

/** Each pre-image of a language of whole texts holds exactly the texts its facet's definition sends into the language. */
export const theWhiteSpacePreimagesOfALanguageHoldExactlyTheTextsTheirFacetSendsIntoIt =
	property.explore(preimageCaseGen, {
		needs: {},
		situations: [
			"replace held",
			"replace refused",
			"collapse held",
			"collapse refused",
			"collapse unmerged",
			"a run of whitespace read as one space",
			"token held",
			"token refused"
		] satisfies ReadonlyArray<Reached<PreimageFeature>>,
		check: (_, c: Case<PreimageFeature>) => (k) =>
			Effect.sync(() => {
				const language = holds(k.node)
				const ofReplace = holds(replacePreimage(k.node))
				const ofToken = holds(tokenOf(k.node))
				const collapse = collapsePreimage(k.node)
				if (!collapse.ok) {
					assert.equal(
						collapse.error.kind,
						"unmerged",
						"a node of no assertion is refused only unmerged"
					)
					c.note("collapse unmerged")
				}
				const ofCollapse = collapse.ok ? holds(collapse.value) : undefined
				const wholeNode = seq([start, k.node, end])
				const written =
					wholeNode.kind === "never" ? "the empty language" : printSource(wholeNode, (s) => s)
				for (const text of k.texts) {
					const shown = `${Formatter.format(written)} over ${Formatter.format(text)}`
					const replacedHeld = language(replaced(text))
					assert.equal(ofReplace(text), replacedHeld, `${shown}: replacePreimage`)
					c.note(replacedHeld ? "replace held" : "replace refused")
					const tokenHeld =
						language(text) &&
						text.length > 0 &&
						Arr.every(codePoints(text), (cp) => !xmlWhitespace.has(cp))
					assert.equal(ofToken(text), tokenHeld, `${shown}: tokenOf`)
					c.note(tokenHeld ? "token held" : "token refused")
					if (ofCollapse === undefined) {
						continue
					}
					const collapsedHeld = language(collapsed(text))
					assert.equal(ofCollapse(text), collapsedHeld, `${shown}: collapsePreimage`)
					c.note(collapsedHeld ? "collapse held" : "collapse refused")
					if (collapsedHeld && innerRun.test(text)) {
						c.note("a run of whitespace read as one space")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "ECMAScript's RegExp test of the language and of each pre-image, against grizzle-text's replaced and collapsed of each text"
		},
		budget: { runs: 600, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/preimage.ts",
				original:
					"\t\tset(has(s, space) ? union([s, breaks]) : intersection(s, complement(breaks)))",
				replacement: "\t\tset(union([s, breaks]))",
				why: "replace's pre-image lets a break stand where the language holds no space, so a text whose replaced form the language refuses is held."
			},
			{
				file: "packages/text/src/regex/preimage.ts",
				original:
					"\tconst bare = mapSets(node, (s) => set(intersection(s, complement(whitespace))))",
				replacement: "\tconst bare = mapSets(node, (s) => set(s))",
				why: "A list item's tokens keep whitespace, so a word that holds a space is a token."
			},
			{
				file: "packages/text/src/regex/preimage.ts",
				original: "\tfrom.space &&\n\tto.space &&",
				replacement: "\tfalse &&\n\tto.space &&",
				why: "mergeSafe proves every two spaces merge, so a language whose words hold two spaces that do not merge gets a pre-image that holds texts its collapse leaves outside the language."
			},
			{
				file: "packages/text/src/regex/preimage.ts",
				original: "\tconst core = builder.firstIn(lastIn(runs, solid), solid)",
				replacement: "\tconst core = runs",
				why: "collapse's pre-image keeps a core that begins or ends with whitespace, which no collapsed text holds at an edge, so a text the collapse trims out of the language is held."
			}
		]
	})
