import {
	CompileError,
	prose,
	type RegexSpaceMeasure,
	resourceBound,
	unsupported
} from "#compiler/core/errors.ts"
import { defect } from "#compiler/core/invariant.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import { toAre } from "#compiler/scalar/regex/are.ts"
import { loopsThroughAnchor, type RegexNode } from "#compiler/scalar/regex/ir.ts"
import { matchFlags } from "#compiler/scalar/regex/matcher.ts"
import { buildNfa, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import {
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "#compiler/scalar/regex/parse.ts"
import { pastCompileSpace } from "#compiler/scalar/regex/space.ts"

/** A pattern its admission passed: its normalized IR, the flags folded in, and the NFA the measures read. */
export interface AdmittedPattern {
	readonly ir: RegexNode
	readonly nfa: Nfa
}

/**
 * Why an admission refuses a pattern, wherever the pattern is read: a construct outside the admitted grammar, with its
 * diagnostic; or a size past a limit of PostgreSQL's regex compiler, with the measure it passes.
 */
type PatternRefusal =
	| { readonly kind: "diagnostic"; readonly diagnostic: RegexDiagnostic }
	| { readonly kind: "compileSpace"; readonly measure: RegexSpaceMeasure }

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
					`${refusal.diagnostic.construct} at offset ${refusal.diagnostic.offset} of /${source}/${flags}: ${refusal.diagnostic.message}`
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
 * The one admission of a pattern grizzle hands PostgreSQL: a str.regex refinement's (text/refinement.ts analyzeText,
 * through admitPattern) and every pattern value a Compute.matches term can take (admitMatch). It parses the admitted
 * grammar (parse.ts) at any length and nesting depth, and refuses one past a limit of PostgreSQL's regex compiler
 * (space.ts pastCompileSpace), the one limit on a pattern's size, which is PostgreSQL's own. The limits are checked in
 * a fixed order, a loop through an anchor first, so one pattern has one refusal. Its result is the pattern's normalized
 * IR, the flags folded in, or its refusal, which a reader places where it reads the pattern (refusalAt).
 */
const admitIr = (source: string, flags: RegexFlags): Result.Result<RegexNode, PatternRefusal> => {
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
 * Why an admission refuses a Compute.matches pattern, wherever it is read: as any pattern grizzle hands PostgreSQL is
 * refused (admitIr), or as the empty language's, which no text matches.
 */
type MatchRefusal = PatternRefusal | { readonly kind: "noText" }

/**
 * A Compute.matches pattern value, its source, admitted where its value is first held (admitMatch): admitted, or
 * refused with why, which a lowering reading it places at the match (matchSourceAt).
 */
export type MatchAdmission<S extends string = string> =
	| { readonly kind: "admitted"; readonly source: S }
	| { readonly kind: "refused"; readonly source: S; readonly refusal: MatchRefusal }

/**
 * A Compute.matches pattern admitted (admitIr under matchFlags): refused where its admission refuses it, and where its
 * IR is the empty language's, which no ARE spells, so the test could never hold. The IR is the empty language exactly
 * when no text matches the pattern, an empty class or an order of anchors no match can pass alike (ir.ts), so this
 * refuses every such pattern and no other. Its ARE is translated only where SQL prints it (matchAre).
 */
export const admitMatch = <S extends string>(source: S): MatchAdmission<S> => {
	const admitted = admitIr(source, matchFlags)
	if (!admitted.ok) {
		return { kind: "refused", source, refusal: admitted.error }
	}
	return admitted.value.kind === "never"
		? { kind: "refused", source, refusal: { kind: "noText" } }
		: { kind: "admitted", source }
}

/**
 * The source of an admitted Compute.matches pattern, or its refusal placed at `loc`: a refusal of its admission as
 * refusalAt places one, and the empty language's as UnsupportedOperation naming the pattern.
 */
export const matchSourceAt = (
	admission: MatchAdmission,
	loc: SourceLoc
): Result.Result<string, CompileError> =>
	admission.kind === "admitted"
		? Result.ok(admission.source)
		: Result.err(matchRefusalAt(admission, loc))

/**
 * The refusal of a Compute.matches pattern its admission refused, placed at `loc`: a refusal of its admission as
 * refusalAt places one, and the empty language's as UnsupportedOperation naming the pattern.
 */
export const matchRefusalAt = (
	admission: Extract<MatchAdmission, { readonly kind: "refused" }>,
	loc: SourceLoc
): CompileError => {
	const { source, refusal } = admission
	return refusal.kind === "noText"
		? unsupported(
				childLoc(loc, "pattern"),
				`a pattern some text matches: /${source}/${matchFlags} matches no text value, so the match could never hold`
			)
		: refusalAt(refusal, source, matchFlags, loc)
}

/** A Compute.matches pattern admitted (admitMatch) and placed at `loc` (matchSourceAt). */
export const matchPattern = (source: string, loc: SourceLoc): Result.Result<string, CompileError> =>
	matchSourceAt(admitMatch(source), loc)

/**
 * The ARE `~` reads in place of a Compute.matches pattern its node's admission admitted (admitMatch): its IR under
 * matchFlags translated (are.ts toAre). It runs where SQL prints the pattern, the one reader of its ARE.
 */
export const matchAre = (source: string): string => {
	const parsed = parsePattern(source, matchFlags)
	if (!parsed.ok || parsed.value.kind === "never") {
		throw defect(`a Compute.matches pattern its admission admitted: /${source}/${matchFlags}`)
	}
	return toAre(parsed.value)
}
