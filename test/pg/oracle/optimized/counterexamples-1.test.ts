/**
 * The optimized lowering never reproduces the counterexamples of I1-I5 (counterexamples.ts).
 *
 * Oracle: the conservative lowering's raw text sets, the invalid mutant beside the optimized artifact on the same
 * installation and facts (counterexamples.ts).
 *
 * Plants: oracle-optimized-obligations-dropped (the dedup placement discharges no obligation, so the optimized
 * artifact repeats rows as the duplicate mutants do).
 *
 * Features: a case the mutant rewrote, and one on which it was told apart.
 */

import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { nonReproduction, populations, within } from "#test/pg/oracle/optimized/counterexamples.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)("the optimized lowering against the invalid mutants I1-I5", (it) => {
	for (const population of populations.slice(0, 5)) {
		const mutant = mutants[population.id]
		it.effect(
			`${population.id} (${mutant.check}): never reproduced in ${within} cases that kill the mutant`,
			(ctx) => searched(ctx, nonReproduction(population))
		)
	}
})
