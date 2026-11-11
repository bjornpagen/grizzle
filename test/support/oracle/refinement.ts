import type { ScalarType } from "#compiler/ir/scalar.ts"
import { isRefined } from "#compiler/ir/scalar.ts"
import { admitLiteral } from "#compiler/scalar/compute/evaluate.ts"
import { literalDescFor } from "#compiler/scalar/literal.ts"
import type { PatternReads } from "#compiler/scalar/regex/patterns.ts"

/**
 * The host's judgement of a refined type's values, the test-only copy of the bind-time check grizzle deleted when
 * PostgreSQL became the one judge of a parameter's contract and pattern (codec/scalar.ts paramEncoder, its placeholder
 * cast to the refinement's domain): whether a value is one of the type's, every contract level's predicate and every
 * regex holding of it, judged as a literal at the type is (scalar/compute/evaluate.ts admitLiteral), by the automata of
 * `patterns`. Undefined for a type with no refinement. The differential (test/pg/input/differential.test.ts) runs it as
 * the old validator's oracle: every value it refuses PostgreSQL must refuse by the same law.
 */
export const refinedMember = (
	type: ScalarType,
	patterns: PatternReads
): ((value: unknown) => boolean) | undefined => {
	if (!isRefined(type)) {
		return undefined
	}
	return (value) => {
		const literal = literalDescFor(type, value)
		return literal.ok && admitLiteral(literal.value, type, { kind: "refinements", patterns }).ok
	}
}
