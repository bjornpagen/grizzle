import { SourceLoc } from "#compiler/core/loc.ts"
import type { ScalarType } from "#compiler/ir/scalar.ts"
import { natural } from "#compiler/public/fields.ts"
import { contractPredicateTable } from "#compiler/scalar/compute/total.ts"
import { noRosters, type ScalarEnv, scalarTypeOf } from "#compiler/scalar/registry.ts"
import { describedField } from "#compiler/schema/protocol.ts"
import { AnalyzedPatterns } from "#compiler/text/refinement.ts"

/**
 * natural, the builtin contract over bigint whose predicate refuses every negative (scalar/natural.ts): a count's
 * type, which a generated query's literal takes in a union arm beside one, so its classes are int8's that it admits.
 */
export const naturalType: ScalarType = ((): ScalarType => {
	const loc = SourceLoc("natural", [])
	const patterns = new AnalyzedPatterns()
	/** A schema's registry, which compiles a contract's predicate into the table its type carries (a builder's keeps none). */
	const env: ScalarEnv = {
		kind: "schema",
		roster: noRosters,
		contractPredicate: (predicate, base, contract, facts) =>
			contractPredicateTable(predicate, base, contract, facts, {
				loc,
				fieldType: (desc, at) => scalarTypeOf(desc, env, at),
				patterns
			})
	}
	const typed = scalarTypeOf(describedField(natural, "natural").desc, env, loc)
	if (!typed.ok) {
		throw new Error(`natural's type: ${typed.error.message}`)
	}
	return typed.value
})()
