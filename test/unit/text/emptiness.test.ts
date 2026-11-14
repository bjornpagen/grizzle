/**
 * A pattern no text matches, decided by the IR (scalar/regex/ir.ts): its constructors make a node the empty language
 * exactly when none of its paths can match, an empty class's or an order of anchors no match passes (`^$a`). The oracle
 * is a search of the pattern's own NFA, written here and blind to the IR's profiles: the pattern is spelled again with
 * each `^` and `$` a pair of marks, private-use code points no family holds, so its parse keeps every path an anchor
 * would make impossible; each mark's edge is then read back as its anchor's, and a reachability over (state, consumed a
 * code point, passed a `$`) follows walk's rules (generators.ts walk): a `^` only before the first code point, no code
 * point after a `$`. The IR is never, and matchPattern and analyzeText refuse the pattern as UnsupportedOperation at the
 * pattern, exactly when the search reaches no accepting state; a path it finds spells a member, which ECMAScript's own
 * test accepts, and a path that breaks the rules spells a text the pattern rejects when it is empty.
 *
 * Features: empty through an anchor, through a class, and past the DFA bounds; non-empty with an inner anchor and past
 * the DFA bounds.
 *
 * Plants: text-ir-never-skipped (a sequence passes over an item no text matches, as if it matched the empty text).
 */
import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, int, map, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
import { describe, it } from "@effect/vitest"
import { Array as Arr, Effect, Formatter, String as Str } from "effect"
import type { CompileError } from "#compiler/core/errors.ts"
import { regexDfaMaxStates, regexDfaMaxWork } from "#compiler/core/limits.ts"
import { childLoc, SourceLoc } from "#compiler/core/loc.ts"
import type * as Engine from "#compiler/core/result.ts"
import { codePointsText } from "#compiler/core/text.ts"
import { matchPattern } from "#compiler/scalar/regex/admit.ts"
import type { CharSet } from "#compiler/scalar/regex/charset.ts"
import { minimalDfa } from "#compiler/scalar/regex/dfa.ts"
import type { Nfa } from "#compiler/scalar/regex/match.ts"
import { buildNfa } from "#compiler/scalar/regex/nfa.ts"
import { parsePattern } from "#compiler/scalar/regex/parse.ts"
import { analyzeText } from "#compiler/text/refinement.ts"
import { assert, defined, refusalLoc, refused, succeeded } from "#test/support/assert.ts"
import { caseHang } from "#test/support/limits.ts"
import {
	type Flags,
	families,
	finiteLanguageOver,
	flagsGen,
	jsMatcher,
	mostFiniteMembers,
	patternOver
} from "#test/unit/text/generators.ts"

const loc = SourceLoc("str.regex", ["Content", "relations", "Article", "fields", "f"])

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
		? { kind: "start", to: e.to }
		: e.kind === "set" && isOnly(e.set, endMark)
			? { kind: "end", to: e.to }
			: e

/** The pattern's NFA with every path its spelling makes, built from the marked spelling's parse (markedSpelling). */
const patternNfa = (source: string, flags: Flags): Nfa => {
	const ir = succeeded(
		parsePattern(markedSpelling(source), flags),
		`/${source}/${flags} spelled with marks`
	)
	const nfa = buildNfa(ir)
	return { ...nfa, edges: Arr.map(nfa.edges, (edges) => Arr.map(edges, unmarked)) }
}

/**
 * A state of the search: an NFA state, whether a code point has been consumed and a `$` passed on the way, whether the
 * way broke walk's rules (a `^` after a code point, or a code point after a `$`), and the step it came by.
 */
interface Reached {
	readonly state: number
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

/** Where an edge leads from `r`: an ε edge as it is, a `^` or `$` edge by walk's rules, a set edge on its least code point. */
const step = (r: Reached, e: Edge): Reached => {
	const next = { ...r, state: e.to, via: r, point: undefined }
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
const searchOf = (
	nfa: Nfa
): { readonly member: string | undefined; readonly broken: string | undefined } => {
	const seen = new Set<number>()
	const ways: Array<Reached> = []
	const visit = (r: Reached): void => {
		const key = r.state * 8 + (r.consumed ? 1 : 0) + (r.ended ? 2 : 0) + (r.broken ? 4 : 0)
		if (!seen.has(key)) {
			seen.add(key)
			ways.push(r)
		}
	}
	visit({
		state: nfa.start,
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
			visit(step(r, e))
		}
	}
	return { member, broken }
}

/** The host's bounds on a subset construction, as analyzeText's. */
const dfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates.value,
	maxWork: regexDfaMaxWork.value
})

/** A code point spelled as its braced escape, which means itself inside a class and out. */
const escaped = (c: number): string => `\\u{${c.toString(16)}}`

/**
 * A pattern past the DFA bounds: a code point and eleven of it or another, `x[xy]{11}`, whose search automaton needs
 * 2^12 subset states, past regexDfaMaxStates, then a pattern over the family, whose anchors fall anywhere after it.
 */
const pastBounds =
	(alphabet: Arr.NonEmptyReadonlyArray<number>): Gen<string> =>
	(source) => {
		const x = source.draw(element(alphabet))
		const y = source.draw(element(alphabet))
		return `(?:${escaped(x)}[${escaped(x)}${escaped(y)}]{11})(?:${source.draw(patternOver(alphabet))})`
	}

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

/**
 * A pattern over a family's alphabet: one of patternOver's, whose anchors fall anywhere; a finite language, anchored
 * at both ends; one past the DFA bounds (pastBounds); or one with a counted group of anchors (counted).
 */
const caseGen: Gen<readonly [source: string, flags: Flags]> = (source) => {
	const { alphabet } = source.draw(element(families))
	const pattern = source.draw(
		weighted<string>([
			[6, patternOver(alphabet)],
			[1, map(finiteLanguageOver(alphabet, mostFiniteMembers), (language) => language.source)],
			[3, pastBounds(alphabet)],
			[2, counted(alphabet)]
		])
	)
	return [pattern, source.draw(flagsGen)] as const
}

type Emptiness =
	| "empty through an anchor"
	| "empty through a class"
	| "empty past the DFA bounds"
	| "non-empty with an inner anchor"
	| "non-empty past the DFA bounds"

/**
 * The refusal of a pattern no text matches: UnsupportedOperation at the pattern itself; and of any other, nothing, or
 * a measure of its compile space (ResourceBound), never the refusal of an empty one.
 */
const judged = (
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

describe("a pattern no text matches", () => {
	it.effect(
		"is never in the IR, and refused by matchPattern and analyzeText, exactly when no way through its NFA can match",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "unit/text/emptiness",
						draw: drawn(caseGen),
						literal: Formatter.format,
						oracle: {
							kind: "second-implementation",
							name: "a reachability over the NFA of the pattern's spelling with its anchors as marks, and ECMAScript's own test of what it spells"
						},
						coverage: required<Emptiness>(
							[
								"empty through an anchor",
								"empty through a class",
								"empty past the DFA bounds",
								"non-empty with an inner anchor",
								"non-empty past the DFA bounds"
							],
							{ cases: 1000, sense: notesOnly }
						),
						kept: [],
						runs: 600,
						shrink: completeShrink,
						concurrency: 1,
						steerEvery: 16,
						caseHang
					},
					([source, flags], c) =>
						Effect.sync(() => {
							const label = `/${source}/${flags}`
							const ir = succeeded(parsePattern(source, flags), label)
							const nfa = patternNfa(source, flags)
							const { member, broken } = searchOf(nfa)
							const ofPattern = jsMatcher(source, flags)
							const empty = member === undefined
							assert.equal(ir.kind === "never", empty, `${label} is never exactly when it is empty`)
							if (member !== undefined) {
								assert.equal(
									ofPattern(member),
									true,
									`${label} matches ${Formatter.format(member)}`
								)
							}
							if (empty && broken !== undefined) {
								assert.equal(
									ofPattern(broken),
									false,
									`${label} rejects ${Formatter.format(broken)}`
								)
							}
							const analyzed = analyzeText([{ source, flags }], loc)
							judged(analyzed, empty, `analyzeText ${label}`)
							if (flags === "u") {
								judged(matchPattern(source, loc), empty, `matchPattern ${label}`)
							}
							if (empty) {
								c.note(broken === undefined ? "empty through a class" : "empty through an anchor")
								if (broken !== undefined && minimalDfa(nfa, dfaLimits).kind === "bounded") {
									c.note("empty past the DFA bounds")
								}
								return
							}
							if (broken !== undefined) {
								c.note("non-empty with an inner anchor")
							}
							if (analyzed.ok && Str.startsWith("ir:")(analyzed.value.key)) {
								c.note("non-empty past the DFA bounds")
							}
						})
				)
			)
	)
})
