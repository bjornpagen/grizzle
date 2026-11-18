/** What the property of escape.test.ts reads: its space, the host's reading of an escape, and the features of a case. */

import type { Reached } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"

/**
 * The runs a case's texts are made of: the characters sql/escape.ts escapes (C0 and C1 controls, DEL, the line and
 * paragraph separators), the backslash it doubles and a backslash before an escape's letter, and characters of one, two
 * and four UTF-8 bytes, a surrogate pair's halves the window must keep together.
 */
const runs = [
	"\r",
	"\n",
	"\t",
	"\b",
	"\f",
	"\u0001",
	"\u001f",
	"\u007f",
	"\u0085",
	"\u2028",
	"\u2029",
	"\\",
	"\\r",
	"'",
	"a",
	"b",
	" ",
	"é",
	"😀",
	"🙂"
] as const

/** How far from the difference a case's texts reach for it to call them long: past the window on both sides. */
const longUnits = 512

const shortText: Gen<string> = (source) =>
	Arr.join(source.draw(array(element(runs), { min: 0, max: 12 })), "")

const longText: Gen<string> = (source) => {
	const unit = `${source.draw(shortText)}x`
	return Str.repeat(Math.ceil(source.draw(int(longUnits, 2 * longUnits)) / unit.length))(unit)
}

const side: Gen<string> = weighted([
	[3, shortText],
	[1, longText]
])

/**
 * Two texts that differ: a shared prefix, then each its own rest, which begin with different runs where both have one;
 * one rest may be empty, so one text is a prefix of the other.
 */
export interface Pair {
	readonly first: string
	readonly second: string
}

/** The runs another run may differ from: neither a prefix of the other, so the texts part at the first of them. */
const apart = (one: (typeof runs)[number]): Arr.NonEmptyReadonlyArray<(typeof runs)[number]> => {
	const others = Arr.filter(runs, (r) => !Str.startsWith(r)(one) && !Str.startsWith(one)(r))
	return Arr.isReadonlyArrayNonEmpty(others) ? others : ["a"]
}

export const pairGen: Gen<Pair> = (source) => {
	const prefix = source.draw(side)
	const one = source.draw(element(runs))
	const other = source.draw(element(apart(one)))
	const ends = source.draw(element(["both", "first", "second"] as const))
	const restOf = (lead: string) => `${lead}${source.draw(side)}`
	return {
		first: `${prefix}${ends === "second" ? "" : restOf(one)}`,
		second: `${prefix}${ends === "first" ? "" : restOf(other)}`
	}
}

/** An escape as the host reads it, as PostgreSQL's escape strings do (sql-syntax 4.1.2.2), by the letter after its
 * backslash: a backslash, and \b \t \n \f \r by name. */
const named: Readonly<Record<string, string>> = {
	"\\": "\\",
	b: "\b",
	t: "\t",
	n: "\n",
	f: "\f",
	r: "\r"
}

/**
 * A shown window read back: its ellipses, at either end, apart, and its text with each escape read as the host reads
 * sql/escape.ts's escapes, as PostgreSQL's escape strings read them: \uXXXX its code unit, any other by its letter.
 */
export const readBack = (
	shown: string
): { readonly before: boolean; readonly text: string; readonly after: boolean } => {
	const before = Str.startsWith("…")(shown)
	const after = Str.endsWith("…")(shown)
	const units = Array.from(
		Str.slice(before ? 1 : 0, after ? shown.length - 1 : shown.length)(shown)
	)
	let text = ""
	for (let k = 0; k < units.length; k++) {
		const ch = units[k] ?? ""
		const next = units[k + 1] ?? ""
		if (ch !== "\\") {
			text += ch
		} else if (next === "u") {
			text += String.fromCharCode(Number.parseInt(Arr.join(units.slice(k + 2, k + 6), ""), 16))
			k += 5
		} else {
			text += named[next] ?? next
			k += 1
		}
	}
	return { before, text, after }
}

/** Whether a character is one the report escapes: a C0 or C1 control, DEL, or a line or paragraph separator. */
const isInvisible = (ch: string): boolean =>
	ch <= "\u001f" || (ch >= "\u007f" && ch <= "\u009f") || ch === "\u2028" || ch === "\u2029"

/** Whether a text holds a character the report must escape. */
export const holdsInvisible = (t: string): boolean => Arr.some(Array.from(t), isInvisible)

/** What a case reaches. */
export type ShownFeature =
	| "a carriage return at the difference"
	| "a control character in a window"
	| "a backslash in a window"
	| "an astral character before the difference"
	| "a window cut before"
	| "a window cut after"
	| "one text a prefix of the other"

export const shownFeatures = [
	"a carriage return at the difference",
	"a control character in a window",
	"a backslash in a window",
	"an astral character before the difference",
	"a window cut before",
	"a window cut after",
	"one text a prefix of the other"
] as const satisfies ReadonlyArray<Reached<ShownFeature>>

/** A case aimed at a pending feature: the run that reaches it placed where it does. */
const placed =
	(shape: (p: Pair, long: string) => Pair): Gen<Pair> =>
	(source) =>
		shape(source.draw(pairGen), source.draw(longText))

export const aims: ReadonlyArray<readonly [Reached<ShownFeature>, Gen<Pair>]> = [
	[
		"a carriage return at the difference",
		placed((p, long) => ({ first: `${long}\r${p.first}`, second: `${long}\n${p.second}` }))
	],
	[
		"a control character in a window",
		placed((p) => ({ first: `\u0085\t${p.first}x`, second: `\u0085\t${p.first}y` }))
	],
	[
		"a backslash in a window",
		placed((p) => ({ first: `\\r${p.first}x`, second: `\\r${p.first}y` }))
	],
	[
		"an astral character before the difference",
		placed((p) => ({ first: `😀${p.first}😀`, second: `😀${p.first}🙂` }))
	],
	[
		"a window cut before",
		placed((p, long) => ({ first: `${long}${p.first}x`, second: `${long}${p.first}y` }))
	],
	["a window cut after", placed((_, long) => ({ first: `x${long}`, second: `y${long}` }))],
	["one text a prefix of the other", placed((p) => ({ first: p.first, second: `${p.first}z` }))]
]
