/**
 * The certifier places each read of a statement once for every mode and seal it takes (analysis/isolation/certify.ts
 * readsOf, placedRead): the instances of one query CTE at one place, reading one read fact, are one read of the
 * statement, so a round's views hold one placed read for each, where they held one for every instance that read it,
 * the expansion of each query CTE's shared reads at every arrival. On edullm's qti at hub 218b37a8e, 47 s into
 * certification, the views held 5,341,042 placed reads and the sites and reasons drawn from them, 1.2 GB of the heap
 * (perf/perf-phys/qti-cert-holders-218.md). The work is counted (test/support/kernel/calls.ts): the calls of
 * placedRead.
 *
 * The box: certify.test.ts's shared cases (test/unit/analysis/isolation/certify.fixtures.ts sharedCaseGen), certified
 * over their shared facts and over their expansions (flatFacts), which the certifier judges alike (certify.test.ts).
 *
 * Oracle: a bound read off the expansion: the shared facts place no more reads than their expansion does, every
 * instance's read there a read of its own; and fewer wherever one read of a query CTE takes one mode at two instances
 * (readModes, the reads at every instance).
 *
 * Features: a read of a query CTE taking one mode at two instances; a case of no such read.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { callCounts } from "#test/support/kernel/calls.ts"
import {
	flatFacts,
	sharedCaseGen,
	sharedCertified
} from "#test/unit/analysis/isolation/certify.fixtures.ts"
import { sharedRead } from "#test/unit/analysis/isolation/placed-reads.fixtures.ts"

type Situation = "a read of a query CTE taking one mode at two instances" | "a case of no such read"

const placings = {
	file: "packages/engine/src/analysis/isolation/certify.ts",
	name: "placedRead"
} as const

/** The certifier places each read of a statement once for every mode it takes, however many instances of its query CTE read it. */
export const theCertifierPlacesEachReadOfAStatementOnceForEveryModeItTakesHoweverManyInstancesOfItsQueryCteReadIt =
	property.explore(sharedCaseGen, {
		needs: {},
		budget: { runs: 60, steered: 60 },
		situations: [
			"a read of a query CTE taking one mode at two instances",
			"a case of no such read"
		] satisfies ReadonlyArray<Reached<Situation>>,
		check: (_, c: Case<Situation>) => (drawn) =>
			Effect.gen(function* () {
				const [, shared] = yield* callCounts(
					Effect.sync(() => sharedCertified(drawn, (st) => st)),
					{ placed: placings }
				)
				const [, flat] = yield* callCounts(
					Effect.sync(() => sharedCertified(drawn, flatFacts)),
					{ placed: placings }
				)
				assert.ok(
					shared.placed <= flat.placed,
					`the shared facts place ${shared.placed} reads, no more than their expansion's ${flat.placed}`
				)
				if (sharedRead(drawn)) {
					assert.ok(
						shared.placed < flat.placed,
						`a read of a query CTE taking one mode at two instances is placed once: ${shared.placed} against the expansion's ${flat.placed}`
					)
					c.note("a read of a query CTE taking one mode at two instances")
				} else {
					c.note("a case of no such read")
				}
			}),
		oracle: {
			kind: "universal",
			name: "a bound: no more placed reads than the expansion's, fewer where a query CTE's read takes one mode at two instances"
		},
		kept: [
			{
				token: ReplayToken(
					"test/unit/analysis/isolation/placed-reads.test.ts#theCertifierPlacesEachReadOfAStatementOnceForEveryModeItTakesHoweverManyInstancesOfItsQueryCteReadIt:-:0.0.1.0.0.1.0.0.0.0.1.0.0.0.0.1.0.0.0.0.1.0.0.0.1.0.0.1.1.2.0.0.1.0.0.0.0.1.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.1.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.0.0.0.2.0.0.0.0.0.0.0.0.1.0.0.0.0.0.0.0.2.0.0.1.0.0.0.0.0.0.0.0.0.0"
				),
				reason:
					"TOOLTRUST's run at 3c68ea225, rotating seed 0x41ff41a9, case 45, shrunk: two instances of one query whose read binds its key to $p1 at one and $p0 at the other, two read facts, each placed",
				since: "2026-11-24"
			}
		],
		kills: [
			{
				file: "packages/engine/src/analysis/isolation/certify.ts",
				original: "\t\t\t\tif (place.cte !== undefined && seen.has(key)) {\n",
				replacement: "\t\t\t\tif (false) {\n",
				why: "Each instance of a query CTE places its reads again, as at 218b37a8e: a read taking one mode at two instances is placed twice, as its expansion places it, and the property fails."
			},
			{
				file: "test/unit/analysis/isolation/placed-reads.fixtures.ts",
				original: "\t\t\t\t\t\tconst read = cte?.reads[r.at.read]\n",
				replacement: "\t\t\t\t\t\tconst read = undefined\n",
				why: "The oracle keys a read of a query CTE by its place alone, not the read fact, as it did: two instances of one query reading two facts at one place are expected placed once; the kept pair of bindings fails."
			}
		]
	})
