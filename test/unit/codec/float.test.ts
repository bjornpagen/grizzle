/**
 * Float text forms: the exact decimal-to-binary32 reading of real and vector component texts, which never double-rounds
 * a float32 midpoint, both the library's trusting conversion (values/float.ts) and the kernel's strict reading
 * (test/support/kernel/strict.ts), and the shortest round-trip writing.
 *
 * - Every finite nonzero binary32 value's shortest text, and its ECMAScript text, read back as the value, as a real and
 *   as a vector component. Oracle: an independent exact reading (decimalToBinary32Reference), rational comparison
 *   against the value's rounding interval.
 * - A decimal at or beside a binary32 midpoint reads once, ties to even; random decimals agree with the rational reading,
 *   and overflow and nonzero underflow are refused. Oracle: the decimal as an exact rational.
 * - The grammar: exactly the texts it admits are read, and the specials for double and real, never for a vector
 *   component; the strtod spellings beside it are named, refused cases.
 * - Every double round-trips through its shortest text, -0 as +0, NaN as NaN. Oracle: the round trip.
 *
 * Features: a value's binade (normal, subnormal) and sign; above, below and either tie of a midpoint; every range of a
 * random decimal; the grammar's admissions, refusals, specials and strtod spellings; a finite double, zero and a
 * special.
 *
 * Plants (~/.cache/grizzle-release/BR06/plants): float-ties-away (a midpoint rounded away from zero, not to even),
 * float-real-negative-infinity-lost (-Infinity read as Infinity) and float-text-sixteen-digits (a double written to
 * sixteen significant digits, not its shortest).
 */
import { describe, it } from "@effect/vitest"
import { drawn, explore } from "@grizzle/testing/explore"
import { required } from "@grizzle/testing/features"
import { boolean, element, int, map, string, weighted } from "@grizzle/testing/gen"
import { matching } from "@grizzle/testing/pattern"
import { notesOnly } from "@grizzle/testing/sense"
import { completeShrink } from "@grizzle/testing/shrink"
import { double, float } from "@grizzle/testing/values"
import { searched } from "@grizzle/testing/vitest"
import { regex } from "arkregex"
import { Array as Arr, Effect, Formatter, pipe, String as Str } from "effect"
import { floatText } from "#compiler/scalar/values/float.ts"
import { convertComponent, convertDouble, convertReal } from "#compiler/scalar/values/float.ts"
import { assert, faulted, nonEmpty, succeeded } from "#test/support/assert.ts"
import { strictComponent, strictDouble, strictReal } from "#test/support/kernel/strict.ts"
import { caseHang } from "#test/support/limits.ts"
const floatMax = 3.4028234663852886e38
const minSubnormal = 2 ** -149

/**
 * The shortest decimal text naming a binary32 value, as PostgreSQL's float4out writes it: the fewest significant
 * digits whose strtof reading is the value. Built here independently, by trying 1..9 digits and reading each
 * candidate exactly through BigInt rational comparison against the value's rounding interval.
 */
const shortestFloat32Text = (f: number): string => {
	for (let digits = 1; digits <= 9; digits++) {
		const text = f.toPrecision(digits)
		if (Math.fround(Number(text)) === f && decimalToBinary32Reference(text) === f) {
			return text
		}
	}
	return f.toPrecision(9)
}

/** An independent exact reading: the decimal as a rational, compared against the two neighbouring midpoints. */
const decimalToBinary32Reference = (text: string): number => {
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
const float32 = map(
	(source) => [source.draw(float(minSubnormal, floatMax)), source.draw(boolean)] as const,
	([magnitude, negative]) => (negative ? -magnitude : magnitude)
)

type Binary32Feature = "a normal value" | "a subnormal value" | "a negative value"

type RangeFeature = "normal" | "subnormal" | "overflow" | "underflow" | "zero"

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
const rangeOf = (text: string): RangeFeature => {
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

type MidpointFeature = "above" | "below" | "tie to the lower" | "tie to the upper"

const words = new DataView(new ArrayBuffer(8))

/** The bits of a binary32 value. */
const bitsOf = (f: number): number => {
	words.setFloat32(0, f)
	return words.getUint32(0)
}

/** The next binary32 value above a finite positive one. */
const nextUp = (f: number): number => {
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
const exactMidpoint = (f: number, g: number): readonly [bigint, bigint] => {
	const [fn, fd] = exactRational(f)
	const [gn, gd] = exactRational(g)
	return [fn * gd + gn * fd, 2n * fd * gd]
}

/** The exact decimal text of n / d, d a product of powers of two and five. */
const decimalText = (n: bigint, d: bigint): string => {
	let digits = 0
	let unit = 1n
	while (unit % d !== 0n) {
		unit *= 10n
		digits++
	}
	const scaled = pipe((n * (unit / d)).toString(), Str.padStart(digits + 1, "0"))
	return digits === 0 ? scaled : `${Str.slice(0, -digits)(scaled)}.${Str.slice(-digits)(scaled)}`
}

describe("exact binary32 reading", () => {
	it.effect("reads every binary32 value's shortest text back to that value", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "second-implementation",
						name: "an exact rational reading against the value's rounding interval"
					},
					suite: "unit/codec/float-1714631201",
					draw: drawn(float32),
					literal: Formatter.format,
					coverage: required<Binary32Feature>(
						["a normal value", "a subnormal value", "a negative value"],
						{ cases: 500, sense: notesOnly }
					),
					kept: [],
					runs: 5000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(f, c) =>
					Effect.sync(() => {
						c.note(Math.abs(f) < 2 ** -126 ? "a subnormal value" : "a normal value")
						if (f < 0) {
							c.note("a negative value")
						}
						const text = shortestFloat32Text(f)
						assert.equal(succeeded(strictReal(text)), f)
						assert.equal(succeeded(strictReal(String(f))), f)
						assert.equal(convertReal(text), f)
						assert.equal(convertReal(String(f)), f)
						assert.equal(convertComponent(`[${text}]`, 1, text.length + 1), f)
					})
			)
		)
	)

	it.effect("reads a decimal at or beside a binary32 midpoint once, ties to even", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "specification",
						name: "the midpoint as an exact rational, ties to even"
					},
					suite: "unit/codec/float-midpoint",
					draw: drawn((source) => ({
						f: source.draw(float(minSubnormal, Math.fround(floatMax / 2))),
						negative: source.draw(boolean),
						side: source.draw(element(["at" as const, "above" as const, "below" as const]))
					})),
					literal: Formatter.format,
					coverage: required<MidpointFeature>(
						["above", "below", "tie to the lower", "tie to the upper"],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					/**
					 * The rotating stream's sample: each side is a third of the cases, and a tie's even neighbour is either
					 * with even odds.
					 */
					runs: 300,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				({ f, negative, side }, c) =>
					Effect.sync(() => {
						const g = nextUp(f)
						const [numerator, denominator] = exactMidpoint(f, g)
						/**
						 * A nudge of 10^-20 of the midpoint's denominator's unit, far inside half the spacing, 1 / denominator.
						 */
						const scale = 10n ** 20n
						const nudge = side === "above" ? 1n : side === "below" ? -1n : 0n
						const text = `${negative ? "-" : ""}${decimalText(numerator * scale + nudge, denominator * scale)}`
						const lowerEven = (bitsOf(f) & 1) === 0
						const nearer = side === "above" ? g : side === "below" ? f : lowerEven ? f : g
						const expected = negative ? -nearer : nearer
						c.note(side !== "at" ? side : lowerEven ? "tie to the lower" : "tie to the upper")
						assert.equal(succeeded(strictReal(text)), expected, text)
						assert.equal(convertReal(text), expected, text)
					})
			)
		)
	)

	it.effect(
		"agrees with an independent rational reading on random decimals, and refuses overflow and nonzero underflow",
		(ctx) =>
			Effect.gen(function* () {
				const decimal = weighted([
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
				yield* searched(
					ctx,
					explore(
						{
							oracle: {
								kind: "second-implementation",
								name: "the decimal as an exact rational, rounded to nearest by hand"
							},
							suite: "unit/codec/float-1918989417",
							draw: drawn(decimal),
							literal: Formatter.format,
							coverage: required<RangeFeature>(
								["normal", "subnormal", "overflow", "underflow", "zero"],
								{ cases: 5000, sense: notesOnly }
							),
							kept: [],
							/**
							 * The rotating stream's sample: overflow and underflow are each about one exponent in eight.
							 */
							runs: 5000,
							shrink: completeShrink,
							concurrency: 1,
							steerEvery: 16,
							caseHang
						},
						(text, c) =>
							Effect.sync(() => {
								const range = rangeOf(text)
								c.note(range)
								switch (range) {
									case "overflow":
									case "underflow":
										faulted(strictReal(text), "floatRange", text)
										return
									case "zero":
										assert.ok(Object.is(succeeded(strictReal(text)), 0), text)
										assert.ok(Object.is(convertReal(text), 0), text)
										return
									case "normal":
									case "subnormal":
										assert.equal(
											succeeded(strictReal(text)),
											decimalToBinary32Reference(text),
											text
										)
										assert.equal(convertReal(text), decimalToBinary32Reference(text), text)
										return
								}
							})
					)
				)
			})
	)
})

describe("the float text grammar, scanned without RegExp", () => {
	/**
	 * The grammar the scanner implements, as a reference: sign, digits, an optional fraction, an exponent of at most
	 * six digits. Tests may use RegExp; src may not. Beside it, the three special values PostgreSQL writes for real
	 * and double precision (a vector component is finite, so never one), and the strtod spellings it never writes.
	 */
	const grammar = regex("^-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d{1,6})?$")
	const specials: ReadonlyMap<string, number> = new Map([
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["-Infinity", Number.NEGATIVE_INFINITY]
	])
	const strtodSpellings: Arr.NonEmptyReadonlyArray<string> = [
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
	const syntax = (result: ReturnType<typeof strictDouble>): boolean =>
		result._tag === "Success" || result.failure !== "floatSyntax"
	const texts = weighted([
		[8, string(element(Str.split("0123456789.eE+-x ", "")), { min: 0, max: 14 })],
		[1, element(nonEmpty(Arr.fromIterable(specials.keys()), "the specials"))],
		[1, element(strtodSpellings)]
	])

	it.effect(
		"admits exactly the texts the grammar admits, and the specials for double and real, never for a vector component",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						oracle: {
							kind: "specification",
							name: "the text grammar, and the specials each reader admits"
						},
						suite: "unit/codec/float-7497063",
						draw: drawn(texts),
						literal: Formatter.format,
						coverage: required<
							"grammar admits" | "grammar refuses" | "special" | "strtod spelling"
						>(["grammar admits", "grammar refuses", "special", "strtod spelling"], {
							cases: 20000,
							sense: notesOnly
						}),
						kept: [],
						runs: 20000,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					(text, c) =>
						Effect.sync(() => {
							const special = specials.get(text)
							if (special !== undefined) {
								c.note("special")
								assert.ok(Object.is(succeeded(strictDouble(text)), special), text)
								assert.ok(Object.is(succeeded(strictReal(text)), special), text)
								assert.ok(Object.is(convertReal(text), special), text)
								faulted(strictComponent(text), "floatSyntax", text)
								return
							}
							const expected = grammar.test(text)
							c.note(
								strtodSpellings.includes(text)
									? "strtod spelling"
									: expected
										? "grammar admits"
										: "grammar refuses"
							)
							assert.equal(syntax(strictDouble(text)), expected)
							assert.equal(syntax(strictReal(text)), expected)
							assert.equal(syntax(strictComponent(text)), expected)
							if (expected && Number.isFinite(Number(text))) {
								assert.equal(
									Object.is(succeeded(strictDouble(text)), Number(text) === 0 ? 0 : Number(text)),
									true
								)
							}
						})
				)
			)
	)
})

describe("double precision text", () => {
	it.effect("round-trips every binary64 value through its shortest text, -0 as +0", (ctx) =>
		searched(
			ctx,
			explore(
				{
					oracle: {
						kind: "universal",
						name: "a double's shortest text reads back as the double, -0 as +0"
					},
					suite: "unit/codec/float-6578796",
					/** Every finite double, and now and then a zero of either sign, NaN or an infinity. */
					draw: drawn(
						weighted([
							[8, double(-Number.MAX_VALUE, Number.MAX_VALUE)],
							[1, element([0, -0])],
							[1, element([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])]
						])
					),
					literal: Formatter.format,
					coverage: required<"a finite double" | "zero" | "a special">(
						["a finite double", "zero", "a special"],
						{ cases: 500, sense: notesOnly }
					),
					kept: [],
					runs: 10000,
					shrink: completeShrink,
					concurrency: 1,
					steerEvery: 16,
					caseHang
				},
				(x, c) =>
					Effect.sync(() => {
						c.note(!Number.isFinite(x) ? "a special" : x === 0 ? "zero" : "a finite double")
						const readsBack = (back: number) => {
							if (Number.isNaN(x)) {
								assert.equal(Number.isNaN(back), true)
							} else {
								assert.equal(Object.is(back, x === 0 ? 0 : x), true)
							}
						}
						const text = floatText(x)
						const strict = succeeded(strictDouble(text))
						readsBack(strict)
						readsBack(convertDouble(text))
					})
			)
		)
	)
})
