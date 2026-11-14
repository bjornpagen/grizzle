import { matching } from "@bjornpagen/testing/pattern"
import { floorSeed } from "@bjornpagen/testing/random"
import { sample } from "@bjornpagen/testing/source"
import { Array as Arr, String as Str } from "effect"
import { compiledPattern } from "#test/support/regex.ts"
import type { FieldDomain } from "#test/support/worlds/model/types.ts"

/** A text domain of a base: its pattern, its flags and its pool. */
export type TextDomain = Extract<FieldDomain, { readonly kind: "text" }>

/** How many values a text pool holds: few, so facts meet each other and the claims. */
const poolSize = 4

/** The longest run an unbounded repetition of a pattern draws for its pool. */
const poolRun = 8

/** Whether either text holds the other: two pool values one search could confuse. */
const overlapping = (a: string, b: string): boolean => Str.includes(b)(a) || Str.includes(a)(b)

/**
 * The pattern with every unbounded repetition outside a class and an escape (`*`, `+`) bounded at `poolRun`: every
 * string it matches the pattern matches, and a generator can draw from it, where a repetition without a bound cannot
 * be drawn whole.
 */
const boundedFor = (pattern: string): string => {
	let bounded = ""
	let escaped = false
	let inClass = false
	for (const point of pattern) {
		if (escaped) {
			escaped = false
			bounded += point
		} else if (point === "\\") {
			escaped = true
			bounded += point
		} else if (inClass) {
			inClass = point !== "]"
			bounded += point
		} else if (point === "[") {
			inClass = true
			bounded += point
		} else {
			bounded += point === "*" ? `{0,${poolRun}}` : point === "+" ? `{1,${poolRun}}` : point
		}
	}
	return bounded
}

/**
 * The text domain of `pattern` and `flags`, its pattern compiled and its pool drawn as the domain is built: strings the
 * pattern admits (an unbounded repetition drawn at most `poolRun` long), drawn from the pattern's own fixed stream, so
 * every process draws the same pool, none holding another.
 */
export const textDomain = (pattern: string, flags: "u" | "su"): TextDomain => {
	const matcher = compiledPattern(pattern, flags)
	const [first, ...rest] = sample(
		matching(compiledPattern(boundedFor(pattern), flags)),
		floorSeed(`worlds text pool /${pattern}/${flags}`),
		64
	)
	if (first === undefined) {
		throw new Error(`the pattern /${pattern}/${flags}'s draws: none`)
	}
	const kept: Array<string> = [first]
	for (const s of rest) {
		if (kept.length < poolSize && !Arr.some(kept, (k) => overlapping(k, s))) {
			kept.push(s)
		}
	}
	return { kind: "text", pattern, flags, matcher, pool: [first, ...kept.slice(1)] }
}
