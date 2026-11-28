/** What the properties of conjunction.test.ts read: its spaces, models and helpers. */

import { has } from "@bjornpagen/grizzle-text/regex/charset"
import type { CanonicalDfa } from "@bjornpagen/grizzle-text/regex/dfa"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import type { Patterns, PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { codePoints } from "@bjornpagen/grizzle-text/text"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Option } from "effect"
import { jsMatcher } from "#test/support/regex.ts"
import {
	families,
	type Family,
	finiteLanguageOver,
	flagsGen,
	mostFiniteMembers,
	patternOver,
	stringsOver,
	walkGen
} from "#test/support/unit/text/generators.ts"

/**
 * A member of a drawn conjunction: one of its family's own patterns, one generated over its alphabet, or a finite
 * language over it, which the generated ones rarely spell.
 */
const memberGen =
	(family: Family): Gen<PatternSource> =>
	(source) => {
		const origin = source.draw(element(["written", "generated", "finite"] as const))
		if (origin === "written" && Arr.isReadonlyArrayNonEmpty(family.patterns)) {
			const [written, flags] = source.draw(element(family.patterns))
			return { source: written, flags }
		}
		return {
			source:
				origin === "finite"
					? source.draw(finiteLanguageOver(family.alphabet, mostFiniteMembers)).source
					: source.draw(patternOver(family.alphabet)),
			flags: source.draw(flagsGen)
		}
	}

/** A drawn case: a family, two or three patterns of it, and texts over its alphabet and each member's walks. */
interface ConjunctionCase {
	readonly family: string
	readonly patterns: Patterns
	readonly texts: ReadonlyArray<string>
}

export const caseGen: Gen<ConjunctionCase> = (source) => {
	const family = source.draw(element(families))
	const patterns: Patterns = [
		source.draw(memberGen(family)),
		source.draw(memberGen(family)),
		...source.draw(array(memberGen(family), { min: 0, max: 1 }))
	]
	const walks = Arr.flatMap(patterns, (p) => {
		const parsed = parsePattern(p.source, p.flags)
		return parsed.ok && parsed.value.kind !== "never"
			? Arr.flatMap(source.draw(array(walkGen(buildNfa(parsed.value)), { min: 0, max: 12 })), (w) =>
					w === undefined ? [] : [w]
				)
			: []
	})
	return {
		family: family.name,
		patterns,
		texts: [
			...source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 120 })),
			...walks
		]
	}
}

/** Whether ECMAScript finds every member of a conjunction in a text, each member compiled once. */
export const jsAll = (patterns: ReadonlyArray<PatternSource>): ((text: string) => boolean) => {
	const matchers = Arr.map(patterns, (p) => jsMatcher(p.source, p.flags))
	return (text) => Arr.every(matchers, (m) => m(text))
}

/** Whether a canonical DFA, which reads whole values, accepts `text`. */
export const dfaAccepts = (dfa: CanonicalDfa, text: string): boolean =>
	Option.exists(
		Arr.reduce(codePoints(text), Arr.head(dfa.states), (state, c) =>
			Option.flatMap(state, (s) =>
				Option.flatMap(
					Arr.findFirst(s.edges, (e) => has(e.set, c)),
					(e) => Arr.get(dfa.states, e.to)
				)
			)
		),
		(s) => s.accept
	)

export const truth = (value: unknown): boolean => {
	if (value === "true") {
		return true
	}
	if (value === "false") {
		return false
	}
	throw new Error(`expected a boolean text, got ${String(value)}`)
}

export type ConjunctionFeature =
	| "a pair"
	| "a triple"
	| "a domain of several patterns"
	| "an IN list of the intersection"
	| "keyed by the intersection's automaton"
	| "a text the first member holds and the conjunction does not"
	| "a text of the conjunction"
	| "refused as matching no text"
