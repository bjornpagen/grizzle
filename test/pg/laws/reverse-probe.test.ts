import type { Reached } from "@bjornpagen/testing/features"
import { aimed, array } from "@bjornpagen/testing/gen"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	axisFeatures,
	cases,
	probeBatch,
	type ProbeFeature
} from "#test/pg/laws/reverse-probe.fixtures.ts"
import { freeBetweenCaseGen, reverseCaseGen, reverseFeatures } from "#test/support/laws/reverse.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A containment's reverse probe, generated is served by the source's index of the method the rule plans, and a text of no bound stores 10,000 bytes.
 *
 * Its pre-conversion budget: runs 1, coverage cases 1 (test/pg/laws/reverse-probe.test.ts at 8e0978628).
 */
export const aContainmentsReverseProbeGeneratedIsServedByTheSourcesIndexOfTheMethodTheRulePlansAndATextOfNoBoundStores10000Bytes =
	property.explore(
		aimed(array(reverseCaseGen, { min: cases, max: cases }), [
			[
				"free text between",
				(source) => [
					source.draw(freeBetweenCaseGen),
					...source.draw(array(reverseCaseGen, { min: cases - 1, max: cases - 1 }))
				]
			]
		]),
		{
			needs: { substrate: Substrate.installing },
			situations: [
				...reverseFeatures,
				"a wide text stored",
				...axisFeatures
			] satisfies ReadonlyArray<Reached<ProbeFeature>>,
			check:
				({ substrate }, c: CaseOf<ProbeFeature>) =>
				(b) =>
					Effect.provideServiceEffect(probeBatch(b, c.noteAll), Substrate, substrate),
			oracle: {
				kind: "specification",
				name: "the reverse-index rule (test/support/laws/reverse.ts expectedOf), judged by PostgreSQL's plan of each foreign key's probe"
			},
			budget: { runs: 1, steered: 1 },
			kept: [],
			kills: []
		}
	)
