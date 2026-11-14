import { searched } from "@bjornpagen/testing/vitest"
import { layer } from "@effect/vitest"
import { Effect } from "effect"
import { firstFailure, oracleCases } from "#scripts/dev/mutate/oracle/check.ts"
import { projectedMirrors, projectedSource } from "#test/pg/laws/projections/families.ts"
import { grizzleFirstSession, ordinarySession } from "#test/support/ambient.ts"
import {
	alternativesBox,
	type Family,
	installFamily,
	populationsOf,
	queueFamily,
	spanCoverage,
	timekeepingFamily
} from "#test/support/laws/boxes.ts"
import { familyCaseGen, runSteps } from "#test/support/laws/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Cases per drawn schema; each case is several transactions. */
const cases = Math.max(1, Math.round(oracleCases / 5))

/** The cases of one installed schema: a family's case generator over a single variant, the one installed. */
const oneSchema = familyCaseGen(1)

layer(Substrate.layer, { excludeTestServices: true })("mutation stage 2: law families", (it) => {
	const familyTests = <P>(family: Family<P>): void => {
		for (const { mode, variants } of populationsOf(family)) {
			const [first] = variants
			it.effect(`${family.label}, ${mode}: accepted iff every law holds`, (ctx) =>
				searched(
					ctx,
					Effect.gen(function* () {
						const installed = yield* installFamily(
							family,
							first,
							mode === "mutable" ? grizzleFirstSession : ordinarySession
						)
						const session = yield* family.connect(first, installed)
						return yield* firstFailure({
							suite: `mutate/laws/${family.label}/${mode}`,
							generator: oneSchema,
							runs: cases,
							property: (c, notes) => runSteps(session, family.domains, c.steps, notes.note)
						})
					}).pipe(Effect.scoped)
				)
			)
		}
	}
	familyTests(projectedSource)
	familyTests(projectedMirrors)
	familyTests(alternativesBox)
	familyTests(spanCoverage)
	familyTests(queueFamily)
	familyTests(timekeepingFamily)
})
