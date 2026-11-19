import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/hidden-key.fixtures.ts"

export const aKeyCollisionWithAFactAnotherWorldInsertsConcurrentlyIsRefusedByTheKeysLawOrFailsTransiently =
	worldRaceSuite({
		space: caseGen,
		race,
		required: ["ended: commit", "ended: refusal", "observed: invariant-rejected", "overlapping"],
		kept: []
	})
