import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { PhysicalNames } from "#compiler/lower/conservative/types.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import type { Mutant } from "#test/support/oracle/mutants/mutants.ts"
import { conservative, type Lowering } from "#test/support/oracle/runner.ts"

/**
 * The mutant suite: I1-I8 and V1-V6 as post-processors of the
 * conservative lowering's output, the cases each runs on, and the Lowering a mutant is to the runner.
 *
 * The conservative lowering with the mutant applied to its statements.
 */
export const mutantLowering = (mutant: Mutant): Lowering => ({
	name: `mutant ${mutant.id}`,
	lower: (input) =>
		Result.flatMap(conservative.lower(input), (program) =>
			Result.map(mutant.mutate(program, input.case), (m) => m.program)
		)
})

/**
 * What a mutant does to a case: the rewrites it makes, 0 when its rule finds nothing to apply to, so the case cannot
 * tell the mutant from the conservative lowering and need not run; or why it could not be applied, a harness failure
 * (the conservative lowering refused the case, or the rewritten statement does not emit). Names do not change a
 * program's shape, so the declared-name conversion stands in for the installed names.
 */
export type MutationSites =
	| { readonly kind: "sites"; readonly sites: number }
	| { readonly kind: "refused"; readonly stage: "lower" | "mutate"; readonly message: string }

const refusedBy = (stage: "lower" | "mutate", e: CompileError): MutationSites => ({
	kind: "refused",
	stage,
	message: e.message
})

/**
 * The declared-name conversion with a domain for every text refinement, as an installation names one: the
 * conservative lowering casts a delivered refined value it cannot prove to its domain and refuses one whose refinement
 * has no domain name, so the door's stand-in names give each pattern a deterministic text refinement domain.
 */
const declaredNames = (schema: string): PhysicalNames => standInNames(schema)

export const mutationSites = (mutant: Mutant, c: QueryCase): MutationSites => {
	const program = conservative.lower({ case: c, names: declaredNames(c.schema.name) })
	if (!program.ok) {
		return refusedBy("lower", program.error)
	}
	const mutated = mutant.mutate(program.value, c)
	return mutated.ok
		? { kind: "sites", sites: mutated.value.sites }
		: refusedBy("mutate", mutated.error)
}
