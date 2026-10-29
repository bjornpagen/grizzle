import { Array as Arr, BigInt as BigInteger, pipe, Record as Rec, String as Str } from "effect"
import {
	array,
	boolean,
	codePoint,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	recursive,
	string,
	weighted
} from "#gen.ts"

const LIMB = 0x1_0000_0000n

/** The 32-bit limbs of a non-negative bigint, the most significant first. */
const limbsOf = (value: bigint): ReadonlyArray<number> => {
	const limbs: Array<number> = [Number(value % LIMB)]
	for (let rest = value / LIMB; rest > 0n; rest /= LIMB) {
		limbs.push(Number(rest % LIMB))
	}
	return Arr.reverse(limbs)
}

/** The bigint of `lo..hi` an offset stands for, ordered by distance from zero as `int` orders its values. */
const nearZero = (offset: bigint, lo: bigint, hi: bigint): bigint => {
	if (lo >= 0n) {
		return lo + offset
	}
	if (hi <= 0n) {
		return hi - offset
	}
	const paired = BigInteger.min(-lo, hi)
	if (offset <= 2n * paired) {
		const distance = (offset + 1n) / 2n
		return offset % 2n === 1n ? distance : -distance
	}
	const distance = offset - paired
	return hi > -lo ? distance : -distance
}

const LIMB_MAX = 0xffff_ffff

/** A distance below 2^32 on a logarithmic scale: a bit width first, then a distance of that width, so zero, one and
 * every power of two are as likely as each other's neighbourhoods. */
const logDistance: Gen<bigint> = (source) => {
	const bits = source.choose(0, 32)
	return BigInt(source.choose(0, Math.min(2 ** bits - 1, LIMB_MAX)))
}

/**
 * A bigint between `lo` and `hi`, inclusive, shrinking toward the value nearest zero. A range of at most 2^32 values is
 * one decision, which a random search leans toward the ends of as it does an `int`'s. A wider range is 32-bit limbs,
 * the most significant first and each bounded so the whole never passes `hi`; a decision cannot lean toward the ends
 * of a range it holds only one limb of, so a wide draw is near zero one time in eight and near `lo` or `hi` one time in
 * eight, at a distance on a logarithmic scale, and uniform over its limbs otherwise.
 */
export const bigint = (lo: bigint, hi: bigint): Gen<bigint> => {
	const limbs = limbsOf(hi - lo)
	const uniform: Gen<bigint> = (source) => {
		let offset = 0n
		let tight = true
		for (const limb of limbs) {
			const digit = source.choose(0, tight ? limb : LIMB_MAX)
			tight = tight && digit === limb
			offset = offset * LIMB + BigInt(digit)
		}
		return nearZero(offset, lo, hi)
	}
	return limbs.length === 1
		? uniform
		: weighted([
				[1, map(logDistance, (offset) => nearZero(offset, lo, hi))],
				[
					1,
					(source) => {
						const fromHigh = source.draw(boolean)
						const distance = source.draw(logDistance)
						return fromHigh ? hi - distance : lo + distance
					}
				],
				[6, uniform]
			])
}

const SIGN_64 = -(2n ** 63n)

/**
 * A double's place among all doubles in order, and back: +0 is 0, each larger double the next index, -0 is -1 and each
 * more negative double the index below. Neighbouring indexes are neighbouring doubles, so a range of doubles is a range
 * of indexes. The bits are read through one scratch buffer per generator, written before every read.
 */
const doublePlaces = () => {
	const scratch = new Float64Array(1)
	const bits = new BigInt64Array(scratch.buffer)
	return {
		indexOf: (value: number): bigint => {
			scratch[0] = value
			const raw = bits[0] ?? 0n
			return raw >= 0n ? raw : -(raw - SIGN_64) - 1n
		},
		valueOf: (index: bigint): number => {
			bits[0] = index >= 0n ? index : -index - 1n + SIGN_64
			return scratch[0] ?? 0
		}
	}
}

/** A 32-bit float's place among all 32-bit floats in order, and back, as `doublePlaces` places a double. */
const floatPlaces = () => {
	const scratch = new Float32Array(1)
	const bits = new Int32Array(scratch.buffer)
	return {
		indexOf: (value: number): number => {
			scratch[0] = value
			const raw = bits[0] ?? 0
			return raw >= 0 ? raw : -(raw & 0x7fff_ffff) - 1
		},
		valueOf: (index: number): number => {
			bits[0] = index >= 0 ? index : (-index - 1) | 0x8000_0000
			return scratch[0] ?? 0
		}
	}
}

/**
 * Whole numbers within a range, when it holds any, as one arm of a floating-point draw: a quarter of draws are whole,
 * and a failure shrinks to a whole number whenever a whole number still fails, where shrinking by place alone would
 * end on the smallest subnormal.
 */
const wholeOr = (min: number, max: number, limit: number, anywhere: Gen<number>): Gen<number> => {
	const low = Math.max(Math.ceil(min), -limit)
	const high = Math.min(Math.floor(max), limit)
	return low <= high
		? weighted([
				[1, int(low, high)],
				[3, anywhere]
			])
		: anywhere
}

/**
 * A finite double between `min` and `max`, inclusive. Every double in the range is drawn by its place in order, so each
 * scale is as likely as the next, -0 and the subnormals included, and a random search reaches the range's ends and the
 * doubles nearest zero. A quarter of draws are whole numbers, and a failure shrinks toward a whole number, then toward
 * zero. NaN and the infinities are never drawn: a test that needs them names them in a `weighted` choice, and a
 * boundary handed them where its types refuse them draws them as wild values.
 */
export const double = (min: number, max: number): Gen<number> => {
	const places = doublePlaces()
	return wholeOr(
		min,
		max,
		2 ** 31 - 1,
		map(bigint(places.indexOf(min), places.indexOf(max)), places.valueOf)
	)
}

/** A finite 32-bit float between `min` and `max`, inclusive, both 32-bit floats themselves, drawn as `double` draws. */
export const float = (min: number, max: number): Gen<number> => {
	const places = floatPlaces()
	return wholeOr(
		min,
		max,
		2 ** 24,
		map(int(places.indexOf(min), places.indexOf(max)), places.valueOf)
	)
}

/** The IEEE values that are no finite number, and the zero that is negative: each its own case a double can be. */
const SPECIALS: Arr.NonEmptyReadonlyArray<number> = [
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	-0
]

/**
 * Any double a computation can meet: a finite one between `min` and `max` as `double` draws it, and one draw in ten a
 * special value (NaN, ±Infinity, -0), each as often, shrinking toward the finite.
 */
export const doubleOrSpecial = (min: number, max: number): Gen<number> =>
	weighted([
		[9, double(min, max)],
		[1, element(SPECIALS)]
	])

/** Any 32-bit float a computation can meet: a finite one as `float` draws it, and one draw in ten a special value. */
export const floatOrSpecial = (min: number, max: number): Gen<number> =>
	weighted([
		[9, float(min, max)],
		[1, element(SPECIALS)]
	])

export type UuidVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

const hex = (value: number, digits: number): string =>
	pipe(value.toString(16), Str.padStart(digits, "0"))

/**
 * A UUID of one version in its canonical lowercase form, with RFC 9562's variant, every other bit drawn and shrinking
 * toward zero. A version 7 UUID's first 48 bits are its millisecond timestamp, so the simplest is the epoch's.
 */
export const uuid =
	(version: UuidVersion): Gen<string> =>
	(source) => {
		const timeHigh = hex(source.choose(0, 0xffff_ffff), 8)
		const timeLow = hex(source.choose(0, 0xffff), 4)
		const randomA = hex(source.choose(0, 0xfff), 3)
		const randomB = hex(0x8000 | source.choose(0, 0x3fff), 4)
		const randomC = hex(source.choose(0, 0xffff), 4)
		const randomD = hex(source.choose(0, 0xffff_ffff), 8)
		return `${timeHigh}-${timeLow}-${version}${randomA}-${randomB}-${randomC}${randomD}`
	}

/** A value JSON can carry. */
export type Json =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<Json>
	| Readonly<{ [key: string]: Json }>

const jsonScalar = oneOf<Json>([
	constant(null),
	boolean,
	double(-Number.MAX_VALUE, Number.MAX_VALUE),
	string(codePoint(0x20, 0x7e), { min: 0, max: 8 })
])

const jsonKey = string(codePoint(0x61, 0x66), { min: 0, max: 3 })

/**
 * A JSON value nested at most `depth` levels: scalars, arrays of up to three items and objects of up to three keys
 * drawn from a few letters, so keys repeat and collide. Shrinks toward `null`.
 */
export const json = (depth: number): Gen<Json> =>
	recursive(
		jsonScalar,
		(inner) =>
			oneOf<Json>([
				array(inner, { min: 0, max: 3 }),
				map(
					array((source) => [source.draw(jsonKey), source.draw(inner)] as const, {
						min: 0,
						max: 3
					}),
					Rec.fromEntries
				)
			]),
		depth
	)
