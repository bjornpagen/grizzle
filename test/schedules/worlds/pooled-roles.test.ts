import { worldRaceSuite } from "#test/schedules/worlds/support.ts"

import { caseGen, race } from "#test/schedules/worlds/pooled-roles.fixtures.ts"

export const rolesOfOneLoginInterleavedOnItsPoolLeaveNoRoleClaimsOrTransactionOnTheConnectionHoweverATransactionEnds =
	worldRaceSuite({
		space: caseGen,
		race,
		required: [
			"ended: commit",
			"ended: refusal",
			"ended: interruption",
			"probed after: interruption",
			"pool of 1",
			"blocked"
		],
		kept: []
	})
