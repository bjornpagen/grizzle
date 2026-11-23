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

/**
 * The worlds model: isolation, writes: every write through an entry meets its world, and no tenant's facts or other
 * login's objects are reachable. Its budget is its own: its MyBooking kill survives the runner's, and its witnesses at a
 * floor of 7 cases (runs 25) kill it.
 */
export const isolationWrites = programProperty({
	installs: docsInstalls,
	focus: crossing,
	steps: 10,
	budget: { runs: 25, steered: 128 },
	required: writesRequired,
	realities: docsTenantRealities,
	lead: leadsOf(directTransaction(writesRequired), dbSession(writesRequired)),
	check: reachingPastRefused,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/runtime/write/normalize.ts",
			original: "\trelation: facts.relation,\n",
			replacement: "\trelation: facts.stated,\n",
			why: 'Two facts of one key written through a query entry are refused as a key conflict named by the entry, where the key\'s constraint is on its stored relation\'s table, so the served refusal tables hold no table of it and the apply dies "grizzle internal invariant: the installation stores relation MyBooking, which a write statement wrote": the defect the isolation suite this property was split from met at the 26e3c15f pin (its "second cause", TODO at 153af6b60), which d5bd99bdd fixed.'
		}
	]
})
