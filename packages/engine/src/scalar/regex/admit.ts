import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import type { RegexNode } from "@bjornpagen/grizzle-text/regex/ir"
import { buildNfa, type Nfa } from "@bjornpagen/grizzle-text/regex/nfa"
import { parsePattern, type RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { CompileError, prose, resourceBound } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	admitIr,
	admitSpelling,
	diagnosticText,
	matchFlags,
	type PatternRefusal,
	type PatternValue
} from "#compiler/ir/pattern.ts"

/** A pattern its admission passed: its normalized IR, the flags folded in, and the NFA the measures read. */
export interface AdmittedPattern {
	readonly ir: RegexNode
	readonly nfa: Nfa
}

/**
 * The refusal of the pattern `/source/flags` placed at `loc`: a diagnostic one level deeper, at the construct's offset
 * in the pattern (`... .pattern[3]`); a compile space past its limit at the pattern, as ResourceBound naming it.
 */
const refusalAt = (
	refusal: PatternRefusal,
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): CompileError => {
	switch (refusal.kind) {
		case "diagnostic":
			return CompileError.make(
				prose(
					refusal.diagnostic.reason,
					childLoc(childLoc(loc, "pattern"), refusal.diagnostic.offset),
					diagnosticText(refusal.diagnostic, source, flags)
				)
			)
		case "compileSpace":
			return resourceBound(childLoc(loc, "pattern"), {
				kind: "regexCompileSpace",
				pattern: `/${source}/${flags}`,
				measure: refusal.measure
			})
	}
}

/**
 * A pattern admitted (admitIr) with the NFA its language is measured by: what a str.regex refinement's analysis reads
 * of each of its patterns (text/refinement.ts analyzePattern). `loc` places a refusal.
 */
export const admitPattern = (
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): Result.Result<AdmittedPattern, CompileError> => {
	const admitted = admitIr(source, flags)
	return admitted.ok
		? Result.ok({ ir: admitted.value, nfa: buildNfa(admitted.value) })
		: Result.err(refusalAt(admitted.error, source, flags, loc))
}

/**
 * A Compute.matches pattern, its source, admitted where its value is first held (admitMatch): admitted, with its
 * pattern value (ir/pattern.ts PatternValue), or refused with why, which a lowering reading it places at the match
 * (matchValueAt).
 */
export type MatchAdmission<S extends string = string> =
	| { readonly kind: "admitted"; readonly source: S; readonly value: PatternValue }
	| { readonly kind: "refused"; readonly source: S; readonly refusal: PatternRefusal }

/**
 * A Compute.matches pattern admitted (ir/pattern.ts admitSpelling), refused exactly where its admission refuses it,
 * else with its pattern value. A pattern no text matches, the empty language's (an empty class, or an order of anchors
 * no match can pass, ir.ts), is a language as any other: its match holds of no text, as a closed pattern table's row
 * for a domain that admits no value states. Its ARE is translated only where SQL prints it (matchAre).
 */
export const admitMatch = <S extends string>(source: S): MatchAdmission<S> => {
	const admitted = admitSpelling(source)
	return admitted.ok
		? { kind: "admitted", source, value: admitted.value }
		: { kind: "refused", source, refusal: admitted.error }
}

/**
 * The pattern value of an admitted Compute.matches pattern, or its refusal placed at `loc`, as refusalAt places one.
 */
export const matchValueAt = (
	admission: MatchAdmission,
	loc: SourceLoc
): Result.Result<PatternValue, CompileError> =>
	admission.kind === "admitted"
		? Result.ok(admission.value)
		: Result.err(matchRefusalAt(admission, loc))

/** The refusal of a Compute.matches pattern its admission refused, placed at `loc` as refusalAt places one. */
export const matchRefusalAt = (
	admission: Extract<MatchAdmission, { readonly kind: "refused" }>,
	loc: SourceLoc
): CompileError => refusalAt(admission.refusal, admission.source, matchFlags, loc)

/** A Compute.matches pattern admitted (admitMatch) and placed at `loc` (matchValueAt). */
export const matchPattern = (
	source: string,
	loc: SourceLoc
): Result.Result<PatternValue, CompileError> => matchValueAt(admitMatch(source), loc)

/**
 * The ARE `~` reads in place of a Compute.matches pattern its node's admission admitted (admitMatch): its IR under
 * matchFlags translated (print.ts toAre). It runs where SQL prints the pattern, the one reader of its ARE.
 */
export const matchAre = (source: string): string => {
	const parsed = parsePattern(source, matchFlags)
	if (!parsed.ok) {
		throw defect(`a Compute.matches pattern its admission admitted: /${source}/${matchFlags}`)
	}
	return toAre(parsed.value)
}
