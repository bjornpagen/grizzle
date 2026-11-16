/**
 * Host bit strings (codec/bits.ts) against a naive model: a string is its length and the Set of its positions that hold
 * a 1, its text one character per position. Every operation is checked against the model's own Set algebra, and the
 * cell read against PostgreSQL's substring and int4 cast restated on the text.
 *
 * Where a space is small at the boundaries that matter it is enumerated whole: every string with at most two ones or at
 * most two zeros at each length beside a word's edges (0, 1, 31, 32, 33, 63, 64, 65), every string with one one or one
 * zero beside a Harley–Seal block's edges (255 to 257, 511 to 513, 543 to 545), and every one-hot string of three
 * words under every cell width. Random densities and lengths up to four blocks and a word are searched.
 *
 * Oracle: the model's Set algebra, a second implementation, and PostgreSQL's substring and int4 cast restated on the
 * text for the cell read.
 *
 * Features: as each search names them: no bits, a partial last word, whole words, a bit at a word's last position, a
 * dense string; one one and one zero past one and two blocks; each cell placement.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { array, boolean, constant, element, finite, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	type Added,
	type Additions,
	algebra,
	anyCells,
	type Block,
	blocks,
	type CellRead,
	type Cells,
	type Combination,
	type Combined,
	type Combining,
	counted,
	densities,
	type Edge,
	edges,
	lengths,
	oneHots,
	placement,
	read,
	type Read,
	readAny,
	setMembers,
	textAt,
	texts
} from "#test/unit/codec/bits.fixtures.ts"

/** Bit strings at a word's edges read, enumerate, count and test every position as the model does, at every word edge. */
export const bitStringsAtAWordsEdgesReadEnumerateCountAndTestEveryPositionAsTheModelDoesAtEveryWordEdge =
	property.exhaust(finite(edges), {
		needs: {},
		situations: [
			"no bits",
			"a partial last word",
			"whole words",
			"a bit at a word's last position",
			"a dense string"
		] satisfies ReadonlyArray<Reached<Edge>>,
		check: (_, c: Case<Edge>) => (value) => read(value, c),
		oracle: { kind: "second-implementation", name: "the model's Set algebra" },
		box: "every string of at most two ones or two zeros at each length beside a word's edges",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/bits.ts",
				original: '\t\t\ttext.slice(j * wordBits, (j + 1) * wordBits).padEnd(wordBits, "0"),',
				replacement: '\t\t\ttext.slice(j * wordBits, (j + 1) * wordBits).padStart(wordBits, "0"),',
				why: "A partial last word is read from text right-aligned, its bits at the word's end; every property that reads text as the model's positions fails."
			}
		]
	})

/** Bit strings at a word's edges count and enumerate every block edge as the model does. */
export const bitStringsAtAWordsEdgesCountAndEnumerateEveryBlockEdgeAsTheModelDoes =
	property.exhaust(finite(blocks), {
		needs: {},
		situations: [
			"one one",
			"one zero",
			"past one block",
			"past two blocks"
		] satisfies ReadonlyArray<Reached<Block>>,
		check: (_, c: Case<Block>) => (value) => counted(value, c),
		oracle: { kind: "second-implementation", name: "the model's count and members" },
		box: "every string of one one or one zero beside a Harley–Seal block's edges",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/bits.ts",
				original:
					"\treturn eights * 8 + wordCount(fours) * 4 + wordCount(twos) * 2 + wordCount(ones) + rest",
				replacement:
					"\treturn eights * 8 + wordCount(fours) * 4 + wordCount(twos) * 2 + wordCount(ones) + rest - Math.min(1, Math.max(0, blocks - 1))",
				why: "A count of a string past one Harley–Seal block comes out one short; the count property fails."
			}
		]
	})

/**
 * Bit strings on the host read PostgreSQL's text as the model's positions, total past either end, and write the same
 * text back.
 *
 * Budget: its suite's count before the conversion (unit/codec/bits-read: 1000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const bitStringsOnTheHostReadPostgreSQLsTextAsTheModelsPositionsTotalPastEitherEndAndWriteTheSameTextBack =
	property.explore(texts, {
		needs: {},
		situations: [
			"no bits",
			"a partial last word",
			"whole words",
			["past two blocks", "every bit"],
			["past two blocks", "some bits"]
		] satisfies ReadonlyArray<Reached<Read>>,
		check: (_, c: Case<Read>) => (value) => readAny(value, c),
		oracle: { kind: "second-implementation", name: "the model of PostgreSQL's text" },
		budget: { runs: 1000, steered: 0 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/bits.ts",
				original: '\t\t\ttext.slice(j * wordBits, (j + 1) * wordBits).padEnd(wordBits, "0"),',
				replacement: '\t\t\ttext.slice(j * wordBits, (j + 1) * wordBits).padStart(wordBits, "0"),',
				why: "A partial last word is read from text right-aligned, its bits at the word's end; every property that reads text as the model's positions fails."
			}
		]
	})

/**
 * Bit strings on the host add each bit in place as set union, so a code already there changes nothing, and refuse a
 * position outside.
 *
 * Budget: its suite's count before the conversion (unit/codec/bits-add: 1000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const bitStringsOnTheHostAddEachBitInPlaceAsSetUnionSoACodeAlreadyThereChangesNothingAndRefuseAPositionOutside =
	property.explore(
		(source): Additions => {
			const text = source.draw(texts)
			return {
				text,
				fresh: source.draw(boolean),
				positions: source.draw(array(int(-2, text.length + 1), { min: 0, max: 24 }))
			}
		},
		{
			needs: {},
			situations: [
				"new",
				"already there",
				"outside",
				["from nothing", "already there"]
			] satisfies ReadonlyArray<Reached<Added>>,
			check: (_, c: Case<Added>) => (value) => setMembers(value, c),
			oracle: { kind: "second-implementation", name: "the model's set union" },
			budget: { runs: 1000, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/codec/bits.ts",
					original: "\t\tk >= 0 && k < bits.length,",
					replacement: "\t\tk >= 0 && k <= bits.length,",
					why: "A bit added at the string's length is admitted rather than refused; the add property fails."
				}
			]
		}
	)

/**
 * Bit strings on the host combine two strings of one length into the first as the model's union, intersection and
 * difference, and refuse two lengths.
 *
 * Budget: its suite's count before the conversion (unit/codec/bits-combine: 1000 independent cases and 0 steered,
 * Vitest at grizzle 4ca3036a).
 */
export const bitStringsOnTheHostCombineTwoStringsOfOneLengthIntoTheFirstAsTheModelsUnionIntersectionAndDifferenceAndRefuseTwoLengths =
	property.explore(
		(source): Combining => {
			const combination = source.draw(element<Combination>(["or", "and", "andNot"]))
			const length = source.draw(lengths)
			const other = source.draw(
				weighted([
					[9, constant(length)],
					[1, lengths]
				])
			)
			return {
				combination,
				target: source.draw(textAt(length, source.draw(densities))),
				operand: source.draw(textAt(other, source.draw(densities)))
			}
		},
		{
			needs: {},
			situations: ["or", "and", "andNot", "lengths differ"] satisfies ReadonlyArray<
				Reached<Combined>
			>,
			check: (_, c: Case<Combined>) => (value) => algebra(value, c),
			oracle: {
				kind: "second-implementation",
				name: "the model's union, intersection and difference"
			},
			budget: { runs: 1000, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/codec/bits.ts",
					original: "\tcombine(target, source, (t, s) => t & ~s)",
					replacement: "\tcombine(target, source, (t, s) => t & ~(s & ~1))",
					why: "A difference keeps each word's last bit where the source holds it; the set-algebra property fails on andNot."
				}
			]
		}
	)

/** Bit strings on the host read a w-bit cell of every one-hot string as PostgreSQL casts its substring to int4. */
export const bitStringsOnTheHostReadAWBitCellOfEveryOneHotStringAsPostgreSQLCastsItsSubstringToInt4 =
	property.exhaust(finite(oneHots), {
		needs: {},
		situations: [
			"inside one word",
			"across two words",
			"before the start",
			"past the end",
			"a negative int4"
		] satisfies ReadonlyArray<Reached<CellRead>>,
		check: (_, c: Case<CellRead>) => (value) => placement(value, c),
		oracle: {
			kind: "specification",
			name: "PostgreSQL's substring cast to int4, restated on the text"
		},
		box: "every one-hot string of three words under every cell width",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/codec/bits.ts",
				original: "\t\t((wordAt(bits.words, j + 1) >>> 1) >>> (wordBits - 1 - shift))",
				replacement: "\t\t(wordAt(bits.words, j + 1) >>> (wordBits - shift))",
				why: "A cell's second word is shifted by 32 when the cell starts on a word's first bit, which shifts by 0 and lets the whole word in; the cell read fails."
			}
		]
	})

/**
 * Bit strings on the host read a w-bit cell as PostgreSQL casts its substring to int4, and 0 past either end.
 *
 * Budget: its suite's count before the conversion (unit/codec/bits-cell: 1000 independent cases and 0 steered, Vitest
 * at grizzle 4ca3036a).
 */
export const bitStringsOnTheHostReadAWBitCellAsPostgreSQLCastsItsSubstringToInt4And0PastEitherEnd =
	property.explore(
		(source): Cells => {
			const width = source.draw(
				weighted([
					[1, element([1, 2, 5, 8, 31, 32])],
					[1, int(1, 32)]
				])
			)
			const cells = source.draw(int(0, 40))
			return {
				width,
				text: source.draw(textAt(cells * width, source.draw(densities))),
				indices: source.draw(array(int(-3, cells + 2), { min: 1, max: 12 }))
			}
		},
		{
			needs: {},
			situations: [
				"inside one word",
				"across two words",
				"before the start",
				"past the end",
				"a negative int4"
			] satisfies ReadonlyArray<Reached<CellRead>>,
			check: (_, c: Case<CellRead>) => (value) => anyCells(value, c),
			oracle: {
				kind: "specification",
				name: "PostgreSQL's substring cast to int4, restated on the text"
			},
			budget: { runs: 1000, steered: 0 },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/codec/bits.ts",
					original: "\treturn (window >>> (wordBits - width)) | 0",
					replacement: "\treturn (window >>> (width - wordBits)) | 0",
					why: "Operator mutant (operand-swap) at packages/engine/src/codec/bits.ts:238 in cell: `wordBits - width` becomes `width - wordBits`; the property fails (lane CATCH, grizzle 0baff5d6)."
				}
			]
		}
	)
