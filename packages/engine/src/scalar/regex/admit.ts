import {
	CompileError,
	prose,
	type RegexSpaceMeasure,
	resourceBound,
	unsupported
} from "#compiler/core/errors.ts"
import {
	regexMaxAnchors,
	regexMaxAnchorWeight,
	regexMaxClosurePairs,
	regexMaxPositions
} from "#compiler/core/limits.ts"
import { childLoc, type SourceLoc } from "#compiler/core/loc.ts"
import * as Result from "#compiler/core/result.ts"
import type { PatternEntry } from "#compiler/ir/expr.ts"
import { toAre } from "#compiler/scalar/regex/are.ts"
import {
	expandedAssertions,
	expandedSize,
	loopsThroughAnchor,
	type RegexNode
} from "#compiler/scalar/regex/ir.ts"
import { buildNfa, closurePairs, type Nfa } from "#compiler/scalar/regex/nfa.ts"
import {
	parsePattern,
	type RegexDiagnostic,
	type RegexFlags
} from "#compiler/scalar/regex/parse.ts"

/** A pattern its admission passed: its normalized IR, the flags folded in, and the NFA the measures read. */
export interface AdmittedPattern {
	readonly ir: RegexNode
	readonly nfa: Nfa
}

const diagnosticError = (
	diagnostic: RegexDiagnostic,
	loc: SourceLoc,
	source: string,
	flags: string
): CompileError =>
	CompileError.make(
		prose(
			diagnostic.reason,
			childLoc(childLoc(loc, "pattern"), diagnostic.offset),
			`${diagnostic.construct} at offset ${diagnostic.offset} of /${source}/${flags}: ${diagnostic.message}`
		)
	)

/**
 * The one admission of a pattern grizzle hands PostgreSQL: a str.regex refinement's (text/refinement.ts analyzeText)
 * and every pattern value a Compute.matches term can take (compute/lower.ts). It parses the admitted grammar
 * (parse.ts), with source-located diagnostics at any length and nesting depth, and refuses, as ResourceBound naming the
 * pattern, one past a measure of PostgreSQL's regex compile space (core/limits.ts regexMaxPositions, regexMaxAnchors,
 * regexMaxAnchorWeight, regexMaxClosurePairs), the one limit on a pattern's size, which is PostgreSQL's own. The
 * measures run in a fixed order, a loop through an anchor first, so one pattern has one refusal. `loc` places a refusal
 * alone; diagnostics point one level deeper, at the construct's offset in the pattern (`... .pattern[3]`).
 */
export const admitPattern = (
	source: string,
	flags: RegexFlags,
	loc: SourceLoc
): Result.Result<AdmittedPattern, CompileError> => {
	const parsed = parsePattern(source, flags)
	if (!parsed.ok) {
		return Result.err(diagnosticError(parsed.error, loc, source, flags))
	}
	const ir = parsed.value
	const tooComplex = (measure: RegexSpaceMeasure): Result.Result<never, CompileError> =>
		Result.err(
			resourceBound(childLoc(loc, "pattern"), {
				kind: "regexCompileSpace",
				pattern: `/${source}/${flags}`,
				measure
			})
		)
	if (loopsThroughAnchor(ir)) {
		return tooComplex({ kind: "anchorLoop" })
	}
	const positions = expandedSize(ir)
	if (positions > regexMaxPositions.value) {
		return tooComplex({ kind: "positions", limit: regexMaxPositions.value, needed: positions })
	}
	const anchors = expandedAssertions(ir)
	if (anchors > regexMaxAnchors.value) {
		return tooComplex({ kind: "anchors", limit: regexMaxAnchors.value, needed: anchors })
	}
	if (anchors * positions > regexMaxAnchorWeight.value) {
		return tooComplex({
			kind: "anchorWeight",
			limit: regexMaxAnchorWeight.value,
			anchors,
			positions
		})
	}
	const nfa = buildNfa(ir)
	if (closurePairs(nfa, regexMaxClosurePairs.value) > regexMaxClosurePairs.value) {
		return tooComplex({ kind: "closurePairs", limit: regexMaxClosurePairs.value })
	}
	return Result.ok({ ir, nfa })
}

/** The flags every Compute.matches pattern is read under: str.regex's default. */
export const matchFlags: RegexFlags = "u"

/**
 * A Compute.matches pattern admitted (admitPattern under matchFlags) and translated into the ARE `~` reads in its
 * place (are.ts toAre): refused where its admission refuses it, and where its IR is the empty language's, which no ARE
 * spells and no text matches, so the test could never hold (UnsupportedOperation, naming the pattern).
 */
export const matchPattern = (
	source: string,
	loc: SourceLoc
): Result.Result<PatternEntry, CompileError> => {
	const admitted = admitPattern(source, matchFlags, loc)
	if (!admitted.ok) {
		return admitted
	}
	const { ir } = admitted.value
	if (ir.kind === "never") {
		return Result.err(
			unsupported(
				childLoc(loc, "pattern"),
				`a pattern some text matches: /${source}/${matchFlags} matches no text value, so the match could never hold`
			)
		)
	}
	return Result.ok(Object.freeze({ source, are: toAre(ir) }))
}
