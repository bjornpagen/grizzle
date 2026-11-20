/**
 * A text ends with a suffix exactly where its suffix key lies in the suffix's range (sql/suffix.ts suffixRange): the
 * range `chr(1) || reverse(text) >= chr(1) || reverse(suffix)` and below the least text above every key with that
 * prefix, the sentinel's prefix with its trailing U+10FFFF dropped and its last code point raised by one, U+D7FF to
 * U+E000, which a judged read states in place of its suffix test so PostgreSQL seeks the B-tree on the key.
 *
 * Each case draws a text of up to six code points, and a suffix of it or a text drawn apart, over the code points the
 * range turns on: the sentinel and the next one up, ASCII, the dot, the edges of UTF-8's one, two and three byte
 * sequences, U+D7FF and U+E000 beside the surrogates, the first astral code point, and U+10FFFE and U+10FFFF. The host
 * evaluates the range's SQL, each builtin as PostgreSQL 19 computes it by code points in a UTF8 database (chr refusing 0,
 * a surrogate and anything past U+10FFFF), and it is true exactly where the host's String endsWith is, which over
 * well-formed texts compares code points.
 *
 * Oracle: the host's endsWith, a second implementation.
 *
 * Features: a text that ends with the suffix and one that does not, an empty suffix, a suffix of U+10FFFF alone, one
 * ending in U+D7FF, and an astral one.
 */

import { assert } from "@bjornpagen/testing/assert"
import { property, type Case } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import {
	caseGen,
	endsWith,
	featuresOf,
	inRange,
	type SuffixCase,
	type SuffixFeature,
	suffixFeatures
} from "#test/unit/sql/suffix.fixtures.ts"

/** A text ends with a suffix exactly where its suffix key lies in the suffix's range. */
export const aTextEndsWithASuffixExactlyWhereItsSuffixKeyLiesInTheSuffixsRange = property.explore(
	caseGen,
	{
		needs: {},
		situations: suffixFeatures,
		check: (_, k: Case<SuffixFeature>) => (c: SuffixCase) =>
			Effect.sync(() => {
				for (const feature of featuresOf(c)) {
					k.note(feature)
				}
				assert.equal(
					inRange(c),
					endsWith(c),
					`${Formatter.format(c)}: in the range exactly where the text ends with the suffix`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the host's endsWith over well-formed texts, by code points"
		},
		show: Formatter.format,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/sql/suffix.ts",
				original:
					'\tbinary("||", call("chr", [lit.int(1, types.integer)]), call("reverse", [text]))\n',
				replacement: '\tcall("reverse", [text])\n',
				why: "A key with no sentinel: a suffix of U+10FFFF alone has no text above its keys, and its bound, the empty prefix raised, is U+0001, below them, so no text that ends with it is found."
			},
			{
				file: "packages/engine/src/sql/suffix.ts",
				original:
					'\tconst q = call("rtrim", [suffixLow(suffix), call("chr", [lit.int(lastCodePoint, types.integer)])])\n',
				replacement: "\tconst q = suffixLow(suffix)\n",
				why: "The trailing U+10FFFF kept: a suffix whose key ends with it is raised past the last code point, which chr refuses."
			},
			{
				file: "packages/engine/src/sql/suffix.ts",
				original: "\t\t\t\t\t\tresult: lit.int(pastSurrogates, types.integer)\n",
				replacement: "\t\t\t\t\t\tresult: lit.int(beforeSurrogates + 1, types.integer)\n",
				why: "U+D7FF raised into the surrogates: chr refuses U+D800, so a suffix whose key ends with U+D7FF has no bound."
			},
			{
				file: "packages/engine/src/sql/suffix.ts",
				original: '\t\t\t\telse: binary("+", last, lit.int(1, types.integer))\n',
				replacement: "\t\t\t\telse: last\n",
				why: "A bound of the prefix itself, its last code point not raised: the range is empty, and no text that ends with a suffix is found."
			}
		]
	}
)
