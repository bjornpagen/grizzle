/** What the properties of float.test.ts read: its spaces, models and helpers. */

import { element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { double, float } from "@bjornpagen/testing/values"
import {
	binary32LeastExponent,
	binary32Max,
	binary32MaxExponent,
	binary32Precision
} from "@grizzle/limits"
import { toReal } from "#compiler/scalar/values/float.ts"
import { assert, faulted, succeeded } from "#test/support/assert.ts"

/** The specials a double can be beside a finite value: -0, NaN and the infinities. */
const specials: Gen<number> = element([
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY
])

/** The greatest binary32 subnormal, (2^(p - 1) - 1) · 2^least. */
const greatestSubnormal =
	(2 ** (binary32Precision.value - 1) - 1) * 2 ** binary32LeastExponent.value

/** The least magnitude a double rounds to a binary32 infinity at: binary32Max plus half its last place. */
const overflowAt = binary32Max.value + 2 ** (binary32MaxExponent.value - binary32Precision.value)

/** The greatest magnitude a nonzero double rounds to a binary32 zero at: half the least subnormal. */
const underflowAt = 2 ** (binary32LeastExponent.value - 1)

/**
 * A double the cast meets: any finite double by its place, a binary32 value, a binary32 subnormal, or a special, each a
 * named arm.
 */
export const doubleGen: Gen<number> = weighted([
	[6, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[2, float(-binary32Max.value, binary32Max.value)],
	[1, float(-greatestSubnormal, greatestSubnormal)],
	[1, specials]
])

/** The bit pattern of a binary32 value, read through one scratch buffer. */
const binary32 = Object.freeze(
	(() => {
		const scratch = new Float32Array(1)
		const bits = new Int32Array(scratch.buffer)
		const of = (pattern: number): number => {
			bits[0] = pattern
			return scratch[0] ?? 0
		}
		return {
			bitsOf: (value: number): number => {
				scratch[0] = value
				return bits[0] ?? 0
			},
			/** The binary32 values on either side of a finite one: the least subnormal's beside zero. */
			neighbours: (value: number): readonly [number, number] => {
				if (value === 0) {
					return [-(2 ** binary32LeastExponent.value), 2 ** binary32LeastExponent.value]
				}
				scratch[0] = value
				const pattern = bits[0] ?? 0
				return value > 0 ? [of(pattern - 1), of(pattern + 1)] : [of(pattern + 1), of(pattern - 1)]
			}
		}
	})()
)

export type RealFeature =
	| "rounded"
	| "stored exactly"
	| "a binary32 subnormal stored"
	| "realOverflow"
	| "realUnderflow"
	| "-0 stored as 0"
	| "a special kept"

/** Checks toReal on one double against binary32's rounding, and names the situation it was in. */
export const realVerdict = (x: number): RealFeature => {
	const real = toReal(x)
	if (Number.isNaN(x) || !Number.isFinite(x)) {
		assert.ok(Object.is(succeeded(real), x), `${x} is kept`)
		return "a special kept"
	}
	if (Math.abs(x) >= overflowAt) {
		faulted(real, "realOverflow", `${x}`)
		return "realOverflow"
	}
	if (x !== 0 && Math.abs(x) <= underflowAt) {
		faulted(real, "realUnderflow", `${x}`)
		return "realUnderflow"
	}
	const stored = succeeded(real, `${x}`)
	assert.ok(Object.is(Math.fround(stored), stored), `${x} is stored as ${stored}, a binary32 value`)
	assert.ok(!Object.is(stored, -0), `${x} is stored as -0`)
	const distance = Math.abs(stored - x)
	for (const neighbour of binary32.neighbours(stored)) {
		const nearer = Math.abs(neighbour - x)
		assert.ok(distance <= nearer, `${neighbour} lies nearer ${x} than its stored ${stored}`)
		if (distance === nearer) {
			assert.ok((binary32.bitsOf(stored) & 1) === 0, `${x} ties, stored at the odd ${stored}`)
		}
	}
	return Object.is(x, -0)
		? "-0 stored as 0"
		: stored !== 0 && Math.abs(stored) <= greatestSubnormal
			? "a binary32 subnormal stored"
			: stored === x
				? "stored exactly"
				: "rounded"
}

/** The order a difference states: -1, 0 or 1, never -0. */
const signOf = (n: bigint): -1 | 0 | 1 => (n < 0n ? -1 : n > 0n ? 1 : 0)

/** A non-NaN double's rank among the doubles by its bit pattern, a sign and a magnitude, -0 ranked as 0. */
const rankOf = (() => {
	const scratch = new Float64Array(1)
	const bits = new BigInt64Array(scratch.buffer)
	return (value: number): bigint => {
		scratch[0] = value === 0 ? 0 : value
		const pattern = bits[0] ?? 0n
		return pattern >= 0n ? pattern : -(pattern & 0x7fff_ffff_ffff_ffffn)
	}
})()

/** PostgreSQL's float order, modelled: NaN equal to itself and above all, every other value by its rank. */
export const modelOrder = (a: number, b: number): -1 | 0 | 1 =>
	Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : signOf(rankOf(a) - rankOf(b))

export type OrderFeature =
	| "a NaN against another value"
	| "two NaNs"
	| "-0 against 0"
	| "an infinity"
	| "two distinct finite values"

/** The situations a pair of doubles is in. */
export const orderFeatures = (a: number, b: number): ReadonlyArray<OrderFeature> => [
	...(Number.isNaN(a) !== Number.isNaN(b) ? (["a NaN against another value"] as const) : []),
	...(Number.isNaN(a) && Number.isNaN(b) ? (["two NaNs"] as const) : []),
	...(a === 0 && b === 0 && Object.is(a, -0) !== Object.is(b, -0)
		? (["-0 against 0"] as const)
		: []),
	...(Math.abs(a) === Number.POSITIVE_INFINITY || Math.abs(b) === Number.POSITIVE_INFINITY
		? (["an infinity"] as const)
		: []),
	...(Number.isFinite(a) && Number.isFinite(b) && a !== b
		? (["two distinct finite values"] as const)
		: [])
]

/** A double of the order's draw: a special or zero half the time, so pairs meet NaN, -0 and the infinities. */
export const orderedGen: Gen<number> = weighted([
	[1, doubleGen],
	[1, element([-0, 0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])
