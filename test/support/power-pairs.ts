import {
	array,
	boolean,
	codePoint,
	constant,
	type Gen,
	int,
	map,
	oneOf,
	string,
	weighted
} from "@grizzle/testing/gen"
import { keep, swarm } from "@grizzle/testing/swarm"
import { bigint } from "@grizzle/testing/values"
import { Array as Arr, String as Str } from "effect"
import { measured, type Limit } from "#compiler/core/limits.ts"

/**
 * The numeric powers the power suites draw (test/pg/compute/power.test.ts against PostgreSQL, and
 * test/unit/compute/power-work.test.ts against the oracle's work limit): a base and an exponent, each a decimal's text.
 */
export type Pair = readonly [string, string]

/** A string of `min` to `max` decimal digits. */
export const digitString = (min: number, max: number): Gen<string> =>
	string(codePoint(0x30, 0x39), { min, max })

const signed =
	(body: Gen<string>): Gen<string> =>
	(source) =>
		`${source.draw(
			weighted([
				[2, constant("")],
				[1, constant("-")]
			])
		)}${source.draw(body)}`

const fraction =
	(max: number): Gen<string> =>
	(source) => {
		const i = source.draw(int(0, 999))
		const f = source.draw(digitString(0, max))
		return f === "" ? `${i}` : `${i}.${f}`
	}

/** Bases: small decimals, values near one, wide magnitudes, small integers, and long significands. */
const bases: Gen<string> = oneOf([
	signed(fraction(24)),
	(source) => {
		const zeros = source.draw(int(1, 30))
		const tail = source.draw(digitString(1, 20))
		const above = source.draw(boolean)
		return above ? `1.${Str.repeat(zeros)("0")}${tail}` : `0.${Str.repeat(zeros)("9")}${tail}`
	},
	signed(
		(source) =>
			`${source.draw(int(1, 9))}.${source.draw(digitString(0, 12))}e${source.draw(int(-400, 400))}`
	),
	signed(map(int(2, 20), String)),
	signed((source) => `${source.draw(int(1, 99))}.${source.draw(digitString(30, 70))}`)
])

/**
 * Exponents: small integers (some with a display scale), int32 extremes, integers beyond int32, fractions with short
 * and long display scales, and tiny magnitudes.
 */
const exponents: Gen<string> = oneOf([
	map(int(-40, 40), String),
	(source) => `${source.draw(int(-12, 12))}.${Str.repeat(source.draw(int(1, 40)))("0")}`,
	map(int(-2147483648, 2147483647), String),
	map(bigint(2147483648n, 10n ** 15n), (n) => (n % 2n === 0n ? `${n}` : `-${n}`)),
	signed((source) => `${source.draw(int(0, 60))}.${source.draw(digitString(1, 30))}`),
	signed((source) => `${source.draw(int(0, 3))}.${source.draw(digitString(40, 60))}`),
	signed((source) => `${source.draw(int(1, 9))}e${source.draw(int(-40, -1))}`)
])

/**
 * PostgreSQL's bound on power_var for an exponent that is no integer (numeric.c): y · ln x below
 * NUMERIC_MAX_RESULT_SCALE · 3 = 6000, at which it raises 22003; in decimal weight, log10 x^y below 6000 / ln 10.
 */
const expLimitWeight = 6000 / Math.LN10

/**
 * A pair near that bound, where a proof that over-counts nothing meets PostgreSQL's own limit: a base of nine and a
 * long significand at a drawn power of ten, so its decimal weight is within a digit of its integer digits, and a
 * fractional exponent putting log10 x^y within one percent of the bound on either side; or the same weight reached by a
 * base below one and a negative exponent.
 */
const nearLimit: Gen<Pair> = (source) => {
	const k = source.draw(int(0, 400))
	const significand = `9.${source.draw(digitString(1, 12))}`
	const below = source.draw(boolean)
	const exponent = below ? -k - 1 : k
	const weight = Math.abs(Math.log10(Number(significand)) + exponent)
	const y = (expLimitWeight / weight) * (1 + source.draw(int(-100, 100)) / 10000)
	return [`${significand}e${exponent}`, (below ? -y : y).toFixed(9)]
}

/**
 * A batch's arms: ordinary pairs, a base drawn against an exponent, and pairs next to power_var's exp(6000) bound, the
 * one the proof meets PostgreSQL's limit at on its exponential path.
 */
const pairArms = ["ordinary", "near exp(6000)"] as const

/** The slots a batch gives pairs next to exp(6000), each kept as the case's swarm weighs the arm. */
const nearSlots = 4

/**
 * One case's powers, drawn under a swarm over the two arms (@grizzle/testing/swarm), so a case explores either alone or
 * both at its weights: up to 1000 ordinary pairs, and up to four next to exp(6000). The bound is one predicate of a
 * pair's weight, which each pair tests on one side or the other, so a few a case reach both sides (the suites require
 * each), while each costs about two hundred ordinary pairs to evaluate, a result of 2600 digits.
 */
export const powerBatch: Gen<PowerBatch> = (source) => {
	const on = source.draw(swarm(pairArms))
	const ordinaryPair: Gen<Pair> = (pair) => [pair.draw(bases), pair.draw(exponents)] as const
	return {
		ordinary: source.draw(keep(on, "ordinary"))
			? source.draw(array(ordinaryPair, { min: 1, max: 1000 }))
			: [],
		near: Arr.flatMap(
			Arr.makeBy(nearSlots, () => source.draw(keep(on, "near exp(6000)"))),
			(kept) => (kept ? [source.draw(nearLimit)] : [])
		)
	}
}

/** One case's powers: ordinary pairs, and pairs next to exp(6000). */
export interface PowerBatch {
	readonly ordinary: ReadonlyArray<Pair>
	readonly near: ReadonlyArray<Pair>
}

/**
 * The pairs every case runs: zeros, ones, signs, int32 and numeric limits, the special values, and the results that
 * reach a power of ten the proof bounds them by, x^0, 1^y and (10^-s)^-y, an integer digit past the bound's exponent.
 */
export const edges: ReadonlyArray<Pair> = [
	["0", "0"],
	["0", "1"],
	["0", "-1"],
	["0", "0.5"],
	["0", "-0.5"],
	["0.000", "3"],
	["2", "0"],
	["2.50", "0.000"],
	["2", "1"],
	["2.123456", "1"],
	["2", "-1"],
	["3", "-1"],
	["7", "-1.0"],
	["2", "2"],
	["1.5", "2"],
	["2", "10"],
	["2", "-10"],
	["10", "131071"],
	["10", "131072"],
	["10", "-1000"],
	["10", "-1001"],
	["10", "-1017"],
	["0.1", "2000"],
	["0.1", "-2"],
	["0.01", "-1"],
	["0.001", "-3.0"],
	["9999", "32768"],
	["-2", "3"],
	["-2", "4"],
	["-2", "-3"],
	["-2", "2147483647"],
	["-2", "2147483648"],
	["-1", "2147483649"],
	["-1", "9223372036854775808"],
	["-1.0000001", "4294967296"],
	["-8", "0.333333333333"],
	["-8", "1.5"],
	["1", "123456.789"],
	["1.000", "-0.5"],
	["4", "0.5"],
	["2", "0.5"],
	["2", "1e-30"],
	["1e-300", "0.5"],
	["1e300", "-0.5"],
	["1.00000000000000000001", "1e15"],
	["0.99999999999999999999", "1e18"],
	["123.456", "7.89"],
	["123.456", "-7.89"],
	["1.234567890123456789012345678901234567890123456789", "-7"],
	["1.234567890123456789012345678901234567890123456789", "-13"],
	[
		"3.14159265358979323846264338327950288419716939937510",
		"2.71828182845904523536028747135266249775724709369995"
	],
	["9999999999999999.99999999", "3"],
	["9999999999999999.99999999", "-3"],
	["0.00000000000000000000000000000001234567", "-5"],
	["1e-16383", "1"],
	["1e-16383", "0.5"],
	["NaN", "0"],
	["NaN", "1"],
	["1", "NaN"],
	["2", "NaN"],
	["NaN", "NaN"],
	["Infinity", "2"],
	["Infinity", "-2"],
	["Infinity", "0"],
	["-Infinity", "3"],
	["-Infinity", "4"],
	["-Infinity", "-3"],
	["-Infinity", "2.5"],
	["2", "Infinity"],
	["0.5", "Infinity"],
	["2", "-Infinity"],
	["0.5", "-Infinity"],
	["-1", "Infinity"],
	["-1", "-Infinity"],
	["1", "Infinity"],
	["0", "Infinity"],
	["0", "-Infinity"],
	["-2", "Infinity"],
	["-0.5", "-Infinity"],
	["Infinity", "Infinity"],
	["-Infinity", "-Infinity"],
	["-2", "0.5"],
	["-Infinity", "0.5"]
]

/**
 * The costliest power the proof admits that the suites know: a base of one integer digit and a 70-digit significand to
 * the largest power its integer digits admit, whose result has numeric's integer digits less one. power_var_int
 * squares it at every working digit numeric's integer digits allow.
 */
export const costliest: Pair = [`9.${Str.repeat(70)("9")}`, "131071"]

/**
 * The most work the oracle's numeric power (test/support/oracle/evaluate/power.ts powerWork) may do for one power the
 * proof admits: its base-10000 digit operations, numeric.c's own, which PostgreSQL's power_var does for the same power.
 * A port that computes more of them than numeric.c's truncations keep, an exact product where mul_var truncates,
 * passes it.
 */
export const powerWorkLimit: Limit = measured({
	value: 2_000_000_000,
	owner: "grizzle's test oracle",
	unit: "base-10000 digit operations of one numeric power",
	scope:
		"one evaluation of numeric power by the oracle's port of numeric.c, over a pair the power suites draw that the proof admits",
	evidence:
		"a scratch measurement of powerWork over the power suites' edges and 40 cases of their batch generator (20 of the floor stream of pg/compute/power, 20 of a rotating stream), and over the integer path's admitted powers next to numeric's integer digits, on 2026-11-06",
	observed: "one run of each, at a load average near 60",
	environment:
		"macOS (Darwin 27.0.0, an arm64 virtual machine) on 10 cores, Node 26.13.0; the work is a count, so the machine and its load move only the time",
	workload:
		"7,037 powers of the edges and the 40 cases that the proof admits; 9.x^131071 and 99.x^65535 over significands of 10 to 72 digits; 1.x^2000000",
	result:
		"the drawn and edge powers at most 59,690,920 (9.7e-369^-7.026820952), next to the exponential bound about 41,500,000 (9.13e286^9.07); the integer path's 9.(70 nines)^131071 1,695,779,467, the most found, 9.(72 eights)^131071 1,691,680,195 and 99.x^65535 1,422,061,716; with mul_var's truncation dropped, 9.(70 nines)^131071 3,177,216,298",
	decision:
		"2,000,000,000 is 1.18 times the costliest power found, the proof admitting no exponent past numeric's integer digits over the base's own integer digits, and below the 3,177,216,298 the costliest power's exact products need, so an untruncated mul_var passes it there",
	revalidate:
		"a change to the port's digit accounting, to the proof's bounds on power, or to the generators' significands, exponents or arms"
})
