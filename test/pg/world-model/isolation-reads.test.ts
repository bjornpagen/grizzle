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
	required: readsRequired,
	realities: docsChainedRealities,
	lead: leadsOf(directTransaction(readsRequired), dbSession(readsRequired)),
	check: noCheck,
	kept: [],
	kills: [
		{
			file: "packages/engine/src/check/recursion/scan.ts",
			original: "\t\t\t? reads(source.name)\n",
			replacement: "\t\t\t? undefined\n",
			why: "A recursion's step that names a role's query entry of several rules reads it through the entry's view as a relation, which the scan never reads as a union, so the step compiles with PostgreSQL inlining the union into every step, where it is refused as RecursionRefused, unionStep: the defect this property met at trunk's TEST_SEED=2219874524 (replay isolationReads:400080000.22), which 0dd538e30 fixed."
		}
	]
})
