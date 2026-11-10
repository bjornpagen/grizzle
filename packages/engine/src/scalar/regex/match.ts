import { codePoints } from "#compiler/core/text.ts"
import { type CharSet, has, isAdmittedCodePoint } from "#compiler/scalar/regex/charset.ts"
import { entry } from "#compiler/scalar/regex/table.ts"

/**
 * An automaton's runtime half: its form, as nfa.ts buildNfa makes it and a served file carries it (matcher.ts
 * ServedMatcher), and whether a text is in its language, run with no regex IR.
 */
export type NfaEdge =
	| { readonly kind: "eps"; readonly to: number }
	| { readonly kind: "start"; readonly to: number }
	| { readonly kind: "end"; readonly to: number }
	| { readonly kind: "set"; readonly set: CharSet; readonly to: number }

export interface Nfa {
	readonly start: number
	readonly accept: number
	/** Outgoing edges of each state. */
	readonly edges: ReadonlyArray<ReadonlyArray<NfaEdge>>
}

/** Which assertion edges a closure may follow. */
interface Position {
	readonly atStart: boolean
	readonly atEnd: boolean
}

/** Whether a closure follows an edge at `position`: an ε edge always, `^` only at the start, `$` only at the end. */
const follows = (e: NfaEdge, position: Position): boolean =>
	e.kind === "eps" ||
	(e.kind === "start" && position.atStart) ||
	(e.kind === "end" && position.atEnd)

/** The states a state's set edges admitting code point `c` lead to. */
const stepsOn = (nfa: Nfa, s: number, c: number): ReadonlyArray<number> =>
	entry(nfa.edges, s).flatMap((e) => (e.kind === "set" && has(e.set, c) ? [e.to] : []))

/**
 * The states reachable from `seeds` over ε edges and the assertions that hold at the position. `mark` is scratch space
 * of the NFA's size; `stamp` is fresh for each call.
 */
export const closure = (
	nfa: Nfa,
	seeds: Iterable<number>,
	position: Position,
	mark: Int32Array,
	stamp: number
): Array<number> => {
	const out: Array<number> = []
	const stack: Array<number> = []
	const visit = (s: number): void => {
		if (mark[s] !== stamp) {
			mark[s] = stamp
			stack.push(s)
		}
	}
	for (const s of seeds) {
		visit(s)
	}
	for (let s = stack.pop(); s !== undefined; s = stack.pop()) {
		out.push(s)
		for (const e of entry(nfa.edges, s)) {
			if (follows(e, position)) {
				visit(e.to)
			}
		}
	}
	return out
}

/** The code points of an admitted text value, or undefined when it is not one (NUL or a lone surrogate). */
const admittedCodePoints = (value: string): ReadonlyArray<number> | undefined => {
	const points = codePoints(value)
	return points.every((c) => isAdmittedCodePoint(c)) ? points : undefined
}

/** Whether a match exists in the code point sequence. */
const matchesCodePoints = (nfa: Nfa, cps: ReadonlyArray<number>): boolean => {
	const mark = new Int32Array(nfa.edges.length).fill(-1)
	let stamp = 0
	const n = cps.length
	let current = closure(nfa, [nfa.start], { atStart: true, atEnd: n === 0 }, mark, stamp++)
	if (current.includes(nfa.accept)) {
		return true
	}
	for (const [i, c] of cps.entries()) {
		const next = [...current.flatMap((s) => stepsOn(nfa, s, c)), nfa.start]
		current = closure(nfa, next, { atStart: false, atEnd: i + 1 === n }, mark, stamp++)
		if (current.includes(nfa.accept)) {
			return true
		}
	}
	return false
}

/**
 * Whether an admitted text value belongs to the pattern's language. A string that is not admitted text (it holds NUL
 * or a lone surrogate) belongs to no refinement, because no PostgreSQL text value spells it.
 */
export const matches = (nfa: Nfa, value: string): boolean => {
	const cps = admittedCodePoints(value)
	return cps !== undefined && matchesCodePoints(nfa, cps)
}
