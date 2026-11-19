import { domainRefusing, focus, installs, required } from "#test/pg/world-model/rules.fixtures.ts"
import { witnessesShowTheirOwn } from "#test/support/worlds/drive/acting.ts"
import {
	dbSession,
	drawnRealities,
	leadsOf,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: rules: every law family meets writes through partial worlds, and span-keyed and pure-set entries write as the model says. */
export const rules = programProperty({
	installs,
	focus,
	steps: 10,
	cases: 24,
	required,
	realities: drawnRealities,
	lead: leadsOf(dbSession(required), domainRefusing),
	check: witnessesShowTheirOwn,
	kept: [],
	kills: []
})
