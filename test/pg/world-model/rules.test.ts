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
	required,
	realities: drawnRealities,
	lead: leadsOf(dbSession(required), domainRefusing),
	check: witnessesShowTheirOwn,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/write/normalize.ts",
			original: "\trelation: facts.relation,\n",
			replacement: "\trelation: facts.stated,\n",
			why: "Two facts of one key written through a query entry are refused as a key conflict named by the entry, where the key's constraint is on its stored relation's table, so the served refusal tables hold no table of it and the apply dies \"grizzle internal invariant: the installation stores relation MyBooking, which a write statement wrote\": the defect this suite met at TEST_SEED=665578811 (4f6206e6e), which d5bd99bdd fixed."
		}
	]
})
