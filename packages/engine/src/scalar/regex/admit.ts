import { defect } from "@bjornpagen/grizzle-text/base/invariant"
import * as Result from "@bjornpagen/grizzle-text/base/result"
import { parsePattern, type RegexFlags } from "@bjornpagen/grizzle-text/regex/parse"
import { toAre } from "@bjornpagen/grizzle-text/regex/print"
import { CompileError, prose, resourceBound } from "#compiler/core/errors.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import {
	admitSpelling,
	diagnosticText,
	matchFlags,
	type PatternRefusal,
	type PatternValue
} from "#compiler/ir/pattern.ts"

/**
 * The refusal of the pattern `/source/flags` placed at `loc`: a diagnostic one level deeper, at the construct's offset
 * in the pattern (`... .pattern[3]`); a compile space past its limit at the pattern, as ResourceBound naming it. What a
 * str.regex refinement's analysis places a refused member's admission by (text/refinement.ts analyzePattern).
 */
export const refusalAt = (
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
 * A Text.matches pattern, its source, admitted where its value is first held (admitMatch): admitted, with its
 * pattern value (ir/pattern.ts PatternValue), or refused with why, which a lowering reading it places at the match
 * (matchValueAt).
 */
export type MatchAdmission<S extends string = string> =
	| { readonly kind: "admitted"; readonly source: S; readonly value: PatternValue }
	| { readonly kind: "refused"; readonly source: S; readonly refusal: PatternRefusal }

/**
 * A Text.matches pattern by its admission: refused exactly where its admission refuses it, else with its pattern value.
 * A pattern no text matches, the empty language's (an empty class, or an order of anchors no match can pass, ir.ts), is
 * a language as any other: its match holds of no text, as a closed pattern table's row for a domain that admits no
 * value states. Its ARE is translated only where SQL prints it (matchAre).
 */
export const matchAdmission = <S extends string>(
	source: S,
	admitted: Result.Result<PatternValue, PatternRefusal>
): MatchAdmission<S> =>
	admitted.ok
		? { kind: "admitted", source, value: admitted.value }
		: { kind: "refused", source, refusal: admitted.error }

/**
 * A Text.matches pattern admitted alone (ir/pattern.ts admitSpelling, matchAdmission), where a schema's term is built;
 * a compile admits the patterns it reads in its table (scalar/regex/patterns.ts CompilePatterns spelling).
 */
export const admitMatch = <S extends string>(source: S): MatchAdmission<S> =>
	matchAdmission(source, admitSpelling(source))

/**
 * The pattern value of an admitted Text.matches pattern, or its refusal placed at `loc`, as refusalAt places one.
 */
export const matchValueAt = (
	admission: MatchAdmission,
	loc: SourceLoc
): Result.Result<PatternValue, CompileError> =>
	admission.kind === "admitted"
		? Result.ok(admission.value)
		: Result.err(matchRefusalAt(admission, loc))

/** The refusal of a Text.matches pattern its admission refused, placed at `loc` as refusalAt places one. */
export const matchRefusalAt = (
	admission: Extract<MatchAdmission, { readonly kind: "refused" }>,
	loc: SourceLoc
): CompileError => refusalAt(admission.refusal, admission.source, matchFlags, loc)

/** A Text.matches pattern admitted (admitMatch) and placed at `loc` (matchValueAt). */
export const matchPattern = (
	source: string,
	loc: SourceLoc
): Result.Result<PatternValue, CompileError> => matchValueAt(admitMatch(source), loc)

/**
 * The ARE `~` reads in place of a Text.matches pattern its node's admission admitted (admitMatch): its IR under
 * matchFlags translated (print.ts toAre). It runs where SQL prints the pattern, the one reader of its ARE.
 */
export const matchAre = (source: string): string => {
	const parsed = parsePattern(source, matchFlags)
	if (!parsed.ok) {
		throw defect(`a Text.matches pattern its admission admitted: /${source}/${matchFlags}`)
	}
	return toAre(parsed.value)
}
