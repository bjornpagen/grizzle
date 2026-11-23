import { ReplayToken } from "@bjornpagen/testing/property"
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
	kept: [
		{
			token: ReplayToken(
				"test/pg/world-model/isolation-writes.test.ts#isolationWrites:70085c15c6690073d0.33:1.0.0.0.0.1.1.0.1.1.0.0.0.1.0.0.0.0.1.0.0.1.1.0.1.1.1.1.1.0.0.0.0.0.1.1.0.1.1.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.1.0.1.0.0.1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.1.0.0.0.0.0.0.0"
			),
			reason:
				"an insert of {plan_via: 0} through View0, a query entry whose head names Org's plan plan_via, its Doc and Org matched at literal keys: the served member admitted its facts by the relation's key heads, read by Org's field names, which name none of the entry's, so the host refused every fact of it as factShape (main's red at 3e47c8f8a, from GENPK's 55fce798e; its token run on to the program's end past the refused apply)",
			since: "2026-11-23"
		}
	],
	kills: [
		{
			file: "packages/engine/src/write/frontend/compile.ts",
			original:
				'\t\t\t\t\t\t\tadmitted: target.kind === "whole" ? keyHeading(relation, admitted, facts) : admitted,\n',
			replacement: "\t\t\t\t\t\t\tadmitted: keyHeading(relation, admitted, facts),\n",
			why: "A query entry's facts are admitted by the key heads of the relation it writes, read by that relation's field names, so an entry whose head renames a field (View0's plan_via, Org's plan) admits its facts by an empty heading and the host refuses every one as factShape: the defect this property met at main's 3e47c8f8a, from GENPK's 55fce798e."
		},
		{
			file: "packages/engine/src/runtime/write/normalize.ts",
			original: "\trelation: facts.relation,\n",
			replacement: "\trelation: facts.stated,\n",
			why: 'Two facts of one key written through a query entry are refused as a key conflict named by the entry, where the key\'s constraint is on its stored relation\'s table, so the served refusal tables hold no table of it and the apply dies "grizzle internal invariant: the installation stores relation MyBooking, which a write statement wrote": the defect the isolation suite this property was split from met at the 26e3c15f pin (its "second cause", TODO at 153af6b60), which d5bd99bdd fixed.'
		}
	]
})
