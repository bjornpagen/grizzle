import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { firstFailure, oracleCases } from "#scripts/dev/mutate/oracle/check.ts"
import { runCase } from "#test/pg/oracle/public/run.ts"
import { caseGen } from "#test/support/oracle/public/generate.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Programs per mutant; each one installs its schema through a migration before it reads. */
const programs = Math.max(1, Math.round(oracleCases / 10))

layer(Substrate.layer)("mutation stage 2: the public-boundary differential", (it) => {
	it.effect("generated programs read through every public form agree with the reference", (ctx) =>
		searched(
			ctx,
			firstFailure({
				suite: "mutate/public",
				generator: caseGen,
				runs: programs,
				property: (program) =>
					Effect.scoped(Effect.suspend(() => runCase(program, () => undefined)))
			})
		)
	)
})
