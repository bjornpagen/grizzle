/**
 * The minimum chain cover (physical/indexes/chains.ts) the index engine plans the fewest exact indexes by: over drawn
 * families of one to eight distinct nonempty sets of two to five columns, the cover holds every member exactly once,
 * each chain's members each a proper subset of the next, in exactly as many chains as the fewest any partition of the
 * family into chains needs.
 *
 * - **Oracle:** that fewest, found by trying every assignment of the members to k chains for k from one.
 * - **Kill:** the matching taken greedily, no augmenting path through a matched member: a family first-fit covers with
 *   more chains than the fewest (a feature its witnesses must reach) is covered with more.
 */
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import {
	type ChainFeature,
	coverCase,
	familyGen,
	type GroupFeature,
	groupCase,
	requestsGen
} from "#test/unit/physical/chains.fixtures.ts"

/** A family of sets is covered by the fewest chains under inclusion, each member once. */
export const aFamilyOfSetsIsCoveredByTheFewestChainsUnderInclusionEachMemberOnce = property.explore(
	familyGen,
	{
		needs: {},
		situations: [
			"an antichain of three",
			"a chain of three",
			"members overlapping without inclusion",
			"a family first-fit covers with more chains than the fewest"
		] satisfies ReadonlyArray<Reached<ChainFeature>>,
		check: (_, c: Case<ChainFeature>) => (family) => coverCase(family, c),
		oracle: {
			kind: "specification",
			name: "Dilworth's fewest chains, found by trying every assignment of the members to k chains"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/chains.ts",
				original:
					"\t\t\tif (back !== undefined && (layer[back] !== (layer[i] ?? 0) + 1 || !augmented(back))) {",
				replacement: "\t\t\tif (back !== undefined) {",
				why: "The matching taken greedily, never augmented through a matched member: a family whose fewest chains need an augmenting path, which first-fit misses, is covered with more chains than the fewest."
			}
		]
	}
)

/**
 * Requests that each need one set or a chain of two sets to lead their index are grouped into the fewest indexes: over
 * drawn families of one to ten requests of three to six columns, each group's requests pairwise share an index (every
 * set of the one comparable with every set of the other), every request is in exactly one group, and there are as many
 * groups as the fewest any grouping needs, found by trying every assignment to k groups.
 */
export const requestsAreGroupedIntoTheFewestIndexesEachGroupsSetsOneChain = property.explore(
	requestsGen,
	{
		needs: {},
		situations: [
			"a request of two sets",
			"two requests whose lower sets clash below a shared set",
			"a family needing more groups than its widest sets' chains"
		] satisfies ReadonlyArray<Reached<GroupFeature>>,
		check: (_, c: Case<GroupFeature>) => (family) => groupCase(family, c),
		oracle: {
			kind: "specification",
			name: "the fewest groups of pairwise sharing requests, found by trying every assignment to k groups"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/physical/indexes/chains.ts",
				original:
					"\t\trequests.map((s, j) => !r.every((x) => s.every((y) => comparable(x, y))) || apart(i, j))",
				replacement:
					"\t\trequests.map((s, j) => !comparable(r[r.length - 1] ?? r[0], s[s.length - 1] ?? s[0]) || apart(i, j))",
				why: "Two requests share an index wherever their widest sets are comparable, whatever their lower sets: two requests whose lower sets clash below a shared set are put on one index, which can lead with only one of them."
			}
		]
	}
)
