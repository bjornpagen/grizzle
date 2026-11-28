/** What the properties of emptiness.test.ts read: its spaces, models and helpers. */

import type * as Engine from "@bjornpagen/grizzle-text/base/result"
import type { CharSet } from "@bjornpagen/grizzle-text/regex/charset"
import { regexDfaMaxStates, regexDfaMaxWork } from "@bjornpagen/grizzle-text/regex/limits"
import { buildNfa, follow, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern } from "@bjornpagen/grizzle-text/regex/parse"
import { codePointsText } from "@bjornpagen/grizzle-text/text"
import { assert, defined } from "@bjornpagen/testing/assert"
import {
	array,
	constant,
	element,
	type Gen,
	int,
	map,
	oneOf,
	shuffled,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import { refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import {
	families,
	finiteLanguageOver,
	type Flags,
	flagsGen,
	mostFiniteMembers,
	patternOver
} from "#test/support/unit/text/generators.ts"

export const loc = SourceLoc("str.regex", ["Content", "relations", "Article", "fields", "f"])

/** The private-use code points the marked spelling writes for `^` and for `$`: no family's alphabet holds either. */
const startMark = 0xf0000

const endMark = 0xf0001

/** Where a scan of a pattern's source stands: outside a class or inside one, each just after a backslash or not. */
type Scan = "plain" | "escaped" | "class" | "class escaped"

/**
 * The pattern with each anchor a group of two marks, `(?:\u{F0000}\u{F0000})` for `^` and `(?:\u{F0001}\u{F0001})` for
 * `$`: a pattern with no assertion, whose parse never drops a path for its anchors. Two marks, since an alternation
 * merges single code points into one class. A `^` that opens a class negates it and an escaped `\^` or `\$` is the
 * character, so neither is an anchor.
 */
const markedSpelling = (source: string): string => {
	let out = ""
	let scan: Scan = "plain"
	for (const ch of source) {
		switch (scan) {
			case "plain":
				if (ch === "^" || ch === "$") {
					const mark = (ch === "^" ? startMark : endMark).toString(16)
					out += `(?:\\u{${mark}}\\u{${mark}})`
				} else {
					out += ch
					scan = ch === "\\" ? "escaped" : ch === "[" ? "class" : "plain"
				}
				break
			case "escaped":
				out += ch
				scan = "plain"
				break
			case "class":
				out += ch
				scan = ch === "\\" ? "class escaped" : ch === "]" ? "plain" : "class"
				break
			case "class escaped":
				out += ch
				scan = "class"
				break
		}
	}
	return out
}

type Edge = Nfa["edges"][number][number]

/** Whether a set is the one code point `c`. */
const isOnly = (set: CharSet, c: number): boolean => {
	const [only, ...rest] = set
	return only !== undefined && rest.length === 0 && only[0] === c && only[1] === c
}

/** An edge of the marked spelling's NFA as the pattern's: a mark's edge is its anchor's. */
const unmarked = (e: Edge): Edge =>
	e.kind === "set" && isOnly(e.set, startMark)
		? { kind: "start", to: e.to, counts: e.counts }
		: e.kind === "set" && isOnly(e.set, endMark)
			? { kind: "end", to: e.to, counts: e.counts }
			: e

/** The pattern's NFA with every path its spelling makes, built from the marked spelling's parse (markedSpelling). */
export const patternNfa = (source: string, flags: Flags): Nfa => {
	const ir = succeeded(
		parsePattern(markedSpelling(source), flags),
		`/${source}/${flags} spelled with marks`
	)
	const nfa = buildNfa(ir)
	return { ...nfa, edges: Arr.map(nfa.edges, (edges) => Arr.map(edges, unmarked)) }
}

/**
 * A state of the search: an NFA configuration, its state and its repetitions' counters (nfa.ts CountOp), whether a code
 * point has been consumed and a `$` passed on the way, whether the way broke walk's rules (a `^` after a code point, or
 * a code point after a `$`), and the step it came by.
 */
interface Reached {
	readonly state: number
	readonly counters: ReadonlyArray<number>
	readonly consumed: boolean
	readonly ended: boolean
	readonly broken: boolean
	readonly via: Reached | undefined
	readonly point: number | undefined
}

/** The text a way spells: the code points its steps consumed, in order. */
const spelled = (end: Reached): string => {
	const points: Array<number> = []
	for (let at: Reached | undefined = end; at !== undefined; at = at.via) {
		if (at.point !== undefined) {
			points.push(at.point)
		}
	}
	return codePointsText(Arr.reverse(points))
}

/**
 * Where an edge leads from `r`, none where its counters block it: an ε edge as it is, a `^` or `$` edge by walk's rules,
 * a set edge on its least code point.
 */
const step = (nfa: Nfa, r: Reached, e: Edge): Reached | undefined => {
	const counters = follow(nfa, r.counters, e.counts)
	if (counters === undefined) {
		return undefined
	}
	const next = { ...r, state: e.to, counters, via: r, point: undefined }
	switch (e.kind) {
		case "eps":
			return next
		case "start":
			return { ...next, broken: r.broken || r.consumed }
		case "end":
			return { ...next, ended: true }
		case "set":
			return {
				...next,
				consumed: true,
				broken: r.broken || r.ended,
				point: defined(e.set[0], "a set edge's code point")[0]
			}
	}
}

/**
 * The search: a text an accepting way spells within walk's rules, a member of the pattern's language, and one an
 * accepting way spells only by breaking them, each undefined when there is no such way.
 */
export const searchOf = (
	nfa: Nfa
): { readonly member: string | undefined; readonly broken: string | undefined } => {
	const seen = new Set<string>()
	const ways: Array<Reached> = []
	const visit = (r: Reached | undefined): void => {
		if (r === undefined) {
			return
		}
		const key = `${r.state * 8 + (r.consumed ? 1 : 0) + (r.ended ? 2 : 0) + (r.broken ? 4 : 0)}:${Arr.join(Arr.map(r.counters, String), ",")}`
		if (!seen.has(key)) {
			seen.add(key)
			ways.push(r)
		}
	}
	visit({
		state: nfa.start,
		counters: [],
		consumed: false,
		ended: false,
		broken: false,
		via: undefined,
		point: undefined
	})
	let member: string | undefined
	let broken: string | undefined
	for (let i = 0; i < ways.length; i++) {
		const r = defined(ways[i], "a reached state")
		if (r.state === nfa.accept) {
			if (r.broken) {
				broken ??= spelled(r)
			} else {
				member ??= spelled(r)
			}
		}
		for (const e of defined(nfa.edges[r.state], `the edges of state ${r.state}`)) {
			visit(step(nfa, r, e))
		}
	}
	return { member, broken }
}

/** The host's bounds on a subset construction, as analyzeText's. */
export const dfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates,
	maxWork: regexDfaMaxWork
})

/** A code point spelled as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/**
 * A pattern past the DFA bounds: a code point and eleven of it or another, `x[xy]{11}`, two distinct code points of the
 * family (each family's alphabet holds two or more), whose search automaton needs 2^12 subset states, past
 * regexDfaMaxStates, then a pattern over the family, whose anchors fall anywhere after it.
 */
const pastBounds =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const at = source.draw(int(0, alphabet.length - 1))
		const x = escaped(Arr.getUnsafe(alphabet, at))
		const y = escaped(
			Arr.getUnsafe(alphabet, (at + source.draw(int(1, alphabet.length - 1))) % alphabet.length)
		)
		return `(?:${x}[${x}${y}]{11})(?:${source.draw(patternOver(alphabet))})`
	}

/**
 * A pattern past the DFA bounds that no text matches through its anchors: pastBounds, whose code points stand before
 * a `^` or before a `$` and one more code point, each a way that breaks walk's rules.
 */
const pastBoundsMisanchored =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) =>
		`${source.draw(pastBounds(alphabet))}${source.draw(
			oneOf<string>([constant("^"), map(element(alphabet), (c) => `$${escaped(c)}`)])
		)}`

/**
 * A class no code point is in: one of no items, or a negated one holding a class escape and its complement, in either
 * order, among up to two code points of the family.
 */
const emptyClass =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const escape = source.draw(element(["d", "w"]))
		const pair = source.draw(
			shuffled([`\\${escape}`, `\\${Str.toUpperCase(escape)}`], { min: 2, max: 2 })
		)
		const points = source.draw(array(map(element(alphabet), escaped), { min: 0, max: 2 }))
		return source.draw(
			oneOf<string>([constant("[]"), constant(`[^${Arr.join([...pair, ...points], "")}]`)])
		)
	}

/** A pattern no text matches through a class: patterns over the family on both sides of an empty class (emptyClass). */
const classEmptied =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) =>
		`(?:${source.draw(patternOver(alphabet))})${source.draw(emptyClass(alphabet))}(?:${source.draw(patternOver(alphabet))})`

/**
 * A term the counted arm repeats: a code point, an anchor, or an alternation of them with each other or with the empty
 * string, so a repetition's copies meet its anchors in every order.
 */
const countedTerm =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const c = escaped(source.draw(element(alphabet)))
		return source.draw(element([c, "^", "$", `(?:${c}|^)`, `(?:${c}|$)`, "(?:^|$)", `(?:${c}|)`]))
	}

/**
 * A pattern over the family, then a group of up to three terms of countedTerm under a counted quantifier, past the
 * fourth copy at which every repetition's profiles settle: `{n}`, `{n,}` or `{m,n}`.
 */
const counted =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const body = Arr.join(source.draw(array(countedTerm(alphabet), { min: 1, max: 3 })), "")
		const n = source.draw(element([2, 3, 4, 5, 9]))
		const m = source.draw(int(0, n))
		const count = source.draw(element([`{${n}}`, `{${n},}`, `{${m},${n}}`]))
		return `${source.draw(patternOver(alphabet))}(?:${body})${count}`
	}

/** A pattern `pattern` draws over a family's alphabet, under either set of flags. */
const caseOver =
	(
		pattern: (alphabet: Arr.NonEmptyReadonlyArray<number>) => Gen<string>
	): Gen<readonly [source: string, flags: Flags]> =>
	(source) => {
		const { alphabet } = source.draw(element(families))
		return [source.draw(pattern(alphabet)), source.draw(flagsGen)] as const
	}

/**
 * A pattern over a family's alphabet: one of patternOver's, whose anchors fall anywhere; a finite language, anchored
 * at both ends; one past the DFA bounds (pastBounds); or one with a counted group of anchors (counted).
 */
export const caseGen: Gen<readonly [source: string, flags: Flags]> = caseOver((alphabet) =>
	weighted<string>([
		[6, patternOver(alphabet)],
		[1, map(finiteLanguageOver(alphabet, mostFiniteMembers), (language) => language.source)],
		[3, pastBounds(alphabet)],
		[2, counted(alphabet)]
	])
)

/** A pattern no text matches through a class (classEmptied). */
export const classEmptiedGen: Gen<readonly [source: string, flags: Flags]> = caseOver(classEmptied)

/** A pattern past the DFA bounds that no text matches through its anchors (pastBoundsMisanchored). */
export const pastBoundsMisanchoredGen: Gen<readonly [source: string, flags: Flags]> =
	caseOver(pastBoundsMisanchored)

export type Emptiness =
	| "empty through an anchor"
	| "empty through a class"
	| "empty past the DFA bounds"
	| "non-empty with an inner anchor"
	| "non-empty past the DFA bounds"

/**
 * The refusal of a pattern no text matches: UnsupportedOperation at the pattern itself; and of any other, nothing, or
 * a measure of its compile space (ResourceBound), never the refusal of an empty one.
 */
export const judged = (
	result: Engine.Result<unknown, CompileError>,
	empty: boolean,
	label: string
): void => {
	if (empty) {
		const refusal = refused(result, "UnsupportedOperation", label)
		assert.deepEqual(refusalLoc(refusal), childLoc(loc, "pattern"), label)
	} else if (!result.ok) {
		assert.equal(result.error.reason._tag, "ResourceBound", label)
	}
}
