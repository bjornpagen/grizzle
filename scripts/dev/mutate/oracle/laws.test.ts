import { layer } from "@effect/vitest"
import { searched } from "@grizzle/testing/vitest"
import { Effect } from "effect"
import { firstFailure, oracleCases } from "#scripts/dev/mutate/oracle/check.ts"
import {
	alternativesFamily,
	capacityFamily,
	conditionalMirrors,
	depositsFamily,
	type Family,
	installFamily,
	queueFamily,
	selectedSource,
	sharedTablesFamily,
	spanCoverage,
	timekeepingFamily
} from "#test/pg/laws/families/families.ts"
import { familyCaseGen, runSteps } from "#test/pg/laws/families/support.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/** Cases per drawn schema; each case is several transactions. */
const cases = Math.max(1, Math.round(oracleCases / 5))

/** The cases of one installed schema: a family's case generator over a single variant, the one installed. */
const oneSchema = familyCaseGen(1)

layer(Substrate.layer, { excludeTestServices: true })("mutation stage 2: law families", (it) => {
	const familyTests = <P>(family: Family<P>): void => {
		for (const isMutable of [false, true]) {
			const [first] = family.variants(isMutable)
			if (first === undefined) {
				continue
			}
			it.effect(
				`${family.label}, ${isMutable ? "mutable" : "immutable"}: accepted iff every law holds`,
				(ctx) =>
					searched(
						ctx,
						Effect.gen(function* () {
							const installed = yield* installFamily(family, first)
							const session = yield* family.connect(first, installed)
							return yield* firstFailure({
								suite: `mutate/laws/${family.label}/${isMutable ? "mutable" : "immutable"}`,
								generator: oneSchema,
								runs: cases,
								property: (c, notes) => runSteps(session, family.domains, c.steps, notes.note)
							})
						}).pipe(Effect.scoped)
					)
			)
		}
	}
	familyTests(selectedSource)
	familyTests(conditionalMirrors)
	familyTests(alternativesFamily)
	familyTests(capacityFamily)
	familyTests(sharedTablesFamily)
	familyTests(spanCoverage)
	familyTests(queueFamily)
	familyTests(timekeepingFamily)
	familyTests(depositsFamily)
})
