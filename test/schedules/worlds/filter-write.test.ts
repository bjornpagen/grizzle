import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/filter-write.fixtures.ts"

export const aWriteThroughAnEntryRacingAWriteToTheRelationItsFilterReadsIsOneSerialOrdersOutcome =
	worldRaceSuite({
		space: caseGen,
		race,
		required: ["ended: commit", "ended: refusal", "overlapping", "pool of 1", "pool of 2"],
		kept: []
	})
