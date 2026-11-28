/** What the properties of integer-numeric.test.ts read: its spaces and the value model it restates. */

import { constant, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { bigint } from "@bjornpagen/testing/values"
import { String as Str } from "effect"
import { Numeric } from "#compiler/scalar/values/decimal.ts"

/** A numeric typmod over the whole box, scale 0 one draw in two: numeric(p, 0) is the integer one. */
export interface Typmod {
	readonly precision: number
	readonly scale: number
}

export const typmodGen: Gen<Typmod> = (source) => ({
	precision: source.draw(int(1, 1000)),
	scale: source.draw(
		weighted<number>([
			[2, constant(0)],
			[1, int(1, 1000)],
			[1, int(-1000, -1)]
		])
	)
})

/** Where a typmod's values lie: numeric(p, 0)'s are integers held as bigints, any other's are Decimals. */
export type ScaleFeature = "scale 0" | "a positive scale" | "a negative scale"

export const scaleFeatureOf = (scale: number): ScaleFeature =>
	scale === 0 ? "scale 0" : scale > 0 ? "a positive scale" : "a negative scale"

/** A value of a typmod's type, as numeric_out writes it, and the host value it is (`valueGen`). */
export interface Written {
	readonly text: string
	readonly value: Numeric | bigint
}

/**
 * numeric_out's text of `units` at `scale` (units · 10^-scale): at a positive scale the display scale's fraction
 * digits, at scale 0 the integer's digits, at a negative scale the integer with its -scale zeros; zero is never -0.
 */
const outputText = (units: bigint, scale: number): string => {
	const negative = units < 0n
	const magnitude = negative ? -units : units
	if (scale <= 0) {
		const digits = (magnitude * 10n ** BigInt(-scale)).toString()
		return negative ? `-${digits}` : digits
	}
	const digits = Str.padStart(scale + 1, "0")(magnitude.toString())
	const text = `${Str.slice(0, -scale)(digits)}.${Str.slice(-scale)(digits)}`
	return negative ? `-${text}` : text
}

/**
 * A value of numeric(p, s) with its output text: a count of 10^-s units below 10^p in magnitude, drawn over the whole
 * range, at its ends and among the small ones, or NaN, which a typmod but scale 0 holds. The value restates the host
 * type the value space gives (the model): numeric(p, 0)'s integer is its bigint, any other value its Numeric.
 */
export const valueGen = (typmod: Typmod): Gen<Written> => {
	const most = 10n ** BigInt(typmod.precision) - 1n
	const small = most < 1000n ? most : 1000n
	const units = weighted<bigint>([
		[3, bigint(-most, most)],
		[1, (source) => (source.draw(int(0, 1)) === 0 ? most : -most)],
		[2, bigint(-small, small)]
	])
	const finite: Gen<Written> = (source) => {
		const u = source.draw(units)
		const text = outputText(u, typmod.scale)
		return { text, value: typmod.scale === 0 ? u : Numeric.of(text) }
	}
	return typmod.scale === 0
		? finite
		: weighted<Written>([
				[5, finite],
				[1, (): Written => ({ text: "NaN", value: Numeric.nan })]
			])
}
