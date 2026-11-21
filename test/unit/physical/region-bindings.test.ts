/**
 * Access extraction reads each variable class's bindings of a region from an index built once (physical/access/extract.ts
 * regionFacts `bindingsOf`): every binding's class is its variable's, fixed when the region's occurrences are read, so
 * one pass over the bindings indexes them all, where each class asked scanned every binding of the region and read its
 * class, once for the class and once more for each of its bindings a join paired (`relate`). On the ledger's installation
 * (edullm qti-pie, its result composition without its login), the scans took 0.9 s of each 120 s of its judge's compile
 * (lane PERF-PHYS's profile at d422b835a). The work is counted, never timed (test/support/kernel/calls.ts): the calls of
 * classOfVar.
 *
 * Oracle: linearity, read off the region: every occurrence is alike, so each costs the extraction what the third added
 * to the second.
 *
 * Features: a chained region and a region of one shared class; a region of one occurrence and of sixteen.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	judgedRegion,
	type Reached,
	regionGen
} from "#test/unit/physical/region-bindings.fixtures.ts"

const situations = [
	"a chained region",
	"a region of one shared class",
	"a region of one occurrence",
	"a region of sixteen occurrences"
] as const satisfies ReadonlyArray<ReachedOf<Reached>>

const box =
	"every region of one to sixteen occurrences of Task, chained by their columns or sharing one variable"

/** Extracting a region's access reads each binding's variable class a fixed number of times, however wide the region. */
export const extractingARegionReadsEachBindingsClassAFixedNumberOfTimes = property.exhaust(
	finite(regionGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (region) => judgedRegion(region, c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of classOfVar extracting a region of w occurrences are its two occurrences' and w − 2 times what the third occurrence added"
		},
		box,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original:
					"\tconst bindingsOf = (k: number): ReadonlyArray<SiteBinding> => byClass.get(k) ?? []",
				replacement:
					"\tconst bindingsOf = (k: number): ReadonlyArray<SiteBinding> => sites.flatMap(({ occurrence, facts }, at) => occurrence.bindings.filter((b) => classOfVar(b.var) === k).map((b) => ({ at, column: b.column, facts })))",
				why: "Each class asked scans every binding of the region and reads its class, as the extraction did at d422b835a: an occurrence more adds a pass over every binding for each class and each join, the reads grow with the square of the width, and the property fails."
			}
		]
	}
)
