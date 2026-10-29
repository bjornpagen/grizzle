/** The optimized lowering never reproduces the counterexamples of I6-I8 (counterexamples.ts). */

import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { nonReproduction, populations, within } from "#test/pg/oracle/optimized/counterexamples.ts"
import { mutants } from "#test/support/oracle/mutants/mutants.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

layer(Substrate.layer)("the optimized lowering against the invalid mutants I6-I8", (it) => {
	for (const population of populations.slice(5)) {
		const mutant = mutants[population.id]
		it.effect(
			`${population.id} (${mutant.check}): never reproduced in ${within} cases that kill the mutant`,
			(ctx) => searched(ctx, nonReproduction(population)),
			900_000
		)
	}
})
