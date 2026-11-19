/**
 * The front end of XML Schema 1.0's regular expressions (packages/engine/src/scalar/regex/xsd.ts xsdPattern), read into
 * the regex IR every dialect shares.
 *
 * - Languages: over drawn patterns of every construct Appendix F defines (normal characters, `^` and `$` among them,
 *   and characters outside XML's Char; single- and multi-character escapes; category and block escapes, positive and
 *   negative; the wildcard; character classes, negative and with a subtraction; groups nested two deep; every
 *   quantifier), the reader's language, matched by the IR's automaton (match.ts Matcher), holds exactly the drawn
 *   words the pattern's meaning holds. Oracle: a second implementation, each construct's meaning spelled from Appendix
 *   F's definitions as an ECMAScript expression under the `v` flag, anchored at both ends and over XML's Char.
 * - Names: `\i` and `\c` are XML 1.0 Second Edition's initial name characters and name characters, 34,516 and 35,122
 *   code points (the counts its Appendix B's tables give, as xmllint reads an xs:NCName), and not the Fifth Edition's:
 *   U+0132 is no name character of the Second Edition. Oracle: the specification's counts and its letters.
 * - Refusals: each construct outside the grammar is refused at its offset, by its reason. Oracle: the specification.
 *
 * Features: a class subtraction, a negative group, a category escape, a block escape, the wildcard, a nested group, a
 * word the pattern holds, a character outside XML's Char.
 */

import { categoryRuns as committedRuns } from "@bjornpagen/grizzle-text/regex/categories.generated"
import { has, size } from "@bjornpagen/grizzle-text/regex/charset"
import { Matcher } from "@bjornpagen/grizzle-text/regex/match"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { nameChar, nameStart } from "@bjornpagen/grizzle-text/regex/xml"
import { xsdPattern } from "@bjornpagen/grizzle-text/regex/xsd"
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import { Compute } from "#compiler/public/compute.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledPattern } from "#test/support/regex.ts"
import {
	type CategoryFeature,
	codePointGen,
	committedCategory,
	type EscapeFeature,
	escapeGen,
	generatedRuns,
	initialName,
	type NameFeature,
	nameCharacter,
	patternGen,
	pool,
	type RefusalFeature,
	refusedGen,
	wordsGen,
	type XsdFeature
} from "#test/unit/text/xsd.fixtures.ts"

/** The reader's language holds exactly the words each drawn pattern's meaning holds, by Appendix F's definitions. */
export const xsdPatternReadsEveryDrawnPatternAsAppendixFDefinesItsLanguage = property.explore(
	(source) => ({ pattern: source.draw(patternGen), words: source.draw(wordsGen) }),
	{
		needs: {},
		situations: [
			"a class subtraction",
			"a negative group",
			"a category escape",
			"a block escape",
			"the wildcard",
			"a nested group",
			"a word the pattern holds",
			"a character outside XML's Char"
		] satisfies ReadonlyArray<Reached<XsdFeature>>,
		check:
			(_, c: Case<XsdFeature>) =>
			({ pattern, words }) =>
				Effect.sync(() => {
					const notes: ReadonlyArray<readonly [XsdFeature, boolean]> = [
						["a class subtraction", Str.includes("-[")(pattern.xsd)],
						["a negative group", Str.includes("[^")(pattern.xsd)],
						[
							"a category escape",
							Str.includes("\\p{L")(pattern.xsd) ||
								Str.includes("\\p{N")(pattern.xsd) ||
								Str.includes("\\p{C")(pattern.xsd) ||
								Str.includes("\\p{Z")(pattern.xsd) ||
								Str.includes("\\P{L")(pattern.xsd)
						],
						["a block escape", Str.includes("{Is")(pattern.xsd)],
						["the wildcard", Str.includes(".")(pattern.xsd)],
						[
							"a nested group",
							Str.includes("((")(pattern.xsd) ||
								(Str.includes("(\\")(pattern.xsd) && Str.includes("))")(pattern.xsd))
						]
					]
					for (const [feature, holds] of notes) {
						if (holds) {
							c.note(feature)
						}
					}
					const node = succeeded(xsdPattern(pattern.xsd), pattern.xsd)
					const matcher = Matcher.of(buildNfa(node))
					const printed =
						node.kind === "never"
							? undefined
							: Matcher.of(
									buildNfa(
										succeeded(
											parsePattern(Compute.xsdPattern(pattern.xsd).source, "u"),
											"the printed source"
										)
									)
								)
					const oracle = compiledPattern(pattern.oracle, "v")
					for (const word of words) {
						const expected = oracle.test(word)
						if (expected) {
							c.note("a word the pattern holds")
						}
						if (Str.includes("\u0001")(word) || Str.includes("\uFFFE")(word)) {
							c.note("a character outside XML's Char")
						}
						if (printed !== undefined) {
							assert.equal(
								printed.matches(word),
								expected,
								`Compute.xsdPattern(${Formatter.format(pattern.xsd)}) over ${Formatter.format(word)}`
							)
						}
						assert.equal(
							matcher.matches(word),
							expected,
							`${Formatter.format(pattern.xsd)} over ${Formatter.format(word)} (oracle ${pattern.oracle})`
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "each construct's meaning by Appendix F's definitions, an ECMAScript `v`-flag expression over XML's Char"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: "\tconst admission = admitMatch(printSource(read.value, (set) => set))",
				replacement: "\tconst admission = admitMatch(source)",
				why: "Compute.xsdPattern hands the facet to grizzle's grammar as it is written, unanchored and with XML Schema's escapes unread; the printed pattern's language parts from the facet's."
			},
			{
				file: "packages/text/src/regex/xsd.ts",
				original: "\t\treturn Ir.seq([Ir.start, this.#closed(pattern), Ir.end])",
				replacement: "\t\treturn this.#closed(pattern)",
				why: "A pattern matches anywhere in a word, as an ECMAScript expression does, not the whole word Appendix F anchors; a word with more than the pattern holds is admitted."
			},
			{
				file: "packages/text/src/regex/xsd.ts",
				original: "const wildcard: CharSet = xmlComplement(\n\tcharSet([",
				replacement: "const wildcard: CharSet = complement(\n\tcharSet([",
				why: "The wildcard ranges over every code point, not XML's Char; a character outside it matches `.`."
			},
			{
				file: "packages/text/src/regex/xsd.ts",
				original: "\t\t\t\t\tset = intersection(this.#groupSet(of), complement(set))",
				replacement: "\t\t\t\t\tset = this.#groupSet(of)",
				why: "A subtraction leaves its class whole; a word of the subtracted characters is admitted."
			}
		]
	}
)

/**
 * `\i` and `\c` are XML 1.0 Second Edition's name characters, which an xs:NCName takes, not the Fifth Edition's: over
 * drawn code points, the reader's `\i` and `\c` hold exactly the tables' members, whose counts are the Second Edition's
 * (34,516 and 35,122), and U+0132, a Fifth Edition name start alone, is outside both.
 */
export const xsdNameEscapesAreXML10SecondEditionsNameCharactersAndNotTheFifthEditions =
	property.explore(codePointGen, {
		needs: {},
		situations: [
			"a name start",
			"a name character alone",
			"no name character"
		] satisfies ReadonlyArray<Reached<NameFeature>>,
		check: (_, c: Case<NameFeature>) => (point) =>
			Effect.sync(() => {
				const text = String.fromCodePoint(point)
				const start = has(nameStart, point)
				const name = has(nameChar, point)
				c.note(start ? "a name start" : name ? "a name character alone" : "no name character")
				assert.equal(initialName.matches(text), start, `\\i over U+${point.toString(16)}`)
				assert.equal(nameCharacter.matches(text), name, `\\c over U+${point.toString(16)}`)
				assert.equal(size(nameStart), 34_516, "\\i: Letter, '_' and ':', XML 1.0 Second Edition's")
				assert.equal(size(nameChar), 35_122, "\\c: NameChar, XML 1.0 Second Edition's")
				assert.ok(!has(nameChar, 0x132), "U+0132 is a Fifth Edition name character alone")
			}),
		oracle: {
			kind: "specification",
			name: "XML 1.0 Second Edition's Appendix B: its letters' and name characters' counts, and U+0132 outside them"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/xml.ts",
				original: "export const nameStart: CharSet = union([\n\tbaseChar,\n\tideographic,\n",
				replacement: "export const nameStart: CharSet = union([\n\tbaseChar,\n",
				why: "`\\i` loses the ideographs; its count falls short of the Second Edition's."
			}
		]
	})

/** Each construct outside Appendix F's grammar, after a prefix of letters, is refused at its offset, by its reason. */
export const xsdPatternRefusesEachConstructOutsideTheGrammarAtItsOffsetByItsReason =
	property.explore(refusedGen, {
		needs: {},
		situations: [
			"a malformed construct",
			"a construct outside the grammar"
		] satisfies ReadonlyArray<Reached<RefusalFeature>>,
		check: (_, c: Case<RefusalFeature>) => (refused) =>
			Effect.sync(() => {
				c.note(
					refused.reason === "MalformedDescription"
						? "a malformed construct"
						: "a construct outside the grammar"
				)
				const read = xsdPattern(refused.source)
				assert.ok(!read.ok, `${refused.source} is refused`)
				assert.equal(read.error.offset, refused.offset, `${refused.source}: offset`)
				assert.equal(read.error.reason, refused.reason, `${refused.source}: reason`)
			}),
		oracle: {
			kind: "specification",
			name: "Appendix F's grammar, and PostgreSQL's RE_DUP_MAX of 255"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/xsd.ts",
				original: '\t\t\t\tif (this.#is("?", 1)) {',
				replacement: "\t\t\t\tif (this.#pos < 0) {",
				why: "A `(?` group is read as a group whose first atom is a quantifier, refused as malformed after it, not where the construct begins as one XML Schema does not have."
			},
			{
				file: "packages/text/src/regex/xsd.ts",
				original:
					'\t\tif (min > regexMaxRepeat || (max !== "unbounded" && max > regexMaxRepeat)) {',
				replacement: "\t\tif (min < 0) {",
				why: "A count past PostgreSQL's RE_DUP_MAX is admitted, which the ARE printed from it refuses."
			}
		]
	})

/**
 * Every class escape, a multi-character, category or block escape, positive or negative, holds exactly the characters
 * Appendix F's definition does, over drawn escapes and every character of the pool.
 */
export const everyClassEscapeHoldsExactlyTheCharactersAppendixFsDefinitionDoes = property.explore(
	escapeGen,
	{
		needs: {},
		situations: [
			"a character the escape holds",
			"a character the escape does not hold"
		] satisfies ReadonlyArray<Reached<EscapeFeature>>,
		check: (_, c: Case<EscapeFeature>) => (escape) =>
			Effect.sync(() => {
				const oracle = compiledPattern(`^${escape.oracle}$`, "v")
				const matcher = Matcher.of(buildNfa(succeeded(xsdPattern(escape.xsd), escape.xsd)))
				for (const character of pool) {
					const expected = oracle.test(character)
					c.note(expected ? "a character the escape holds" : "a character the escape does not hold")
					assert.equal(
						matcher.matches(character),
						expected,
						`${escape.xsd} over ${Formatter.format(character)}`
					)
				}
			}),
		oracle: {
			kind: "second-implementation",
			name: "each escape's meaning by Appendix F's definition, an ECMAScript `v`-flag class over XML's Char"
		},
		kept: [],
		kills: [
			{
				file: "packages/text/src/regex/xsd.ts",
				original:
					'const nonWord = (): CharSet => union([category("P"), category("Z"), category("C")])',
				replacement: 'const nonWord = (): CharSet => union([category("P"), category("Z")])',
				why: "`\\w` keeps the others (category C), a soft hyphen among them; a word of one is admitted."
			},
			{
				file: "packages/text/src/regex/xml.ts",
				original: "\t\t\t[0xfeff, 0xfeff],\n\t\t\t[0xfff0, 0xfffd]\n",
				replacement: "\t\t\t[0xfeff, 0xfeff]\n",
				why: "Specials, which XML Schema's block table lists twice, keeps only its first range: `\\p{IsSpecials}` loses U+FFF0 to U+FFFD."
			}
		]
	}
)

/**
 * The committed General_Category table (categories.generated.ts) is the running Node's: over drawn code points, the
 * category a run of the table gives each is the one Node's regular expressions read, and the whole table is the
 * generator's, run for run, so a category escape reads the Unicode the engine runs under; a Node that ships another
 * Unicode fails it until the table is regenerated (`node scripts/gen/unicode/main.ts`).
 */
export const theCommittedGeneralCategoryTableIsTheRunningNodes = property.explore(codePointGen, {
	needs: {},
	situations: ["an assigned code point", "an unassigned code point"] satisfies ReadonlyArray<
		Reached<CategoryFeature>
	>,
	check: (_, c: Case<CategoryFeature>) => (point) =>
		Effect.sync(() => {
			const committed = committedCategory(point)
			c.note(committed === "Cn" ? "an unassigned code point" : "an assigned code point")
			assert.ok(
				compiledPattern(`^\\p{General_Category=${committed}}$`, "u").test(
					String.fromCodePoint(point)
				),
				`U+${point.toString(16)} is ${committed} in the committed table`
			)
			assert.equal(committedRuns, generatedRuns(), "the committed runs are the generator's")
		}),
	oracle: {
		kind: "specification",
		name: "the running Node's regular expressions, read code point by code point"
	},
	kept: [],
	kills: [
		{
			file: "packages/text/src/regex/categories.generated.ts",
			original: '\t"zw,',
			replacement: '\t"zv,zw,',
			why: "A run is stated twice; the table parts from the running Node's at its first run."
		}
	]
})
