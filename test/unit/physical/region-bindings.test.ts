/**
 * Access extraction reads each variable class's bindings of a region from an index built once (physical/access/extract.ts
 * regionFacts `bindingsOf`): every binding's class is its variable's, fixed when the region's occurrences are read, so
 * one pass over the bindings indexes them all, where each class asked scanned every binding of the region and read its
 * class, once for the class and once more for each of its bindings a join paired (`relate`). On the ledger's installation
 * (edullm qti-pie, its result composition without its login), the scans took 0.9 s of each 120 s of its judge's compile
 * (lane PERF-PHYS's profile at d422b835a). And it reads each heading column's base type into an index of the heading's
 * carriers built once (`carriersOf`), where each column a context fixed scanned its node's heading and read the column's
 * base type again (`carrierOf`): 3.6 s of qti's app login's 482 s in its workload at f1bf91a2f. The work is counted,
 * never timed (test/support/kernel/calls.ts): the calls of classOfVar, and of baseOf.
 *
 * Oracle: linearity, read off the region: every occurrence is alike, so each costs the extraction what the third added
 * to the second.
 *
 * Features: a chained region and a region of one shared class; a region of one occurrence and of sixteen.
 */

import { type Reached as ReachedOf } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property, ReplayToken } from "@bjornpagen/testing/property"
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
	"every region of one to sixteen occurrences of Task, chained by columns no key holds or sharing one variable"

/** Extracting a region's access reads each binding's variable class a fixed number of times, however wide the region. */
export const extractingARegionReadsEachBindingsClassAFixedNumberOfTimes = property.exhaust(
	finite(regionGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (region) => judgedRegion(region, "classes", c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of classOfVar extracting a region of w occurrences are its two occurrences' and w − 2 times what the third occurrence added"
		},
		box,
		kept: [
			{
				token: ReplayToken(
					"test/unit/physical/region-bindings.test.ts#extractingARegionReadsEachBindingsClassAFixedNumberOfTimes:-:0.0"
				),
				reason:
					"the chained region of Task, each next occurrence's id bound to the variable its predecessor's account binds, is read from its root since SIP-P3's chain decision (a4234a7176, cte-policy rootChain), so the extraction asks its chain's steps alone and reads no facts and no class: the region of two read none, and the law's measure was empty; the chained box joins its occurrences at columns no key holds, a region no chain reads",
				since: "2026-11-27"
			}
		],
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

/** Extracting a region's access reads each heading column's base type a fixed number of times, however wide the region. */
export const extractingARegionReadsEachHeadingColumnsBaseTypeAFixedNumberOfTimes = property.exhaust(
	finite(regionGen),
	{
		needs: {},
		situations,
		check: (_, c: Case<Reached>) => (region) => judgedRegion(region, "carriers", c.note),
		oracle: {
			kind: "universal",
			name: "linearity: the calls of baseOf extracting a region of w occurrences are its two occurrences' and w − 2 times what the third occurrence added"
		},
		box,
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/access/extract.ts",
				original: "\tcarriers.getOrInsertComputed(heading, carriersOf).get(column)",
				replacement:
					"\t((c) => (c === undefined ? undefined : baseOf(c.type).carrier))(heading.find((h) => h.name === column))",
				why: "Each read of a column's carrier scans its heading and reads the column's base type, as the extraction did at f1bf91a2f: in a region of one shared class each occurrence's every partner reads its fixed columns' carriers again, the reads grow with the square of the width, and the property fails."
			}
		]
	}
)
