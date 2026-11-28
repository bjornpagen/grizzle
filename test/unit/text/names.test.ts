/**
 * XML's names and whitespace as grizzle-text reads them for an application (packages/text/src/regex/xml.ts isNcName,
 * packages/text/src/text.ts trimmed, replaced, collapsed and tokens), over drawn texts of name characters, colons,
 * whitespace and characters XML 1.0 Second Edition leaves out of its names:
 *
 * - isNcName holds exactly the texts XML Schema's own `[\i-[:]][\c-[:]]*` holds whole;
 * - trimmed is the text without the XML whitespace at either end, its inner whitespace kept;
 * - replaced and collapsed, XML Schema's whiteSpace facets, are exactly the code-point walk's they replace, over texts
 *   with lone surrogates and supplementary characters, and tokens is the text split at its whitespace runs, none
 *   empty; none decodes or builds a code point (text.ts codePointAt, codePointsText): collapsed reads a unit once and
 *   the unit after each inner run twice, tokens each unit once, and replace reads no unit in JavaScript, the engine's
 *   search finding each character of its map once and once more after each place it replaces (text.ts nextOf).
 *
 * Oracle: grizzle's XSD reader (regex/xsd.ts xsdPattern) of the NCName production and its matcher; ECMAScript's
 * replacement of the outer whitespace runs; the code-point walk of each facet (translate's map, and each run between
 * two characters one space); ECMAScript's split at the whitespace runs. The count is work, never time: V8's precise
 * coverage counts each function's calls (kernel/calls.ts callCounts).
 *
 * Features: an NCName, a text of no NCName, a colon refused, a text trimmed at an end, one with inner whitespace kept;
 * a run collapsed, a text no facet changes, a surrogate kept, a blank text and a list of tokens.
 */

import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { isNcName } from "@bjornpagen/grizzle-text/regex/xml"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import {
	codePoints,
	codePointsText,
	collapsed,
	replaced,
	replaceMap,
	tokens,
	translated,
	trimmed,
	xmlWhitespace
} from "@bjornpagen/grizzle-text/text"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import { callCounts } from "#test/support/kernel/calls.ts"
import { stringsOver } from "#test/support/unit/text/generators.ts"

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

/**
 * The characters a whitespace case's texts are drawn from, XML's four white space characters half the time, so runs of
 * several form: a letter, a digit, white space XML does not count (U+00A0, U+3000, U+FEFF), a supplementary character,
 * and a lone high and a lone low surrogate, which may also meet as a pair.
 */
const spaced: Gen<number> = weighted([
	[1, element([0x61, 0x37, 0xa0, 0x3000, 0xfeff, 0x1f600, 0xd83d, 0xde00])],
	[1, element([0x20, 0x09, 0x0a, 0x0d])]
])

const spacedGen: Gen<ReadonlyArray<string>> = array(stringsOver(spaced, 12), {
	min: 6,
	max: 14
})

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

type WhitespaceFeature =
	| "a run collapsed"
	| "a text no facet changes"
	| "a surrogate kept"
	| "a blank text"
	| "a list of tokens"

/** The code-point walk replaced, as grizzle-text read it before it read by code unit: translate's map. */
const walkedReplace = (text: string): string => translated(text, replaceMap.from, replaceMap.to)

/** The code-point walk collapsed: each run of white space between two other characters one space, none at an end. */
const walkedCollapse = (text: string): string => {
	const out: Array<number> = []
	let spacedOut = false
	for (const c of codePoints(text)) {
		if (xmlWhitespace.has(c)) {
			spacedOut = out.length > 0
		} else {
			if (spacedOut) {
				out.push(0x20)
			}
			spacedOut = false
			out.push(c)
		}
	}
	return codePointsText(out)
}

/** A run of XML whitespace, at which ECMAScript splits a whitespace-separated list. */
const whitespaceRuns = regex("[\\t\\n\\r ]+", "u")

/** A surrogate code unit, lone or of a pair. */
const surrogate = regex("[\\ud800-\\udfff]", "")

/** The functions whose calls are the facets' work: a code point decoded or built, and a code unit read. */
const facetSites = Object.freeze({
	decoded: { file: "packages/text/src/text.ts", name: "codePointAt" },
	built: { file: "packages/text/src/text.ts", name: "codePointsText" },
	read: { file: "packages/text/src/text.ts", name: "isWhitespaceUnit" },
	searched: { file: "packages/text/src/text.ts", name: "nextOf" }
})

/** The tabs, line feeds and carriage returns of a text: the places replace changes. */
const replacedPlaces = (text: string): number =>
	Arr.filter(codePoints(text), (c) => c === 0x09 || c === 0x0a || c === 0x0d).length

/** The runs of white space inside a trimmed text, each between two other characters. */
const innerRuns = (text: string): number => Str.split(trimmed(text), whitespaceRuns).length - 1

/**
 * XML Schema's whiteSpace facets and a list's tokens are the code-point walk's and ECMAScript's split's, and read a
 * text by code unit: no code point decoded or built, collapsed reading its trimmed text's units and one more each inner
 * run, tokens its text's units.
 */
export const whitespaceFacetsAndTokensAreTheCodePointWalksAndReadATextByCodeUnitDecodingNoCodePoint =
	property.explore(spacedGen, {
		needs: {},
		situations: [
			"a run collapsed",
			"a text no facet changes",
			"a surrogate kept",
			"a blank text",
			"a list of tokens"
		] satisfies ReadonlyArray<Reached<WhitespaceFeature>>,
		check: (_, c: Case<WhitespaceFeature>) => (texts) =>
			Effect.gen(function* () {
				const [[collapses, replaces], facetCounts] = yield* callCounts(
					Effect.sync(() => [Arr.map(texts, collapsed), Arr.map(texts, replaced)] as const),
					facetSites
				)
				const [splits, tokenCounts] = yield* callCounts(
					Effect.sync(() => Arr.map(texts, tokens)),
					facetSites
				)
				const label = Formatter.format(texts)
				for (const counts of [facetCounts, tokenCounts]) {
					assert.equal(counts.decoded, 0, `${label}: no code point decoded`)
					assert.equal(counts.built, 0, `${label}: no code point built`)
				}
				assert.equal(
					facetCounts.read,
					Arr.reduce(texts, 0, (n, text) => n + trimmed(text).length + innerRuns(text)),
					`${label}: collapsed reads each unit once and the unit after each inner run twice`
				)
				assert.equal(
					tokenCounts.read,
					Arr.reduce(texts, 0, (n, text) => n + text.length),
					`${label}: tokens reads each unit once`
				)
				assert.equal(
					facetCounts.searched,
					Arr.reduce(texts, 0, (n, text) => n + replaceMap.from.length + replacedPlaces(text)),
					`${label}: replace searches each character of its map once, and once more after each place it replaces`
				)
				assert.equal(tokenCounts.searched, 0, `${label}: tokens searches nothing`)
				for (const [i, text] of texts.entries()) {
					const each = Formatter.format(text)
					const collapse = Arr.getUnsafe(collapses, i)
					const replace = Arr.getUnsafe(replaces, i)
					const split = Arr.getUnsafe(splits, i)
					assert.equal(collapse, walkedCollapse(text), `${each}: collapsed`)
					assert.equal(replace, walkedReplace(text), `${each}: replaced`)
					assert.deepEqual(
						split,
						Arr.filter(Str.split(text, whitespaceRuns), (token) => token !== ""),
						`${each}: tokens`
					)
					const unchanged = collapse === trimmed(text) && replace === text
					c.note(unchanged ? "a text no facet changes" : "a run collapsed")
					if (surrogate.test(collapse)) {
						c.note("a surrogate kept")
					}
					c.note(split.length === 0 ? "a blank text" : "a list of tokens")
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "the code-point walk of each facet, translate's map and one space a run between two characters, and ECMAScript's split at the whitespace runs"
		},
		budget: { runs: 150, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/text/src/text.ts",
				original:
					"export const collapsed = (text: string): string => {\n\tconst inner = trimmed(text)\n",
				replacement:
					"export const collapsed = (text: string): string => {\n\tconst out: Array<number> = []\n\tlet spaced = false\n\tfor (const c of codePoints(text)) {\n\t\tif (xmlWhitespace.has(c)) {\n\t\t\tspaced = out.length > 0\n\t\t\tcontinue\n\t\t}\n\t\tif (spaced) {\n\t\t\tout.push(0x20)\n\t\t\tspaced = false\n\t\t}\n\t\tout.push(c)\n\t}\n\treturn codePointsText(out)\n}\n\nexport const collapsedByUnit = (text: string): string => {\n\tconst inner = trimmed(text)\n",
				why: "collapsed is the code-point walk again, decoding each code point and building its answer a code point at a time: its decodes and builds are past 0."
			},
			{
				file: "packages/text/src/text.ts",
				original: "export const replaced = (text: string): string => {\n",
				replacement:
					"export const replaced = (text: string): string => translated(text, replaceMap.from, replaceMap.to)\n\nexport const replacedByUnit = (text: string): string => {\n",
				why: "replaced is translate's walk over its map again, decoding every code point of the text: its decodes are past 0."
			},
			{
				file: "packages/text/src/text.ts",
				original: "export const replaced = (text: string): string => {\n\tconst cursors",
				replacement:
					'export const replaced = (text: string): string => {\n\tlet out = ""\n\tlet from = 0\n\tfor (let i = 0; i < text.length; i++) {\n\t\tif (replaceMap.from.includes(text.charAt(i))) {\n\t\t\tout += text.slice(from, i) + " "\n\t\t\tfrom = i + 1\n\t\t}\n\t}\n\treturn out + text.slice(from)\n}\n\nexport const replacedBySearch = (text: string): string => {\n\tconst cursors',
				why: "replaced reads every unit of the text in JavaScript again, the stretches between two replaced characters among them, where the engine's search skips them: it searches nothing."
			},
			{
				file: "packages/text/src/text.ts",
				original: "\t\t\tif (i > from) {\n\t\t\t\tout.push(text.slice(from, i))\n",
				replacement: "\t\t\tif (i >= from) {\n\t\t\t\tout.push(text.slice(from, i))\n",
				why: "tokens keeps the empty text between two white space characters as a token."
			},
			{
				file: "packages/text/src/text.ts",
				original: "\t\ti = end - 1\n",
				replacement: "",
				why: "collapsed reads a run's units again after it, each starting a run of its own: its reads pass one a unit and one more an inner run, and a run of two or more is written as more than one space."
			}
		]
	})
