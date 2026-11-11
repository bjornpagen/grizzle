import { Effect } from "effect"
import { checkGrammar } from "#check/grammar.ts"
import { checkStructure } from "#check/structure.ts"
import type { Diagnostic } from "#model/diagnostic.ts"
import { sortDiagnostics } from "#model/diagnostic.ts"
import { defaultLimits } from "#resolve/index.ts"
import type { Resolution } from "#resolve/index.ts"

/**
 * Every spec-text check (design 3.4): structure, then values and grammars, in document order
 * (pointer, then code). Pure over the resolved document.
 */
export const checkSpecText = Effect.fn("check.checkSpecText")(function* checkSpecText(
	resolution: Resolution
): Effect.fn.Return<readonly Diagnostic[]> {
	const [structure, grammar] = yield* Effect.all([
		checkStructure(resolution),
		checkGrammar(resolution, defaultLimits)
	])

	return sortDiagnostics([resolution.document], [...structure, ...grammar])
})
