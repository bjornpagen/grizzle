/**
 * A judged read's index requests read its DAG in one walk (physical/access/extract.ts extractJudgedReads): its lookups and
 * its suffix seeks are read off one Extractor (physical/ddl/rules.ts requestsOf), where each was read off a walk of its
 * own, two walks of every judged statement's DAG for each of a ledger's thousands of judged statements. The work is
 * counted, never timed (test/support/kernel/calls.ts): the calls of the walk's `visit`, against extractAccess, the one
 * walk of a workload's program.
 *
 * Oracle: the walk extractAccess makes of the same roots, which visits each node as one walk does.
 *
 * Features: a DAG whose walk finds a lookup; one whose walk finds none.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { extractAccess, extractJudgedReads } from "#compiler/physical/access/extract.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { defaultGenConfig, queryCaseGen } from "#test/support/oracle/gen/case.ts"

type Feature = "a walk finding a lookup" | "a walk finding none"

const visits = { file: "packages/engine/src/physical/access/extract.ts", name: "visit" } as const

/** A judged read's lookups and suffix seeks are read off one walk of its DAG, as many visits as a workload's one walk. */
export const aJudgedReadsLookupsAndSuffixSeeksAreReadOffOneWalkOfItsDag = property.explore(
	queryCaseGen(defaultGenConfig),
	{
		needs: {},
		budget: { runs: 100, steered: 100 },
		situations: ["a walk finding a lookup", "a walk finding none"] satisfies ReadonlyArray<
			Reached<Feature>
		>,
		check: (_, c: Case<Feature>) => (q) =>
			Effect.gen(function* () {
				const roots = q.query.dag.roots
				const [, access] = yield* callCounts(
					Effect.sync(() =>
						extractAccess(roots, { pageable: [], keyOrders: () => [], worlds: () => undefined })
					),
					{ visits }
				)
				const [reads, judged] = yield* callCounts(
					Effect.sync(() =>
						extractJudgedReads(roots, {
							pageable: [],
							keyOrders: () => [],
							worlds: () => undefined
						})
					),
					{ visits }
				)
				assert.equal(
					judged.visits,
					access.visits,
					"a judged read's walk visits as a workload program's one walk does"
				)
				c.note(reads.lookups.length > 0 ? "a walk finding a lookup" : "a walk finding none")
			}),
		oracle: {
			kind: "second-implementation",
			name: "extractAccess's one walk of the same roots"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original:
					"\tconst x = extracted(roots, options)\n\tconst once = new Map<string, SuffixSeek>()\n",
				replacement:
					"\tconst x = extracted(roots, options)\n\textracted(roots, options)\n\tconst once = new Map<string, SuffixSeek>()\n",
				why: "The suffix seeks are read off a walk of their own again, as requestsOf did before: every judged read walks its DAG twice, and the property fails."
			}
		]
	}
)
