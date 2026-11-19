import { constant, oneOf } from "@bjornpagen/testing/gen"
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
import { docsUnionInstall } from "#test/support/worlds/model/bases/docs.ts"

/** The worlds model: isolation, reads: every role reads exactly its world. */
export const isolationReads = programProperty({
	installs: oneOf([docsInstalls, constant(docsUnionInstall)]),
	focus: reads,
	steps: 10,
	cases: 24,
	required: readsRequired,
	realities: docsChainedRealities,
	lead: leadsOf(directTransaction(readsRequired), dbSession(readsRequired)),
	check: noCheck,
	kept: [],
	kills: [
		{
			file: "test/support/worlds/model/reads.ts",
			original: '\tentry?.kind === "query" && entry.rules.length > 1',
			replacement: "\tfalse",
			why: "The model allows a recursive read of a relation its role reads as a union, as before: the engine refuses it when the query compiles (RecursionRefused, unionStep), and follow-up 4's suite met that at 791e4f4ab (TEST_SEED=751447835, case 14); this property fails."
		}
	]
})
