/** What the properties of served-matcher.test.ts read: its spaces, models and helpers. */

import type { PatternSource } from "@bjornpagen/grizzle-text/regex/parse"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { array, element, type Gen } from "@bjornpagen/testing/gen"
import { families, flagsGen, patternOver, stringsOver } from "#test/support/unit/text/generators.ts"

/** Drawn patterns over one family's alphabet, each with its flags, and texts over the alphabet to judge. */
interface Served {
	readonly patterns: ReadonlyArray<PatternSource>
	readonly texts: ReadonlyArray<string>
}

export const servedGen: Gen<Served> = (source) => {
	const family = source.draw(element(families))
	const patternGen: Gen<PatternSource> = (s) => ({
		source: s.draw(patternOver(family.alphabet)),
		flags: s.draw(flagsGen)
	})
	return {
		patterns: source.draw(array(patternGen, { min: 1, max: 4 })),
		texts: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 16 }))
	}
}

/** Whether a pattern is one an admission passes on to a table: it parses, and some text matches it. */
export const tabled = (pattern: PatternSource): boolean => {
	const parsed = parsePattern(pattern.source, pattern.flags)
	return parsed.ok && parsed.value.kind !== "never"
}

export type Feature =
	| "a pattern under u"
	| "a pattern under su"
	| "a text matched"
	| "a text refused"
