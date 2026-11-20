import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type CanonicalDfa,
	type DfaLimits,
	dfaKey,
	minimalDfa
} from "@bjornpagen/grizzle-text/regex/dfa"
import {
	canonicalText,
	loopsThroughAnchor,
	type RegexNode
} from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaMaxStates, regexDfaMaxWork } from "@bjornpagen/grizzle-text/regex/limits"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import {
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "@bjornpagen/grizzle-text/regex/parse"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { pastCompileSpace } from "#compiler/ir/pattern-space.ts"
import { languageKey, type RegexKey } from "#compiler/ir/scalar.ts"

/** The flags every Compute.matches pattern is read under: str.regex's default. */
export const matchFlags: RegexFlags = "u"

/**
 * The host's bounds on a pattern's subset construction (regexDfaMaxStates, regexDfaMaxWork): past either, the analysis
 * knows the language by its structure alone.
 */
export const dfaLimits: DfaLimits = Object.freeze({
	maxStates: regexDfaMaxStates,
	maxWork: regexDfaMaxWork
})

/**
 * A non-empty language as the analysis knows it: by its canonical automaton when the DFA bounds reach one, and
 * otherwise by its normalized IR alone, a conjunction's by its members' IRs.
 */
export type Known =
	| { readonly kind: "automaton"; readonly dfa: CanonicalDfa }
	| { readonly kind: "structure" }

/**
 * The language of a pattern's IR as the analysis knows it, from its NFA: its canonical automaton where the DFA bounds
 * reach one, which has no state exactly for the empty language, the IR never, and otherwise its structure, which the IR
 * of a language with a member alone can pass.
 */
export const languageOf = (nfa: Nfa): Known => {
	const outcome = minimalDfa(nfa, dfaLimits)
	switch (outcome.kind) {
		case "bounded":
			return { kind: "structure" }
		case "minimal":
			return { kind: "automaton", dfa: outcome.dfa }
	}
}

/**
 * A pattern's own canonical key, from its normalized IR and its language as the analysis knows it (languageOf): its
 * minimal DFA's canonical text ("dfa:...") within the DFA bounds, or its normalized IR ("ir:...") past them. Equal keys
 * recognize the same values; the converse holds for two "dfa:" keys.
 */
export const ownKey = (ir: RegexNode, known: Known): string => {
	switch (known.kind) {
		case "automaton":
			return `dfa:${dfaKey(known.dfa)}`
		case "structure":
			return `ir:${canonicalText(ir)}`
	}
}

/**
 * A Compute.matches pattern as a value: its language, by the key of its own canonical key (ownKey, ir/scalar.ts
 * languageKey), which is its identity, and its spelling, its source in grizzle's pattern grammar under matchFlags, which
 * typing, lowering, evaluation and admission read. The spelling is no part of its semantic identity (core/canonical.ts
 * omitSourceLocs), so two spellings of one language are one law, one check and one query; an installation keeps one
 * spelling of each language it installs. Its one door is admitSpelling, so its spelling is admitted and its key is
 * always its spelling's.
 */
export interface PatternValue {
	readonly pattern: RegexKey
	readonly spelling: string
}

/**
 * Why an admission refuses a pattern, wherever the pattern is read: a construct outside the admitted grammar, with its
 * diagnostic; or a size past a limit of PostgreSQL's regex compiler, with the measure it passes.
 */
export type PatternRefusal =
	| { readonly kind: "diagnostic"; readonly diagnostic: RegexDiagnostic }
	| { readonly kind: "compileSpace"; readonly measure: RegexSpaceMeasure }

/** A diagnostic of the pattern `/source/flags` as prose: the construct, its offset in the pattern, and why. */
export const diagnosticText = (
	diagnostic: RegexDiagnostic,
	source: string,
	flags: RegexFlags
): string =>
	`${diagnostic.construct} at offset ${diagnostic.offset} of /${source}/${flags}: ${diagnostic.message}`

/**
 * The one admission of a pattern grizzle hands PostgreSQL: a str.regex refinement's (text/refinement.ts analyzeText,
 * through scalar/regex/admit.ts admitPattern) and every pattern value's (admitSpelling). It parses the admitted grammar
 * (parse.ts) at any length and nesting depth, and refuses one past a limit of PostgreSQL's regex compiler
 * (pattern-space.ts pastCompileSpace), the one limit on a pattern's size, which is PostgreSQL's own. The limits are
 * checked in a fixed order, a loop through an anchor first, so one pattern has one refusal. Its result is the
 * pattern's normalized IR, the flags folded in, or its refusal, which a reader places where it reads the pattern.
 */
export const admitIr = (
	source: string,
	flags: RegexFlags
): Result.Result<RegexNode, PatternRefusal> => {
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		return Result.err({ kind: "diagnostic", diagnostic: parsed.error })
	}
	const ir = parsed.value
	if (loopsThroughAnchor(ir)) {
		return Result.err({ kind: "compileSpace", measure: { kind: "anchorLoop" } })
	}
	const past = ir.kind === "never" ? undefined : pastCompileSpace(ir)
	if (past !== undefined) {
		return Result.err({ kind: "compileSpace", measure: past })
	}
	return Result.ok(ir)
}

/**
 * The pattern value of `spelling`, admitted under matchFlags (admitIr), so its automaton is built only for a pattern
 * PostgreSQL compiles: its language's key, computed from the IR the admission parsed, and the spelling; or why the
 * admission refuses it. The door of every pattern value: Compute.pattern's admission, a lexical form's and a decode's.
 */
export const admitSpelling = (spelling: string): Result.Result<PatternValue, PatternRefusal> =>
	Result.map(admitIr(spelling, matchFlags), (ir) =>
		Object.freeze({ pattern: languageKey(ownKey(ir, languageOf(buildNfa(ir)))), spelling })
	)
