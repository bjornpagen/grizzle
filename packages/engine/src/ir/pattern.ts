import { defined } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import {
	type CanonicalDfa,
	type DfaOutcome,
	dfaKey,
	minimalDfa
} from "@bjornpagen/grizzle-text/regex/dfa"
import {
	canonicalText,
	loopsThroughAnchor,
	type RegexNode
} from "@bjornpagen/grizzle-text/regex/ir"
import { regexDfaLimits } from "@bjornpagen/grizzle-text/regex/limits"
import { buildNfa } from "@bjornpagen/grizzle-text/regex/nfa"
import {
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "@bjornpagen/grizzle-text/regex/parse"
import type { RegexSpaceMeasure } from "#compiler/core/errors.ts"
import { compareStrings } from "#compiler/core/order.ts"
import { pastCompileSpace } from "#compiler/ir/pattern-space.ts"
import { languageKey, type RegexKey } from "#compiler/ir/scalar.ts"

/** The flags every Text.matches pattern is read under: str.regex's default. */
export const matchFlags: RegexFlags = "u"

/**
 * A non-empty language as the analysis knows it: by its canonical automaton when the DFA bounds reach one, and
 * otherwise by its normalized IR alone, a conjunction's by its members' IRs.
 */
export type Known =
	| { readonly kind: "automaton"; readonly dfa: CanonicalDfa }
	| { readonly kind: "structure" }

/**
 * The language of a pattern's IR as the analysis knows it, from the outcome of its NFA's subset construction within the
 * text analysis's bounds (dfa.ts minimalDfa at regexDfaLimits): its canonical automaton where the bounds reach one,
 * which has no state exactly for the empty language, the IR never, and otherwise its structure, which the IR of a
 * language with a member alone can pass.
 */
export const knownOf = (outcome: DfaOutcome): Known => {
	switch (outcome.kind) {
		case "bounded":
			return { kind: "structure" }
		case "minimal":
			return { kind: "automaton", dfa: outcome.dfa }
	}
}

/**
 * A pattern's own canonical key, from its normalized IR and its language as the analysis knows it (knownOf): its
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
 * A Text.matches pattern as a value: its language, by the key of its own canonical key (ownKey, ir/scalar.ts
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
 * The one admission of a pattern grizzle hands PostgreSQL, over its parse (parse.ts parsePattern): a str.regex
 * refinement's (text/refinement.ts analyzeText) and every pattern value's (admitSpelling), whether a compile's table
 * holds the parse (scalar/regex/patterns.ts CompilePatterns) or a pattern is admitted alone (admitIr). The parser reads
 * the admitted grammar at any length and nesting depth; a parse is refused here past a limit of PostgreSQL's regex
 * compiler (pattern-space.ts pastCompileSpace), the one limit on a pattern's size, which is PostgreSQL's own. The limits
 * are checked in a fixed order, a loop through an anchor first, so one pattern has one refusal. Its result is the
 * pattern's normalized IR, the flags folded in, or its refusal, which a reader places where it reads the pattern.
 */
export const admitParsed = (
	parsed: Result.Result<RegexNode, RegexDiagnostic>
): Result.Result<RegexNode, PatternRefusal> => {
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

/** A pattern admitted alone, by its parse (admitParsed). */
export const admitIr = (
	source: string,
	flags: RegexFlags
): Result.Result<RegexNode, PatternRefusal> => admitParsed(parsePattern(source, flags))

/**
 * The pattern value of `spelling`, a pattern its admission admitted under matchFlags: its language's key, computed from
 * its IR and the outcome of its NFA's subset construction (knownOf), and the spelling.
 */
export const patternValueOf = (
	spelling: string,
	ir: RegexNode,
	outcome: DfaOutcome
): PatternValue => Object.freeze({ pattern: languageKey(ownKey(ir, knownOf(outcome))), spelling })

/**
 * The pattern value of `spelling` admitted alone under matchFlags (admitIr), so its automaton is built only for a
 * pattern PostgreSQL compiles (patternValueOf), or why the admission refuses it: the door of a pattern value no compile's
 * table holds, Text.pattern's admission where a schema is built, a lexical form's and a decode's. A compile admits the
 * values it reads in its table (scalar/regex/patterns.ts CompilePatterns spelling).
 */
export const admitSpelling = (spelling: string): Result.Result<PatternValue, PatternRefusal> =>
	Result.map(admitIr(spelling, matchFlags), (ir) =>
		patternValueOf(spelling, ir, minimalDfa(buildNfa(ir), regexDfaLimits))
	)

/**
 * An installation's spelling of each pattern language it installs, by the language's key (PatternValue `pattern`), drawn
 * as a roster's codes are: the installation's history, so a language it installs keeps its spelling however its schema
 * spells it after, and its SQL, which reads a pattern by its spelling's ARE, moves only where a language does.
 */
export type Spellings = ReadonlyMap<string, string>

/** The spellings of an installation that installs no pattern. */
export const noSpellings: Spellings = new Map()

/** A pattern value as a value holds it: an object of a pattern and a spelling and nothing else, the shape admitSpelling
 * alone builds. */
interface HeldPattern {
	readonly pattern: string
	readonly spelling: string
}

/** Whether `x` is a pattern value: an object of exactly a string pattern and a string spelling. */
const heldPattern = (x: object): HeldPattern | undefined => {
	const keys = Object.keys(x)
	if (keys.length !== 2 || !("pattern" in x) || !("spelling" in x)) {
		return undefined
	}
	const { pattern, spelling } = x
	return typeof pattern === "string" && typeof spelling === "string"
		? { pattern, spelling }
		: undefined
}

/**
 * Every pattern value `value` holds, each object once, in the order its arrays and properties hold them: through data
 * properties alone, so no getter a description's object defines is run, whatever it computes.
 */
const patternsIn = (value: unknown): ReadonlyArray<HeldPattern> => {
	const out: Array<HeldPattern> = []
	const seen = new Set<object>()
	const visit = (x: unknown): void => {
		if (typeof x !== "object" || x === null || seen.has(x)) {
			return
		}
		seen.add(x)
		const held = Array.isArray(x) ? undefined : heldPattern(x)
		if (held !== undefined) {
			out.push(held)
			return
		}
		for (const property of Object.values(Object.getOwnPropertyDescriptors(x))) {
			if ("value" in property) {
				visit(property.value)
			}
		}
	}
	visit(value)
	return out
}

/**
 * How an installation spells the patterns it installs: `table`, its spelling of each language, which its record keeps;
 * and `of`, the spelling it installs a pattern written `spelling` as, its language's, so every spelling of one language
 * is one ARE in its SQL, and a spelling of no language it installs, which only a program a layer compiles reads, as
 * written.
 */
export interface InstalledSpellings {
	readonly table: Spellings
	readonly of: (spelling: string) => string
}

/**
 * The spellings of an installation of the schema `held`, whose installation held `history` before: each language of a
 * pattern value `held` holds that `history` spells keeps that spelling, and each other takes the least of the spellings
 * of it `held` holds, by code unit, a choice of the spellings alone, so the order a schema states its patterns in
 * spells none of them. A language `held` no longer holds leaves the table.
 */
export const installedSpellings = (history: Spellings, held: unknown): InstalledSpellings => {
	const patterns = patternsIn(held)
	/** Each language's least spelling `held` holds. */
	const least = new Map<string, string>()
	for (const p of patterns) {
		const spelled = least.get(p.pattern) ?? p.spelling
		least.set(p.pattern, compareStrings(p.spelling, spelled) < 0 ? p.spelling : spelled)
	}
	const table: Spellings = new Map(
		[...least].map(([pattern, spelled]) => [pattern, history.get(pattern) ?? spelled] as const)
	)
	const authored = new Map(
		patterns.map(
			(p) => [p.spelling, defined(table.get(p.pattern), "a held pattern's language")] as const
		)
	)
	return Object.freeze({
		table,
		of: (spelling: string): string => authored.get(spelling) ?? spelling
	})
}
