import { reads, readsRequired } from "#test/pg/world-model/isolation-reads.fixtures.ts"
import {
	dbSession,
	directTransaction,
	docsChainedRealities,
	docsInstalls,
	leadsOf,
	noCheck,
	programProperty
} from "#test/support/worlds/drive/suite.ts"

/** The worlds model: isolation, reads: every role reads exactly its world. */
export const isolationReads = programProperty({
	installs: docsInstalls,
	focus: reads,
	steps: 10,
	cases: 24,
	required: readsRequired,
	realities: docsChainedRealities,
	lead: leadsOf(directTransaction(readsRequired), dbSession(readsRequired)),
	check: noCheck,
	kept: []
})
