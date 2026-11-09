import { mapNonEmpty } from "#compiler/core/nonempty.ts"
import { type TextBounds, type TextInfo, textInfoOf } from "#compiler/ir/scalar.ts"
import { type TextRefinement, textLanguage } from "#compiler/text/refinement.ts"

/** The bounds a refinement proves on every member, where it proves them. */
export const refinementBounds = (refinement: TextRefinement): TextBounds | undefined =>
	refinement.check.kind === "tautology" ? undefined : refinement.check.bounds

/**
 * The text metadata of the refinement's ScalarType (ir/scalar.ts textInfoOf): a proved tautology is the canonical
 * wildcard, which is unbounded; any other conjunction keeps its patterns as the declaration wrote them, with its
 * language's key, its enforcement and its proved bounds (text/refinement.ts textLanguage).
 */
export const textInfo = (refinement: TextRefinement): TextInfo =>
	textInfoOf(
		mapNonEmpty(refinement.members, (pattern) =>
			Object.freeze({ source: pattern.source, flags: pattern.flags })
		),
		textLanguage(refinement)
	)
