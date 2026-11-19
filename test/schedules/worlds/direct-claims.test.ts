import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/direct-claims.fixtures.ts"

export const concurrentWritersThroughWorldsKeepEveryLawAndFailOnlyWithTypedTransientFailures =
	worldRaceSuite({
		space: caseGen,
		race,
		required: ["ended: commit", "ended: refusal", "observed: refused", "overlapping"],
		kept: []
	})
