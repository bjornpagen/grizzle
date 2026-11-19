import { pooled, required } from "#test/pg/world-model/pool.fixtures.ts"
import {
	callPastAMigration,
	docsInstalls,
	drawnRealities,
	noCheck,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: pooled connections: claims and role never cross requests on a pooled connection, however a transaction ends. */
export const pool = programProperty({
	installs: docsInstalls,
	focus: pooled,
	steps: 10,
	cases: 40,
	required,
	realities: drawnRealities,
	lead: callPastAMigration(required),
	check: noCheck,
	kept: []
})
