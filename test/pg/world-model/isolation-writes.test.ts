import { crossing, writesRequired } from "#test/pg/world-model/isolation-writes.fixtures.ts"
import { reachingPastRefused } from "#test/support/worlds/drive/acting.ts"
import {
	dbSession,
	directTransaction,
	docsInstalls,
	docsTenantRealities,
	leadsOf,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: isolation, writes: every write through an entry meets its world, and no tenant's facts or other login's objects are reachable. */
export const isolationWrites = programProperty({
	installs: docsInstalls,
	focus: crossing,
	steps: 10,
	cases: 32,
	required: writesRequired,
	realities: docsTenantRealities,
	lead: leadsOf(directTransaction(writesRequired), dbSession(writesRequired)),
	check: reachingPastRefused,
	kept: []
})
