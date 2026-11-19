/**
 * XML's names and whitespace as grizzle-text reads them for an application (packages/text/src/regex/xml.ts isNcName,
 * packages/text/src/text.ts trimmed), over drawn texts of name characters, colons, whitespace and characters XML 1.0
 * Second Edition leaves out of its names:
 *
 * - isNcName holds exactly the texts XML Schema's own `[\i-[:]][\c-[:]]*` holds whole;
 * - trimmed is the text without the XML whitespace at either end, its inner whitespace kept.
 *
 * Oracle: grizzle's XSD reader (regex/xsd.ts xsdPattern) of the NCName production and its matcher, and ECMAScript's
 * replacement of the outer whitespace runs.
 *
 * Features: an NCName, a text of no NCName, a colon refused, a text trimmed at an end, and one with inner whitespace kept.
 */

import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { isNcName } from "@bjornpagen/grizzle-text/regex/xml"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import { trimmed } from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { stringsOver } from "#test/unit/text/generators.ts"

type NamesFeature =
	| "an NCName"
	| "no NCName"
	| "a colon refused"
	| "trimmed at an end"
	| "inner whitespace kept"

/**
 * The characters a case's texts are drawn from: letters and digits, the name punctuation, a colon, XML whitespace, a
 * letter the Second Edition leaves out (U+0132), one Unicode assigned after it (U+3400), digits, extenders and a
 * combining character that may not start a name (U+0660, U+02D0, U+00B7, U+3005, U+0300), an ideograph (U+4E00), and
 * a supplementary character.
 */
const characters: Arr.NonEmptyReadonlyArray<number> = [
	0x61, 0x5a, 0x30, 0x5f, 0x2d, 0x2e, 0x3a, 0x20, 0x09, 0x0a, 0x0132, 0x3400, 0x0660, 0x02d0, 0xb7,
	0x3005, 0x0300, 0x4e00, 0x10000, 0xe9
]

const textsGen: Gen<ReadonlyArray<string>> = array(stringsOver(element(characters), 6), {
	min: 6,
	max: 14
})

/** XML Schema's NCName production, read whole by grizzle's XSD reader and matched by its matcher. */
const ncNameMatcher = ((): Matcher => {
	const read = xsdPattern("[\\i-[:]][\\c-[:]]*")
	if (!read.ok) {
		throw new Error(`grizzle's XSD reader reads the NCName production: ${read.error.message}`)
	}
	return Matcher.of(buildNfa(read.value))
})()

/** XML whitespace anywhere in a text. */
const innerWhitespace = regex("[\\t\\n\\r ]", "u")

/** XML whitespace at a text's start or its end. */
const outerWhitespace = regex("^[\\t\\n\\r ]+|[\\t\\n\\r ]+$", "gu")

/** The outer whitespace runs of a text removed, as ECMAScript replaces them. */
const trimmedByHost = (text: string): string => Str.replace(outerWhitespace, "")(text)

/** XML's names and outer whitespace read as their productions state them. */
export const anNCNameAndATrimmedTextAreExactlyWhatXMLSchemasProductionsState = property.explore(
	textsGen,
	{
		needs: {},
		situations: [
			"an NCName",
			"no NCName",
			"a colon refused",
			"trimmed at an end",
			"inner whitespace kept"
		] satisfies ReadonlyArray<Reached<NamesFeature>>,
		check: (_, c: Case<NamesFeature>) => (texts) =>
			Effect.sync(() => {
				for (const text of [...texts, ...Arr.map(texts, (t) => `:${t}`)]) {
					const named = ncNameMatcher.matches(text)
					assert.equal(isNcName(text), named, `${Formatter.format(text)}: isNcName`)
					c.note(named ? "an NCName" : "no NCName")
					if (
						!named &&
						Str.includes(":")(text) &&
						ncNameMatcher.matches(Str.replaceAll(":", "a")(text))
					) {
						c.note("a colon refused")
					}
					const trim = trimmed(text)
					assert.equal(trim, trimmedByHost(text), `${Formatter.format(text)}: trimmed`)
					if (trim !== text) {
						c.note("trimmed at an end")
					}
					if (innerWhitespace.test(trim)) {
						c.note("inner whitespace kept")
					}
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "grizzle's XSD reader of the NCName production matched whole, and ECMAScript's replacement of the outer whitespace runs"
		},
		budget: { runs: 300, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/xml.ts",
				original: "const ncNameStart: CharSet = intersection(nameStart, complement(colon))",
				replacement: "const ncNameStart: CharSet = nameStart",
				why: "An NCName may begin with a colon: a qualified name's colon at its start is read as a name."
			},
			{
				file: "packages/text/src/text.ts",
				original: "\twhile (end > start && xmlWhitespace.has(text.charCodeAt(end - 1))) {",
				replacement: "\twhile (false) {",
				why: "trimmed keeps the whitespace at a text's end."
			}
		]
	}
)
