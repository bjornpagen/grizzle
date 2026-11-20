/** What the property of xsd-counts.test.ts reads: its space of XML Schema patterns of counts past 255, and their texts. */

import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"

/** What a case reached: which count passes 255, a nested count, and texts the pattern holds and does not. */
export type CountsFeature =
	| "a least count past 255"
	| "a greatest count past 255"
	| "an unbounded greatest"
	| "a nested count"
	| "a text the pattern holds"
	| "a text the pattern does not hold"

/** The body a count repeats: a character, a class of two, or a group of two characters, and a word of it. */
interface Body {
	readonly xsd: string
	readonly word: Gen<string>
}

const bodies: Arr.NonEmptyReadonlyArray<Body> = [
	{ xsd: "a", word: () => "a" },
	{ xsd: "[ab]", word: element(["a", "b"]) },
	{ xsd: "(ab)", word: () => "ab" }
]

/**
 * An XML Schema pattern of a body repeated `x{m,n}`, `x{m}` or `x{m,}` with a count past 255, as a whole or inside a
 * group repeated two or three times, which multiplies its counts; and texts of whole words of the body at the counts'
 * edges, each word count the least's, the greatest's, and one either side, with a text one code point off a word.
 */
export interface CountsCase {
	readonly pattern: string
	/** The count past 255 a raw ARE states, which PostgreSQL refuses. */
	readonly past: number
	readonly texts: Arr.NonEmptyReadonlyArray<string>
	readonly features: ReadonlyArray<CountsFeature>
}

export const countsCaseGen: Gen<CountsCase> = (source) => {
	const body = source.draw(element(bodies))
	const which = source.draw(element(["least", "greatest", "unbounded"] as const))
	const min = which === "greatest" ? source.draw(int(0, 255)) : source.draw(int(256, 600))
	const max: number | "unbounded" =
		which === "unbounded"
			? "unbounded"
			: which === "greatest"
				? source.draw(int(256, 600))
				: min + source.draw(int(0, 300))
	const quantifier =
		max === "unbounded" ? `{${min},}` : max === min ? `{${min}}` : `{${min},${max}}`
	const outer = source.draw(boolean) ? source.draw(int(2, 3)) : 1
	const piece = `${body.xsd}${quantifier}`
	const pattern = outer === 1 ? piece : `(${piece}){${outer}}`
	const least = outer * min
	const greatest = max === "unbounded" ? least + outer : outer * max
	const words = (count: number): string =>
		Arr.join(source.draw(array(body.word, { min: count, max: count })), "")
	const counts = Arr.dedupe(
		Arr.filter([least - 1, least, least + 1, greatest, greatest + 1], (c) => c >= 0)
	)
	const texts: Arr.NonEmptyReadonlyArray<string> = [`${words(least)}c`, ...Arr.map(counts, words)]
	return {
		pattern,
		past: max === "unbounded" || which === "least" ? min : max,
		texts,
		features: [
			which === "least"
				? "a least count past 255"
				: which === "greatest"
					? "a greatest count past 255"
					: "an unbounded greatest",
			...(outer === 1 ? [] : ["a nested count" as const])
		]
	}
}

/** A case as it prints: its pattern and its texts' lengths. */
export const showCounts = (c: CountsCase): string =>
	`${c.pattern} over texts of ${Arr.join(
		Arr.map(c.texts, (t) => `${Str.length(t)}`),
		", "
	)} code units`
