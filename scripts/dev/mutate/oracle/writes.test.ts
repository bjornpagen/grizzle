import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { Effect } from "effect"
import { firstFailure, oracleCases } from "#scripts/dev/mutate/oracle/check.ts"
import { runWrite, writeRunGen } from "#test/support/oracle/write/index.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Runs per mutant; each run is up to twelve write cases on one installation. */
const runs = Math.max(1, Math.round(oracleCases / 6))

layer(Substrate.layer, { excludeTestServices: true })(
	"mutation stage 2: the write oracle",
	(it) => {
		it.effect("generated ChangeSets agree three ways", (ctx) =>
			searched(
				ctx,
				firstFailure({
					suite: "mutate/writes",
					generator: writeRunGen,
					runs,
					property: (run, c) => Effect.scoped(runWrite(run, c))
				})
			)
		)
	}
)
