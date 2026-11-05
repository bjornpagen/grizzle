/**
 * The limits of a closed relation's codes and constants, and of a heap tuple (core/limits.ts), each derived again by
 * another route than its own `compute`, against a second implementation where Node holds one:
 *
 * - smallint, integer and bigint are the two's-complement integers Int16Array, Int32Array and BigInt64Array hold, so
 *   their published ranges and typlens and rosterMaxCodes are read off Node's typed arrays;
 * - constantMaxBits is the longest bit length whose rounding up to whole bytes still fits an Int32Array slot;
 * - heapTupleMaxBytes is the largest tuple PageAddItem's fit test admits on an empty heap page, found by search, and
 *   alignUp is TYPEALIGN's bit arithmetic.
 *
 * NAMEDATALEN, MaxAttrSize and BITS_PER_BYTE have no counterpart in Node: handleMaxBytes, bitColumnMaxBits and
 * maxIdentifierBytes are their sources' arithmetic alone, and a test of them could only restate it, so none is written.
 */
import { describe, it } from "@effect/vitest"
import { type Case, exhaust } from "@grizzle/testing/explore"
import { requiredInSpace } from "@grizzle/testing/features"
import { element, type Gen, int } from "@grizzle/testing/gen"
import { searched } from "@grizzle/testing/vitest"
import { Effect, Formatter } from "effect"
import {
	alignUp,
	blockSize,
	constantMaxBits,
	heapTupleMaxBytes,
	int2Max,
	int2Min,
	int4Max,
	int4Min,
	int8Max,
	int8Min,
	itemIdBytes,
	type Limit,
	maxAlign,
	pageHeaderBytes,
	rosterMaxCodes,
	typlens
} from "#compiler/core/limits.ts"
import { assert } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"

/** One of PostgreSQL's integer types, beside the Node typed array that holds the same integers. */
interface IntegerType {
	readonly least: bigint
	readonly greatest: bigint
	readonly typlen: Limit
	readonly bytes: number
	readonly holds: (value: bigint) => boolean
}

const integerTypes = {
	smallint: {
		least: BigInt(int2Min.value),
		greatest: BigInt(int2Max.value),
		typlen: typlens.int2,
		bytes: Int16Array.BYTES_PER_ELEMENT,
		holds: (value: bigint) => Int16Array.of(Number(value))[0] === Number(value)
	},
	integer: {
		least: BigInt(int4Min.value),
		greatest: BigInt(int4Max.value),
		typlen: typlens.int4,
		bytes: Int32Array.BYTES_PER_ELEMENT,
		holds: (value: bigint) => Int32Array.of(Number(value))[0] === Number(value)
	},
	bigint: {
		least: int8Min.value,
		greatest: int8Max.value,
		typlen: typlens.int8,
		bytes: BigInt64Array.BYTES_PER_ELEMENT,
		holds: (value: bigint) => BigInt64Array.of(value)[0] === value
	}
} as const satisfies Readonly<Record<string, IntegerType>>

type IntegerName = keyof typeof integerTypes

describe("PostgreSQL's integers", () => {
	/**
	 * Each integer type's published least and greatest values are the ends of the two's-complement integers of its
	 * typlen: each end is held, and the value one past it is not. Oracle: Node's typed array of the same width.
	 */
	const ends = (name: IntegerName, c: Case<IntegerName>) =>
		Effect.sync(() => {
			const type = integerTypes[name]
			assert.equal(type.typlen.value, type.bytes, "the typlen is the typed array's element size")
			assert.equal(type.holds(type.greatest), true, "the greatest value is held")
			assert.equal(type.holds(type.greatest + 1n), false, "one past the greatest is not")
			assert.equal(type.holds(type.least), true, "the least value is held")
			assert.equal(type.holds(type.least - 1n), false, "one before the least is not")
			assert.equal(type.least, -(type.greatest + 1n), "two's complement")
			c.note(name)
		})

	it.effect("are the two's-complement integers of their typlens", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/core/limits-integers",
					generator: element<IntegerName>(["smallint", "integer", "bigint"]),
					literal: Formatter.format,
					limit: 3,
					coverage: requiredInSpace<IntegerName>(["smallint", "integer", "bigint"]),
					caseHang
				},
				ends
			)
		)
	)

	it("number a roster's codes by every non-negative smallint, once each", () => {
		const holds = integerTypes.smallint.holds
		let codes = 0
		for (let code = 0n; holds(code); code += 1n) {
			codes += 1
		}
		assert.equal(rosterMaxCodes.value, codes, "the non-negative smallints, counted")
	})
})

describe("a constant's length", () => {
	type Length = "at the bound" | "below the bound" | "past the bound"

	/**
	 * A bit length rounds up to whole bytes inside an int32, (length + BITS_PER_BYTE - 1) held by an integer, exactly up
	 * to constantMaxBits: every length within a byte of the bound. Oracle: Node's Int32Array, holding C's int.
	 */
	const rounds = (length: number, c: Case<Length>) =>
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
		})

	it.effect("rounds up to whole bytes inside an int32 exactly up to constantMaxBits", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/core/limits-constant",
					generator: int(constantMaxBits.value - 8, constantMaxBits.value + 8),
					literal: Formatter.format,
					limit: 17,
					coverage: requiredInSpace<Length>(["at the bound", "below the bound", "past the bound"]),
					caseHang
				},
				rounds
			)
		)
	)
})

describe("a heap page", () => {
	/** TYPEALIGN(a, n) for a power-of-two alignment: the bits below the alignment cleared after adding a - 1. */
	const typeAlign = (a: number, n: number): number => (n + a - 1) & ~(a - 1)

	type Aligned = "already aligned" | "rounded up" | "byte alignment"

	interface Rounding {
		readonly n: number
		readonly a: number
	}

	/** Every size from 0 to four times the greatest alignment, at every power-of-two alignment up to it: 132. */
	const roundings: Gen<Rounding> = (s) => ({
		a: s.draw(element([1, 2, 4, 8])),
		n: s.draw(int(0, 4 * maxAlign.value))
	})

	/** alignUp rounds as TYPEALIGN does. Oracle: TYPEALIGN's bit arithmetic. */
	const aligns = ({ n, a }: Rounding, c: Case<Aligned>) =>
		Effect.sync(() => {
			assert.equal(alignUp(n, a), typeAlign(a, n), `${n} at ${a}`)
			c.note(a === 1 ? "byte alignment" : n % a === 0 ? "already aligned" : "rounded up")
		})

	it.effect("rounds a size up as TYPEALIGN does", (ctx) =>
		searched(
			ctx,
			exhaust(
				{
					suite: "unit/core/limits-align",
					generator: roundings,
					literal: Formatter.format,
					limit: 132,
					coverage: requiredInSpace<Aligned>(["already aligned", "rounded up", "byte alignment"]),
					caseHang
				},
				aligns
			)
		)
	)

	it("holds as its largest heap tuple the largest one PageAddItem fits on an empty page beside its line pointer", () => {
		const fits = (size: number): boolean =>
			pageHeaderBytes.value + itemIdBytes.value <= blockSize.value - typeAlign(maxAlign.value, size)
		let largest = blockSize.value
		while (!fits(largest)) {
			largest -= 1
		}
		assert.equal(heapTupleMaxBytes.value, largest, "the largest size PageAddItem's fit test admits")
	})
})
