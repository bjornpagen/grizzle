/** What the properties of limits.test.ts read: its spaces, models and helpers. */

import { type Gen, int } from "@bjornpagen/testing/gen"
import type { IntegerCarrier } from "#compiler/ir/scalar.ts"
import { maxAlign } from "#compiler/schema/representability.ts"

/** Node's typed array of each integer carrier's width, which holds the same two's-complement integers. */
export const typedArrays: {
	readonly [C in IntegerCarrier]: {
		readonly bytes: number
		readonly holds: (value: bigint) => boolean
	}
} = {
	int2: {
		bytes: Int16Array.BYTES_PER_ELEMENT,
		holds: (value) => Int16Array.of(Number(value))[0] === Number(value)
	},
	int4: {
		bytes: Int32Array.BYTES_PER_ELEMENT,
		holds: (value) => Int32Array.of(Number(value))[0] === Number(value)
	},
	int8: {
		bytes: BigInt64Array.BYTES_PER_ELEMENT,
		holds: (value) => BigInt64Array.of(value)[0] === value
	}
}

/** Where a code falls among a roster's: below its first, among them, its last, or past it. */
export type Code = "below the codes" | "a code" | "the last code" | "past the codes"

/** Where a constant's cells and payload codes fall against their bounds: either at its bound, both below, or one past. */
export type Length = "at the bound" | "below the bound" | "past the bound"

/** TYPEALIGN(a, n) for a power-of-two alignment: the bits below the alignment cleared after adding a - 1. */
export const typeAlign = (a: number, n: number): number => (n + a - 1) & ~(a - 1)

/** How a size rounds at an alignment. */
export type Aligned = "already aligned" | "rounded up" | "byte alignment"

/** A size and the alignment it is rounded up to. */
interface Rounding {
	readonly n: number
	readonly a: number
}

/** Every size from 0 to four times the greatest alignment, at every power-of-two alignment up to it: 132. */
export const roundings: Gen<Rounding> = (s) => ({
	a: 2 ** s.draw(int(0, Math.log2(maxAlign))),
	n: s.draw(int(0, 4 * maxAlign))
})

/** Where a tuple's size falls against heapTupleMaxBytes. */
export type Tuple = "below the bound" | "at the bound" | "past the bound"
