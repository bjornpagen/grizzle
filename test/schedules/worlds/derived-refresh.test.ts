import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/derived-refresh.fixtures.ts"

export const aDeletionRacingReadsAndRefreshesOfADerivedRelationShowsTheRelationAsOfASerialOrdersLastRefresh =
	worldRaceSuite({
		space: caseGen,
		race,
		required: ["ended: commit", "observed: rows", "observed: ok"],
		kept: []
	})
