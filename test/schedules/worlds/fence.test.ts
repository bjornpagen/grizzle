import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	caseGen,
	cases,
	fenced,
	type FenceFeature,
	situations
} from "#test/schedules/worlds/fence.fixtures.ts"
import { Substrate, baseSubstrate } from "#test/support/substrate/substrate.ts"

/**
 * Worlds schedule: the ledger's fence a Db never waits on a migration, which waits only for the transaction in flight.
 *
 * Its pre-conversion budget: runs cases, coverage cases 4 * cases (test/schedules/worlds/fence.test.ts at d8eed1786).
 */
export const worldsScheduleTheLedgersFenceADbNeverWaitsOnAMigrationWhichWaitsOnlyForTheTransactionInFlight =
	property.explore(caseGen, {
		needs: { substrate: Substrate.fresh(baseSubstrate) },
		situations: situations satisfies ReadonlyArray<Reached<FenceFeature>>,
		check:
			({ substrate }, c: Case<FenceFeature>) =>
			(fc) =>
				Effect.provideServiceEffect(
					Effect.scoped(fenced(fc, c)),
					Substrate,
					Effect.map(substrate, (taken) => taken.substrate)
				),
		oracle: {
			kind: "second-implementation",
			name: "the worlds model in the state a running migration leaves, every call answered while the migration waits behind the transaction in flight"
		},
		budget: { runs: cases, steered: 4 * cases },
		kept: [],
		kills: []
	})
