/**
 * Scalar types for tests, each the one the registry builds (scalar/registry.ts scalarTypeOf): no test states a
 * ScalarType as a literal, so every capability set a test meets is production's.
 */
import { SourceLoc } from "#compiler/core/loc.ts"
import type { NonEmptyReadonlyArray } from "#compiler/core/nonempty.ts"
import * as Result from "#compiler/core/result.ts"
import type { FieldDesc } from "#compiler/ir/desc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { type ScalarEnv, scalarTypeOf, type TextLookup } from "#compiler/scalar/registry.ts"
import { analyzeText, textInfo } from "#compiler/text/refinement.ts"

export { plainType, wildcardText } from "#compiler/scalar/compute/types.ts"

/**
 * The text metadata the schema reading gives a pattern (analysis/schema.ts): the text package's canonical analysis under
 * the policy in force, so a fixture's regex carries the bounds production proves.
 */
const canonicalText: TextLookup = (source, flags) =>
	Result.map(analyzeText(source, flags, SourceLoc("a test fixture's pattern", [])), textInfo)

/**
 * The ScalarType of `desc`, an enum's roster read from `rosters` (closed relation name to its handles in declared
 * order). A FieldDesc the registry refuses fails the test.
 */
export const scalarOf = (
	desc: FieldDesc,
	rosters: Readonly<Record<string, NonEmptyReadonlyArray<string>>>
): ScalarType => {
	const env: ScalarEnv = {
		kind: "builder",
		roster: (closed) => rosters[closed],
		text: canonicalText
	}
	const t = scalarTypeOf(desc, env, SourceLoc("a test fixture's scalar type", []))
	if (!t.ok) {
		throw new Error(`the registry refuses a test fixture's type: ${t.error.message}`)
	}
	return t.value
}
