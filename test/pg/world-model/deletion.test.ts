import { deleting, required } from "#test/pg/world-model/deletion.fixtures.ts"
import {
	dbSession,
	derivedLeftStale,
	directTransaction,
	docsInstalls,
	docsTenantRealities,
	leadsOf,
	noCheck,
	programProperty,
	readPastADelete
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: deletion: a deleted fact is gone from every world and every relation, a derived relation keeping it only until refresh. */
export const deletion = programProperty({
	installs: docsInstalls,
	focus: deleting,
	steps: 12,
	cases: 32,
	required,
	realities: docsTenantRealities,
	lead: leadsOf(
		directTransaction(required),
		readPastADelete(required),
		dbSession(required),
		derivedLeftStale(required)
	),
	check: noCheck,
	kept: [],
	kills: []
})
