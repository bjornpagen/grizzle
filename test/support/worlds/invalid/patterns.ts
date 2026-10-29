import { Array as Arr, String as Str } from "effect"
import { knownNonEmpty } from "#test/support/worlds/generate/domain.ts"
import type { TextDomain } from "#test/support/worlds/model/text.ts"

import { regex } from "arkregex"
/** One edge string of a pattern, and whether the pattern, read as JavaScript reads it, admits it. */
export interface PatternEdge {
	readonly value: string
	readonly admitted: boolean
	readonly edge: EdgeKind
}

/** How an edge string departs from a string the pattern admits. */
export type EdgeKind =
	| "empty"
	| "trailing-newline"
	| "leading-newline"
	| "padded"
	| "upper"
	| "lower"
	| "doubled"
	| "shortened"
	| "lengthened"
	| "lookalike"
	| "decomposed"
	| "zero-width"
	| "combining-mark"
	| "carriage-return"
	| "very-long"

/** Letters and their Cyrillic or Greek lookalikes, which a pattern of ASCII classes refuses and a reader cannot tell apart. */
const lookalikes: Readonly<Record<string, string>> = {
	a: "а",
	e: "е",
	o: "о",
	p: "р",
	c: "с",
	x: "х",
	u: "υ",
	i: "і"
}

/** The string with its first lookalike-able letter replaced, or with a lookalike appended when none has one. */
const lookalike = (s: string): string => {
	for (const [i, ch] of Arr.fromIterable(s).entries()) {
		const swapped = lookalikes[Str.toLowerCase(ch)]
		if (swapped !== undefined) {
			return `${Arr.join(Arr.fromIterable(s).slice(0, i), "")}${swapped}${Arr.join(Arr.fromIterable(s).slice(i + 1), "")}`
		}
	}
	return `${s}а`
}

/** The edge strings of one admitted string: each a small departure a pattern's anchors, classes or bounds decide. */
const edgesOf = (s: string): ReadonlyArray<readonly [EdgeKind, string]> => [
	["empty", ""],
	["trailing-newline", `${s}\n`],
	["leading-newline", `\n${s}`],
	["padded", ` ${s} `],
	["upper", Str.toUpperCase(s)],
	["lower", Str.toLowerCase(s)],
	["doubled", `${s}${s}`],
	["shortened", Arr.join(Arr.fromIterable(s).slice(0, -1), "")],
	["lengthened", `${s}${Arr.fromIterable(s).at(-1) ?? "a"}`],
	["lookalike", lookalike(s)],
	["decomposed", Str.normalize("NFD")(`${s}é`)],
	["zero-width", `${s}​`],
	["combining-mark", `${s}́`],
	["carriage-return", `${s}\r\n`],
	["very-long", Str.repeat(512)(s)]
]

/**
 * A pattern's edge dictionary: every edge of every string of its pool, each classified by the pattern itself (never by
 * a test's idea of it), so the strings sit on both sides of the pattern's edge; PostgreSQL's regular expressions may
 * draw that edge elsewhere, which is the point.
 */
export const patternEdges = (text: TextDomain): Arr.NonEmptyReadonlyArray<PatternEdge> => {
	const compiled = regex.as(text.pattern, text.flags)
	const all: ReadonlyArray<readonly [EdgeKind, string]> = Arr.flatMap(text.pool, (s: string) =>
		edgesOf(s)
	)
	const edges = Arr.dedupeWith(all, (a, b) => a[1] === b[1])
	return knownNonEmpty(
		Arr.map(edges, ([edge, value]): PatternEdge => ({
			value,
			admitted: compiled.test(value),
			edge
		})),
		`the edge dictionary of /${text.pattern}/${text.flags}`
	)
}
