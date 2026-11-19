import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/hidden-share-key.fixtures.ts"

export const writersMeetingAKeyOverFactsOutsideTheirWorldsNeverBreakIt = worldRaceSuite({
	space: caseGen,
	race,
	required: ["ended: commit", "ended: refusal", "overlapping"],
	kept: []
})
