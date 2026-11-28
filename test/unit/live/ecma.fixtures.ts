/** What the properties of ecma.test.ts read: its spaces, models and helpers. */

import { type Aimed, aimed, array, element, type Gen, int } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, String as Str } from "effect"
import {
	families,
	type Flags,
	flagsGen,
	patternOver,
	stringsOver
} from "#test/support/unit/text/generators.ts"

export type Feature =
	| "a pattern under u"
	| "a pattern under su"
	| "a text matched"
	| "a text refused"
	| "a pattern of an astral code point"
	| "an end anchor beside a line feed"
	| "an end anchor matched after an astral code point"

/** A drawn pattern of one family's alphabet, its flags, and texts over the alphabet. */
interface PatternCase {
	readonly source: string
	readonly flags: Flags
	readonly alphabet: Arr.NonEmptyReadonlyArray<number>
	readonly texts: ReadonlyArray<string>
}

const caseGen: Gen<PatternCase> = (source) => {
	const family = source.draw(element(families))
	return {
		source: source.draw(patternOver(family.alphabet)),
		flags: source.draw(flagsGen),
		alphabet: family.alphabet,
		texts: source.draw(array(stringsOver(element(family.alphabet), 8), { min: 1, max: 12 }))
	}
}

/** The greatest code point the Basic Multilingual Plane holds. */
export const bmpLast = 0xffff

/** Whether `text` ends in a code point past the Basic Multilingual Plane. */
export const endsAstral = (text: string): boolean =>
	Option.exists(
		Option.flatMap(Arr.last(Arr.fromIterable(text)), Str.codePointAt(0)),
		(cp) => cp > bmpLast
	)

/**
 * A pattern of a letter its end anchor follows, beside a text of the letter and a line feed, which the anchor refuses
 * under `u` (no `m`): `$` is the end of the text alone, never a position before a line terminator.
 */
const lineFeedGen: Gen<PatternCase> = (source) => {
	const family = source.draw(element(families))
	const letter = String.fromCodePoint(source.draw(int(0x61, 0x7a)))
	return {
		source: `${letter}$`,
		flags: source.draw(flagsGen),
		alphabet: family.alphabet,
		texts: [
			`${letter}\n`,
			...source.draw(array(stringsOver(element(family.alphabet), 8), { min: 0, max: 11 }))
		]
	}
}

/**
 * `.$` beside a text ending in an astral code point, which it matches: V8's unanchored search of a class at an end
 * anchor judges such a text unmatched under `u`, so the printed pattern must anchor its start.
 */
const astralEndGen: Gen<PatternCase> = (source) => {
	const family = source.draw(element(families))
	const prefix = source.draw(stringsOver(element(family.alphabet), 7))
	return {
		source: ".$",
		flags: source.draw(flagsGen),
		alphabet: family.alphabet,
		texts: [
			`${prefix}${String.fromCodePoint(source.draw(int(0x1_0000, 0x10_ffff)))}`,
			...source.draw(array(stringsOver(element(family.alphabet), 8), { min: 0, max: 11 }))
		]
	}
}

/**
 * Patterns of a family's alphabet, aimed while pending at an end anchor beside a line feed and at one matched after an
 * astral code point.
 */
export const patternSpace: Aimed<PatternCase, Feature> = aimed(caseGen, [
	["an end anchor beside a line feed", lineFeedGen],
	["an end anchor matched after an astral code point", astralEndGen]
])
