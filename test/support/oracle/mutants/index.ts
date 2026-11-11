import type { CompileError } from "#compiler/core/errors.ts"
import * as Result from "#compiler/core/result.ts"
import type { PhysicalNames } from "#compiler/ir/physical.ts"
import { standInNames } from "#test/support/kernel/naming.ts"
import type { QueryCase } from "#test/support/oracle/gen/case.ts"
import { schemaCodes } from "#test/support/oracle/gen/schema.ts"
import type { Mutant } from "#test/support/oracle/mutants/mutants.ts"
import {
	conservativeProgram,
	type Lowering,
	sentConservative
} from "#test/support/oracle/runner.ts"

/**
 * The mutant suite: I1-I8 and V1-V6 as post-processors of the
 * conservative lowering's output, the cases each runs on, and the Lowering a mutant is to the runner.
 *
 * The conservative lowering with the mutant applied to its statements.
 */
export const mutantLowering = (mutant: Mutant): Lowering => ({
	name: `mutant ${mutant.id}`,
	lower: (input) =>
		Result.flatMap(conservativeProgram(input), (program) =>
			Result.flatMap(mutant.mutate(program, input.case), (m) => sentConservative(m.program))
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
 * has no domain name, so the door's stand-in names give each pattern a deterministic text refinement domain. Every
 * code literal reads the case's codes.
 */
const declaredNames = (c: QueryCase): PhysicalNames =>
	standInNames(c.schema.name, schemaCodes(c.schema))

export const mutationSites = (mutant: Mutant, c: QueryCase): MutationSites => {
	const program = conservativeProgram({ case: c, names: declaredNames(c) })
	if (!program.ok) {
		return refusedBy("lower", program.error)
	}
	const mutated = mutant.mutate(program.value, c)
	return mutated.ok
		? { kind: "sites", sites: mutated.value.sites }
		: refusedBy("mutate", mutated.error)
}
