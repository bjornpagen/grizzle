import type { Reached } from "@bjornpagen/testing/features"
import { type Case as CaseOf, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { batch, checkBatch, type Feature, requiredForms } from "#test/pg/laws/checks.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * Row checks, generated the installed CHECK stores exactly the rows the predicate holds on.
 *
 * Its pre-conversion budget: runs 1, coverage cases 1 (test/pg/laws/checks.test.ts at 8e0978628).
 */
export const rowChecksGeneratedTheInstalledCHECKStoresExactlyTheRowsThePredicateHoldsOn =
	property.explore(batch, {
		needs: { substrate: Substrate.installing },
		situations: requiredForms satisfies ReadonlyArray<Reached<Feature>>,
		check:
			({ substrate }, c: CaseOf<Feature>) =>
			(b) =>
				Effect.provideServiceEffect(checkBatch(b, c.noteAll), Substrate, substrate),
		oracle: {
			kind: "second-implementation",
			name: "the predicate evaluated on the host in two-valued logic over the NOT NULL row (holds)"
		},
		budget: { runs: 1, steered: 1 },
		kept: [],
		kills: []
	})
