/**
 * The limits of a closed relation's codes and constants, and of a heap tuple (@grizzle/limits), each derived again by
 * another route than its own `compute`, against a second implementation where Node holds one:
 *
 * - smallint, integer and bigint are the two's-complement integers Int16Array, Int32Array and BigInt64Array hold, so
 *   their published ranges and typlens are read off Node's typed arrays, and rosterMaxCodes counts the non-negative
 *   integers Int16Array holds, at every code within eight of its first and of its last;
 * - constantMaxBits is the longest bit length whose rounding up to whole bytes still fits an Int32Array slot;
 * - heapTupleMaxBytes is the largest tuple PageAddItem's fit test admits on an empty heap page, at every size within
 *   sixteen bytes of it, and alignUp is TYPEALIGN's bit arithmetic.
 *
 * NAMEDATALEN, MaxAttrSize and BITS_PER_BYTE have no counterpart in Node: handleMaxBytes, bitColumnMaxBits and
 * maxIdentifierBytes are their sources' arithmetic alone, and a test of them could only restate it, so none is written.
 *
 * Each space is small and exhausted. Features: each integer carrier; a code below, among, at the last of and past a
 * roster's codes; a length below, at and past constantMaxBits; a size already aligned, rounded up, and at byte
 * alignment; a tuple below, at and past heapTupleMaxBytes.
 */

import { word } from "@bjornpagen/testing/dictionary"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int, weighted } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	alignUp,
	blockSize,
	constantMaxBits,
	heapTupleMaxBytes,
	itemIdBytes,
	maxAlign,
	pageHeaderBytes,
	rosterMaxCodes,
	typlens
} from "@grizzle/limits"
import { Effect } from "effect"
import { integerRanges } from "#compiler/ir/carriers.ts"
import type { IntegerCarrier } from "#compiler/ir/scalar.ts"
import { assert } from "#test/support/assert.ts"
import { integerCarriers } from "#test/support/oracle/gen/domain.ts"
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
				assert.equal(
					typlens[carrier].value,
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
				file: "packages/limits/src/limits.ts",
				original: "\tvalue: 32767,",
				replacement: "\tvalue: 32768,",
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
				[1, int(rosterMaxCodes.value - 8, rosterMaxCodes.value + 8)]
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
					const isCode = code >= 0 && code < rosterMaxCodes.value
					assert.equal(
						isCode,
						code >= 0 && typedArrays.int2.holds(BigInt(code)),
						`the code ${code}`
					)
					c.note(
						code < 0
							? "below the codes"
							: code === rosterMaxCodes.value - 1
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
					file: "packages/limits/src/limits.ts",
					original: "\tvalue: 32767,",
					replacement: "\tvalue: 32768,",
					why: "smallint's greatest value one past Int16's; the integer carriers' property fails, and the roster property with it."
				},
				{
					file: "packages/limits/src/limits.ts",
					original: "\tcompute: ([max]) => max.value + 1",
					replacement: "\tcompute: ([max]) => max.value + 2",
					why: "rosterMaxCodes one code past smallint's non-negative values; the roster property fails."
				}
			]
		}
	)

/** A constant's length rounds up to whole bytes inside an int32 exactly up to constantMaxBits. */
export const aConstantsLengthRoundsUpToWholeBytesInsideAnInt32ExactlyUpToConstantMaxBits =
	property.exhaust(finite(int(constantMaxBits.value - 8, constantMaxBits.value + 8)), {
		box: "every bit length within a byte of constantMaxBits",
		needs: {},
		situations: ["at the bound", "below the bound", "past the bound"] satisfies ReadonlyArray<
			Reached<Length>
		>,
		check: (_, c: Case<Length>) => (length) =>
			Effect.sync(() => {
				const rounded = length + 8 - 1
				assert.equal(
					Int32Array.of(rounded)[0] === rounded,
					length <= constantMaxBits.value,
					`a length of ${length} bits`
				)
				c.note(
					length === constantMaxBits.value
						? "at the bound"
						: length < constantMaxBits.value
							? "below the bound"
							: "past the bound"
				)
			}),
		oracle: { kind: "second-implementation", name: "Node's Int32Array" },
		kept: [],
		kills: [
			{
				file: "packages/limits/src/limits.ts",
				original: "\tcompute: ([intMax, bits]) => intMax.value - bits.value + 1",
				replacement: "\tcompute: ([intMax, bits]) => intMax.value - bits.value + 2",
				why: "constantMaxBits one bit past the longest length that rounds up into an int32; the constant property fails."
			}
		]
	})

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
			file: "packages/limits/src/limits.ts",
			original: "export const alignUp = (n: number, a: number): number => Math.ceil(n / a) * a",
			replacement:
				"export const alignUp = (n: number, a: number): number => (Math.floor(n / a) + 1) * a",
			why: "alignUp rounds by floor plus one, so an aligned size overshoots to the next alignment; the alignment property fails."
		}
	]
})

/** A heap page holds as its largest heap tuple the largest one PageAddItem fits on an empty page beside its line pointer. */
export const aHeapPageHoldsAsItsLargestHeapTupleTheLargestOnePageAddItemFitsOnAnEmptyPageBesideItsLinePointer =
	property.exhaust(finite(int(heapTupleMaxBytes.value - 16, heapTupleMaxBytes.value + 16)), {
		box: "every tuple size within sixteen bytes of heapTupleMaxBytes",
		needs: {},
		situations: ["below the bound", "at the bound", "past the bound"] satisfies ReadonlyArray<
			Reached<Tuple>
		>,
		check: (_, c: Case<Tuple>) => (size) =>
			Effect.sync(() => {
				assert.equal(
					pageHeaderBytes.value + itemIdBytes.value <=
						blockSize.value - typeAlign(maxAlign.value, size),
					size <= heapTupleMaxBytes.value,
					`a tuple of ${size} bytes`
				)
				c.note(
					size === heapTupleMaxBytes.value
						? "at the bound"
						: size < heapTupleMaxBytes.value
							? "below the bound"
							: "past the bound"
				)
			}),
		oracle: { kind: "specification", name: "PageAddItem's fit test on an empty heap page" },
		kept: [],
		kills: [
			{
				file: "packages/limits/src/limits.ts",
				original: "\t\tblock.value - alignUp(header.value + itemId.value, align.value)",
				replacement:
					"\t\tblock.value - alignUp(header.value + itemId.value, align.value) + align.value",
				why: "heapTupleMaxBytes an alignment past what an empty page fits; the heap tuple property fails."
			}
		]
	})
