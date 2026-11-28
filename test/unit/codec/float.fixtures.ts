/** What the properties of float.test.ts read: its spaces, models and helpers. */

import { nonEmpty } from "@bjornpagen/testing/assert"
import { boolean, element, int, map, string, weighted } from "@bjornpagen/testing/gen"
import { matching } from "@bjornpagen/testing/pattern"
import { double, float } from "@bjornpagen/testing/values"
import { regex } from "arkregex"
import { Array as Arr, pipe, String as Str } from "effect"
import type { strictDouble } from "#test/support/kernel/strict.ts"

export const floatMax = 3.4028234663852886e38
export const minSubnormal = 2 ** -149

/**
 * The shortest decimal text naming a binary32 value, as PostgreSQL's float4out writes it: the fewest significant
 * digits whose strtof reading is the value. Built here independently, by trying 1..9 digits and reading each
 * candidate exactly through BigInt rational comparison against the value's rounding interval.
 */
export const shortestFloat32Text = (f: number): string => {
	for (let digits = 1; digits <= 9; digits++) {
		const text = f.toPrecision(digits)
		if (Math.fround(Number(text)) === f && decimalToBinary32Reference(text) === f) {
			return text
		}
	}
	return f.toPrecision(9)
}

/** An independent exact reading: the decimal as a rational, compared against the two neighbouring midpoints. */
export const decimalToBinary32Reference = (text: string): number => {
	const x = Number(text)
	const candidate = Math.fround(x)
	const exactOf = (v: number): readonly [bigint, bigint] => {
		if (v === 0) {
			return [0n, 1n]
		}
		let k = 0
		let m = v
		while (!Number.isInteger(m)) {
			m *= 2
			k--
		}
		return [BigInt(m), 1n << BigInt(-k)]
	}
	const parse = (t: string): readonly [bigint, bigint] => {
		const [mantissa, exp = "0"] = Str.split(Str.toLowerCase(t), "e")
		const negative = Str.startsWith("-")(mantissa)
		const [int, frac = ""] = Str.split(Str.replace("-", "")(mantissa), ".")
		const e = Number(exp) - frac.length
		const c = BigInt(int + frac) * (negative ? -1n : 1n)
		return e >= 0 ? [c * 10n ** BigInt(e), 1n] : [c, 10n ** BigInt(-e)]
	}
	const [n, d] = parse(text)
	const cmp = (a: readonly [bigint, bigint], b: readonly [bigint, bigint]): number => {
		const l = a[0] * b[1]
		const r = b[0] * a[1]
		return l < r ? -1 : l > r ? 1 : 0
	}
	const step = (f: number, up: boolean): number => {
		const buf = new Float32Array([f])
		const bits = new Uint32Array(buf.buffer)
		const word = bits[0]
		if (word === undefined) {
			throw new Error("a Uint32Array of one word has a word")
		}
		bits[0] = word + (f >= 0 === up ? 1 : -1)
		const next = buf[0]
		if (next === undefined) {
			throw new Error("a Float32Array of one float has a float")
		}
		return next
	}
	const lower = step(candidate, false)
	const upper = step(candidate, true)
	/** Past the largest finite value the next "neighbour" is 2^128, so the midpoint is 2^128 - 2^103. */
	const edge = 2 ** 128 - 2 ** 103
	const midpoint = (a: number, b: number): number =>
		Number.isFinite(b) ? (a + b) / 2 : b > 0 ? edge : -edge
	const midLo = exactOf(midpoint(candidate, lower))
	const midHi = exactOf(midpoint(candidate, upper))
	const value: readonly [bigint, bigint] = [n, d]
	if (cmp(value, midHi) > 0) {
		return upper
	}
	if (cmp(value, midLo) < 0) {
		return lower
	}
	return candidate
}

/** A finite nonzero binary32 value: a magnitude from the least subnormal to the greatest finite value, and a sign. */
export const float32 = map(
	(source) => [source.draw(float(minSubnormal, floatMax)), source.draw(boolean)] as const,
	([magnitude, negative]) => (negative ? -magnitude : magnitude)
)

export type Binary32Feature = "a normal value" | "a subnormal value" | "a negative value"

export type RangeFeature = "normal" | "subnormal" | "overflow" | "underflow" | "zero"

/** A decimal text's value as an exact fraction: sign, digits, fraction digits and an exponent. */
const decimalRational = (text: string): readonly [bigint, bigint] => {
	const [mantissa, exponent = "0"] = Str.split(text, "e")
	const [whole, fraction = ""] = Str.split(Str.replace("-", "")(mantissa), ".")
	const e = Number(exponent) - fraction.length
	const n = BigInt(whole + fraction)
	return e >= 0 ? [n * 10n ** BigInt(e), 1n] : [n, 10n ** BigInt(-e)]
}

/**
 * Where a decimal falls among binary32's ranges once rounded to nearest, from its exact magnitude: zero, a nonzero
 * value at or below half the least subnormal (2^-150, which ties to the even zero), a subnormal below 2^-126, a normal
 * value, or one at or past the midpoint above the largest finite value (2^128 - 2^103).
 */
export const rangeOf = (text: string): RangeFeature => {
	const [n, d] = decimalRational(text)
	if (n === 0n) {
		return "zero"
	}
	if (n * 2n ** 150n <= d) {
		return "underflow"
	}
	if (n * 2n ** 126n < d) {
		return "subnormal"
	}
	if (n >= (2n ** 128n - 2n ** 103n) * d) {
		return "overflow"
	}
	return "normal"
}

export type MidpointFeature = "above" | "below" | "tie to the lower" | "tie to the upper"

const words = new DataView(new ArrayBuffer(8))

/** The bits of a binary32 value. */
export const bitsOf = (f: number): number => {
	words.setFloat32(0, f)
	return words.getUint32(0)
}

/** The next binary32 value above a finite positive one. */
export const nextUp = (f: number): number => {
	words.setUint32(0, bitsOf(f) + 1)
	return words.getFloat32(0)
}

/** A finite nonnegative binary64 value as an exact fraction m / 2^k. */
const exactRational = (v: number): readonly [bigint, bigint] => {
	words.setFloat64(0, v)
	const bits = words.getBigUint64(0)
	const exponent = Number((bits >> 52n) & 0x7ffn)
	const fraction = bits & ((1n << 52n) - 1n)
	const significand = exponent === 0 ? fraction : fraction | (1n << 52n)
	const e = (exponent === 0 ? 1 : exponent) - 1075
	return e >= 0 ? [significand << BigInt(e), 1n] : [significand, 1n << BigInt(-e)]
}

/** The exact midpoint of two binary32 values, as a fraction whose denominator is a power of two. */
export const exactMidpoint = (f: number, g: number): readonly [bigint, bigint] => {
	const [fn, fd] = exactRational(f)
	const [gn, gd] = exactRational(g)
	return [fn * gd + gn * fd, 2n * fd * gd]
}

/** The exact decimal text of n / d, d a product of powers of two and five. */
export const numericText = (n: bigint, d: bigint): string => {
	let digits = 0
	let unit = 1n
	while (unit % d !== 0n) {
		unit *= 10n
		digits++
	}
	const scaled = pipe((n * (unit / d)).toString(), Str.padStart(digits + 1, "0"))
	return digits === 0 ? scaled : `${Str.slice(0, -digits)(scaled)}.${Str.slice(-digits)(scaled)}`
}

/** A decimal text: digits under an exponent, or a zero of a few fraction digits under one. */
export const decimal = weighted([
	[
		9,
		map(
			(source) => ({
				negative: source.draw(boolean),
				digits: source.draw(matching(regex("^[1-9]\\d{0,24}$"))),
				exponent: source.draw(int(-75, 45))
			}),
			({ negative, digits, exponent }) => `${negative ? "-" : ""}${digits}e${exponent}`
		)
	],
	[
		1,
		map(
			(source) => ({
				negative: source.draw(boolean),
				zeros: source.draw(int(1, 4)),
				exponent: source.draw(int(-60, 30))
			}),
			({ negative, zeros, exponent }) =>
				`${negative ? "-" : ""}0.${Str.repeat(zeros)("0")}e${exponent}`
		)
	]
])

/**
 * The grammar the scanner implements, as a reference: sign, digits, an optional fraction, an exponent of at most
 * six digits. Tests may use RegExp; src may not. Beside it, the three special values PostgreSQL writes for real
 * and double precision (a vector component is finite, so never one), and the strtod spellings it never writes.
 */
export const grammar = regex("^-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,6})?$")
export const specials: ReadonlyMap<string, number> = new Map([
	["NaN", Number.NaN],
	["Infinity", Number.POSITIVE_INFINITY],
	["-Infinity", Number.NEGATIVE_INFINITY]
])
export const strtodSpellings: Arr.NonEmptyReadonlyArray<string> = [
	"inf",
	"nan",
	"INF",
	"+Infinity",
	"infinity",
	"-inf",
	"+NaN",
	"-NaN",
	"1_0",
	"١",
	"٣.٥",
	"Inf"
]
export const syntax = (result: ReturnType<typeof strictDouble>): boolean =>
	result._tag === "Success" || result.failure !== "floatSyntax"
export const texts = weighted([
	[8, string(element(Str.split("0123456789.eE+-x ", "")), { min: 0, max: 14 })],
	[1, element(nonEmpty(Arr.fromIterable(specials.keys()), "the specials"))],
	[1, element(strtodSpellings)]
])

/** Every finite double, and now and then a zero of either sign, NaN or an infinity. */
export const doubles = weighted([
	[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
	[1, element([0, -0])],
	[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
])
