/**
 * The front end of XML Schema 1.0's regular expressions (packages/engine/src/scalar/regex/xsd.ts xsdPattern), read into
 * the regex IR every dialect shares.
 *
 * - Languages: over drawn patterns of every construct Appendix F defines (normal characters, `^` and `$` among them,
 *   and characters outside XML's Char; single- and multi-character escapes; category and block escapes, positive and
 *   negative; the wildcard; character classes, negative and with a subtraction; groups nested two deep; every
 *   quantifier), the reader's language, matched by the IR's automaton (match.ts Matcher), holds exactly the drawn
 *   words the pattern's meaning holds. Oracle: a second implementation, each construct's meaning built from Appendix
 *   F's definitions, each class an ECMAScript class under the `v` flag over XML's Char tested on one code point, and
 *   the regular operators a tree matched by partial derivatives against the whole word (xsd.fixtures.ts
 *   oracleMatcher), in time linear in the word: one backtracking ECMAScript expression of the whole pattern ran away
 *   on nested repetitions of alternations that admit the empty word.
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
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect, Formatter, String as Str } from "effect"
import { Xml } from "#compiler/public/compute.ts"
import { succeeded } from "#test/support/assert.ts"
import { compiledPattern } from "#test/support/regex.ts"
import {
	type CategoryFeature,
	codePointGen,
	committedCategory,
	type EscapeFeature,
	escapeGen,
	initialName,
	type NameFeature,
	nameCharacter,
	oracleMatcher,
	oracleText,
	patternGen,
	pool,
	type RefusalFeature,
	refusedGen,
	wordsGen,
	type XsdFeature
} from "#test/support/unit/text/xsd.fixtures.ts"
import { generatedRuns } from "#test/unit/text/xsd-runs.fixtures.ts"

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
											parsePattern(Xml.pattern(pattern.xsd).source, "u"),
											"the printed source"
										)
									)
								)
					const oracle = oracleMatcher(pattern.oracle)
					for (const word of words) {
						const expected = oracle(word)
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
								`Xml.pattern(${Formatter.format(pattern.xsd)}) over ${Formatter.format(word)}`
							)
						}
						assert.equal(
							matcher.matches(word),
							expected,
							`${Formatter.format(pattern.xsd)} over ${Formatter.format(word)} (oracle ${oracleText(pattern.oracle)})`
						)
					}
				}),
		oracle: {
			kind: "second-implementation",
			name: "each construct's meaning by Appendix F's definitions, each class an ECMAScript `v`-flag class over XML's Char tested on one code point, the regular operators matched by partial derivatives"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/text/xsd.test.ts#xsdPatternReadsEveryDrawnPatternAsAppendixFDefinesItsLanguage:-:3.2.1.3.1.1.3.3.4.3.2.8.0.0.2.8.1.1.2.1.3.3.0.0.0.2.0.6.2.1.2.5.5.0.2.4.1.0.6.0.1.1.0.3.0.0.1.9.0.0.3.1.1.3.0.2.4.2.2.6.4.6.1.1.2.1.2.2.a.1.3.0.g.6.0.2.3.0.e.6.2.0.1.1.2.2.0.6.2.0.0.0.5.2.1.2.0.1.0.1.6.1.0.3.1.2.2.1.3.1.0.8.6.0.1.2.2.3.6.0.2.1.5.0.0.6.2.1.1.3.3.4.2.0.4.0.c.0.0.6.0.2.4.3.4.b.3.3.3.3.0.1.2.0.7.4.a.0.2.4.1.3.1.1.0.2.3.1.4.2.0.0.1.4.2.2.3.1.2.1.0.2.3.4.2.4.b.4.7.1.1.1.4.6.0.1.0.3.2.0.b.2.4.3.1.1.2.2.0.6.3.3.b.3.0.0.3.0.5.4.3.0.4.3.3.4.3.3.1.0.1.1.1.2.3.1.2.2.0.5.2.1.2.0.3.0.3.3.2.1.1.2.1.6.0.3.0.1.6.0.1.0.4.1.1.2.1.1.2.3.1.3.4.0.4.2.0.9.3.e.d.m.4.f.3.c.d.6.l.p.p.d.a.o.0.0.4.b.k.c.c.3.g.p.l.5.5.3.d.8.9.2.6.i"
				),
				reason:
					"a pattern of repetitions nested over alternations that admit the empty word, `((…|…|)+|(…)|){2,}`, whose ECMAScript spelling V8's backtracking engine read past the property's deadline on the word of five code points 😀\\uFFFD\\uFFFD\\r \\uFFF0; the oracle's partial derivatives read it in linear time",
				since: "2026-11-26"
			}
		],
		kills: [
			{
				file: "test/support/unit/text/xsd.fixtures.ts",
				original: "\tconst root = compiled(oracle, { n: 0 })\n",
				replacement:
					'\tconst backtracking = compiledPattern(oracleText(oracle), "v")\n\treturn (word) => backtracking.test(word)\n\tconst root = compiled(oracle, { n: 0 })\n',
				why: "The oracle matches by one backtracking ECMAScript expression of the whole pattern again: the kept case's nested repetitions of alternations that admit the empty word hold the worker past its deadline."
			},
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original: "\tconst admission = admitMatch(printSource(read.value, (set) => set))",
				replacement: "\tconst admission = admitMatch(source)",
				why: "Xml.pattern hands the facet to grizzle's grammar as it is written, unanchored and with XML Schema's escapes unread; the printed pattern's language parts from the facet's."
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
			name: "Appendix F's grammar"
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
				original: '\t\tif (most.kind === "bounded" && numeralBelow(most.numeral, min)) {',
				replacement: '\t\tif (most.kind === "bounded" && countOf(most.numeral) < countOf(min)) {',
				why: "Two counts past 2^53 out of order read as one count, so `a{9007199254740994,9007199254740993}` is admitted, where Appendix F's numbers are compared as written."
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
