/**
 * The limits of a closed relation's codes and constants, and of a heap tuple, each derived again by
 * another route than its own `compute`, against a second implementation where Node holds one:
 *
 * - smallint, integer and bigint are the two's-complement integers Int16Array, Int32Array and BigInt64Array hold, so
 *   their published ranges and typlens are read off Node's typed arrays, and rosterMaxCodes counts the non-negative
 *   integers Int16Array holds, at every code within eight of its first and of its last;
 * - constantMaxCells and payloadMaxCodes are the most cells a key space's bigint index and the most payload codes a
 *   bigint payload code count, exactly as a BigInt64Array slot holds them;
 * - heapTupleMaxBytes is the largest tuple PageAddItem's fit test admits on an empty heap page, at every size within
 *   sixteen bytes of it, and alignUp is TYPEALIGN's bit arithmetic.
 *
 * NAMEDATALEN, MaxAttrSize and BITS_PER_BYTE have no counterpart in Node: handleMaxBytes, bitColumnMaxBits and
 * maxIdentifierBytes are their sources' arithmetic alone, and a test of them could only restate it, so none is written.
 *
 * Each space is small and exhausted. Features: each integer carrier; a code below, among, at the last of and past a
 * roster's codes; cells and payload codes below, at and past their bounds; a size already aligned, rounded up, and at byte
 * alignment; a tuple below, at and past heapTupleMaxBytes.
 */

import { assert } from "@bjornpagen/testing/assert"
import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { blockSize, itemIdBytes, pageHeaderBytes } from "#compiler/core/page.ts"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { IntegerCarrier } from "#compiler/ir/scalar.ts"
import { heapTupleMaxBytes } from "#compiler/laws/model/model.ts"
import { constantMaxCells, payloadMaxCodes } from "#compiler/physical/ddl/constants.ts"
import { alignUp, maxAlign, rosterMaxCodes, typlens } from "#compiler/schema/representability.ts"
import { integerCarriers } from "#test/unit/core/limits.dictionary.ts"
import {
	type Aligned,
	type Code,
	type Length,
	roundings,
	type Tuple,
	typeAlign,
	typedArrays
} from "#test/unit/core/limits.fixtures.ts"

/** PostgreSQL's integers are the two's-complement integers of their typlens. */
export const postgreSQLsIntegersAreTheTwosComplementIntegersOfTheirTyplens = property.exhaust(
	finite(word(integerCarriers)),
	{
		box: "every integer carrier",
		needs: {},
		situations: integerCarriers satisfies ReadonlyArray<Reached<IntegerCarrier>>,
		check: (_, c: Case<IntegerCarrier>) => (carrier) =>
			Effect.sync(() => {
				const [least, greatest] = integerRanges[carrier]
				const oracle = typedArrays[carrier]
				assert.equal<number>(
					typlens[carrier],
					oracle.bytes,
					"the typlen is the typed array's element size"
				)
				assert.equal(oracle.holds(greatest), true, "the greatest value is held")
				assert.equal(oracle.holds(greatest + 1n), false, "one past the greatest is not")
				assert.equal(oracle.holds(least), true, "the least value is held")
				assert.equal(oracle.holds(least - 1n), false, "one before the least is not")
				assert.equal(least, -(greatest + 1n), "two's complement")
				c.note(carrier)
			}),
		oracle: {
			kind: "second-implementation",
			name: "Node's typed array of the carrier's width"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/ir/carriers.ts",
				original: "int2Max = 32767",
				replacement: "int2Max = 32768",
				why: "smallint's greatest value one past Int16's; the integer carriers' property fails, and the roster property with it."
			}
		]
	}
)

/** PostgreSQL's integers number a roster's codes by every non-negative smallint, once each. */
export const postgreSQLsIntegersNumberARostersCodesByEveryNonNegativeSmallintOnceEach =
	property.exhaust(
		finite(
			weighted([
				[1, int(-8, 8)],
				[1, int(rosterMaxCodes - 8, rosterMaxCodes + 8)]
			])
		),
		{
			box: "every code within eight of the first code and of rosterMaxCodes",
			needs: {},
			situations: [
				"below the codes",
				"a code",
				"the last code",
				"past the codes"
			] satisfies ReadonlyArray<Reached<Code>>,
			check: (_, c: Case<Code>) => (code) =>
				Effect.sync(() => {
					const isCode = code >= 0 && code < rosterMaxCodes
					assert.equal(
						isCode,
						code >= 0 && typedArrays.int2.holds(BigInt(code)),
						`the code ${code}`
					)
					c.note(
						code < 0
							? "below the codes"
							: code === rosterMaxCodes - 1
								? "the last code"
								: isCode
									? "a code"
									: "past the codes"
					)
				}),
			oracle: { kind: "second-implementation", name: "Node's Int16Array" },
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/carriers.ts",
					original: "int2Max = 32767",
					replacement: "int2Max = 32768",
					why: "smallint's greatest value one past Int16's; the integer carriers' property fails, and the roster property with it."
				},
				{
					file: "packages/engine/src/schema/representability.ts",
					original: "rosterMaxCodes = int2Max + 1",
					replacement: "rosterMaxCodes = int2Max + 2",
					why: "rosterMaxCodes one code past smallint's non-negative values; the roster property fails."
				}
			]
		}
	)

/** A constant's index and its payload codes fit a bigint exactly up to constantMaxCells and payloadMaxCodes. */
export const aConstantsIndexAndPayloadCodesFitABigintExactlyUpToTheirBounds = property.exhaust(
	finite((source) => [source.draw(int(-8, 8)), source.draw(int(-8, 8))] as const),
	{
		box: "every count of cells within eight of constantMaxCells, against every count of payload codes within eight of payloadMaxCodes",
		needs: {},
		situations: ["at the bound", "below the bound", "past the bound"] satisfies ReadonlyArray<
			Reached<Length>
		>,
		check:
			(_, c: Case<Length>) =>
			([cellsOffset, pointsOffset]) =>
				Effect.sync(() => {
					const cells = constantMaxCells + BigInt(cellsOffset)
					const points = payloadMaxCodes + BigInt(pointsOffset)
					assert.equal(
						BigInt64Array.of(BigInt.asIntN(64, cells))[0] === cells,
						cells <= constantMaxCells,
						`the index ${cells}, the first past a key space of ${cells} cells`
					)
					assert.equal(
						BigInt64Array.of(BigInt.asIntN(64, points - 1n))[0] === points - 1n,
						points <= payloadMaxCodes,
						`the greatest payload code of ${points} codes`
					)
					c.note(
						cellsOffset === 0 || pointsOffset === 0
							? "at the bound"
							: cellsOffset < 0 && pointsOffset < 0
								? "below the bound"
								: "past the bound"
					)
				}),
		oracle: { kind: "second-implementation", name: "Node's BigInt64Array" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "export const constantMaxCells = int8Max\n",
				replacement: "export const constantMaxCells = int8Max + 1n\n",
				why: "constantMaxCells one cell past the greatest bigint index; the constant property fails."
			},
			{
				file: "packages/engine/src/physical/ddl/constants.ts",
				original: "export const payloadMaxCodes = int8Max + 1n\n",
				replacement: "export const payloadMaxCodes = int8Max + 2n\n",
				why: "payloadMaxCodes one code past the greatest bigint payload code; the constant property fails."
			}
		]
	}
)

/** A heap page rounds a size up as TYPEALIGN does. */
export const aHeapPageRoundsASizeUpAsTYPEALIGNDoes = property.exhaust(finite(roundings), {
	box: "every size up to four times the greatest alignment, at every power-of-two alignment up to it",
	needs: {},
	situations: ["already aligned", "rounded up", "byte alignment"] satisfies ReadonlyArray<
		Reached<Aligned>
	>,
	check:
		(_, c: Case<Aligned>) =>
		({ n, a }) =>
			Effect.sync(() => {
				assert.equal(alignUp(n, a), typeAlign(a, n), `${n} at ${a}`)
				c.note(a === 1 ? "byte alignment" : n % a === 0 ? "already aligned" : "rounded up")
			}),
	oracle: { kind: "specification", name: "TYPEALIGN's bit arithmetic" },
	kept: [],
	kills: [
		{
			file: "packages/engine/src/schema/representability.ts",
			original: "export const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a",
			replacement:
				"export const alignUp = (n: number, a: number): number => (Math.floor(n / a) + 1) * a",
			why: "alignUp rounds by floor plus one, so an aligned size overshoots to the next alignment; the alignment property fails."
		}
	]
})

/** A heap page holds as its largest heap tuple the largest one PageAddItem fits on an empty page beside its line pointer. */
export const aHeapPageHoldsAsItsLargestHeapTupleTheLargestOnePageAddItemFitsOnAnEmptyPageBesideItsLinePointer =
	property.exhaust(finite(int(heapTupleMaxBytes - 16, heapTupleMaxBytes + 16)), {
		box: "every tuple size within sixteen bytes of heapTupleMaxBytes",
		needs: {},
		situations: ["below the bound", "at the bound", "past the bound"] satisfies ReadonlyArray<
			Reached<Tuple>
		>,
		check: (_, c: Case<Tuple>) => (size) =>
			Effect.sync(() => {
				assert.equal(
					pageHeaderBytes + itemIdBytes <= blockSize - typeAlign(maxAlign, size),
					size <= heapTupleMaxBytes,
					`a tuple of ${size} bytes`
				)
				c.note(
					size === heapTupleMaxBytes
						? "at the bound"
						: size < heapTupleMaxBytes
							? "below the bound"
							: "past the bound"
				)
			}),
		oracle: { kind: "specification", name: "PageAddItem's fit test on an empty heap page" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/laws/model/model.ts",
				original:
					"heapTupleMaxBytes = blockSize - alignUp(pageHeaderBytes + itemIdBytes, maxAlign)",
				replacement:
					"heapTupleMaxBytes = blockSize - alignUp(pageHeaderBytes + itemIdBytes, maxAlign) + maxAlign",
				why: "heapTupleMaxBytes an alignment past what an empty page fits; the heap tuple property fails."
			}
		]
	})
