import { besideTheModel, required, writes } from "#test/pg/world-model/laws.fixtures.ts"
import {
	breakingAtCommit,
	dbSession,
	directTransaction,
	docsInstalls,
	docsTenantRealities,
	leadsOf,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: laws: every law holds on every committed state whoever writes, and its refusals show only what the README allows. */
export const laws = programProperty({
	installs: docsInstalls,
	focus: writes,
	steps: 10,
	cases: 24,
	required,
	realities: docsTenantRealities,
	lead: leadsOf(directTransaction(required), breakingAtCommit(required), dbSession(required)),
	check: besideTheModel,
	kept: []
})
