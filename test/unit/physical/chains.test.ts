/**
 * The fewest indexes chained requests share (physical/indexes/chains.ts fewestSharingGroups), the index engine's chain
 * cover: an exact construction, each stage polynomial but a search over what no earlier stage settles, since the fewest
 * groups are NP-hard (the module's doc).
 *
 * - **Lookups:** over drawn families of one to eight distinct nonempty sets of two to five columns, each a one-set
 *   request, the groups hold every member exactly once, each group's sets one chain, in exactly as many groups as the
 *   fewest any partition of the family into chains needs. Oracle: that fewest, found by trying every assignment of the
 *   members to k chains for k from one. Kill: the matching taken greedily, no augmenting path through a matched member.
 * - **Requests:** over drawn families of one to ten requests of three to six columns, each a lookup, a set and a
 *   superset it leads with (a range, a whole rule's lookup) or a seek (fixed columns, then one to three order keys, each
 *   in a direction), each group's requests pairwise share an index (every set of the one comparable with every set of
 *   the other, their orders agreeing on the keys they share, each alike or each opposite), every request is in exactly
 *   one group, and there are as many groups as the fewest any grouping needs. Oracle: the fewest groups, found by trying
 *   every assignment to k groups. Kills: two requests sharing wherever their widest sets are comparable; an ordered
 *   request riding a request of its sets whatever their orders; every component's fewest chains taken for its fewest
 *   groups, transitive or not.
 * - **Kept families:** the cycle of seven over one unit and the cycle of five over two prefixes of one unit's key the
 *   module's doc names, which no orientation covers exactly, and edullm's Node, 336 requests, on which e5a20b1c4's
 *   branch and bound did not finish in 536 s: each grouped into its fewest, every group sharing, Node's 12 within the
 *   steps of its polynomial stages' own bound, n + 2d² + d³ for its n requests and d distinct ones. Kill: the search run
 *   on the raw requests, none merged or riding (114,632 steps).
 * - **Growth:** over the drawn families, each grown by repeating its requests, each followed by each of its sets alone,
 *   which rides it, as a block, the cover's steps at 2, 4 and 6 blocks grow no faster than linearly (test/support/
 *   growth.ts incrementsDoNotGrow, exact: the second increment at most the first), one step a request, the polynomial
 *   degree of every stage but the first over a family whose distinct requests stay the same. Kill: the search run on the
 *   raw requests.
 */
import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { constant, finite, oneOf } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Order } from "effect"
import { fewestSharingGroups } from "#compiler/physical/indexes/chains.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import {
	type ChainFeature,
	coverCase,
	distinctRequests,
	familyGen,
	type GroupFeature,
	groupCase,
	groupsShare,
	grownSteps,
	type KeptName,
	keptFamilies,
	requestsGen
} from "#test/unit/physical/chains.fixtures.ts"

/** The search run on the raw requests: none merged as one, none riding another. */
const rawSearch = {
	file: "packages/engine/src/physical/indexes/chains.ts",
	original: "\tconst { kernel, riders } = canonical(reads, count)",
	replacement: "\tconst { kernel, riders } = { kernel: reads, riders: new Map<number, number>() }"
} as const

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
 * Requests that each need a chain of sets to lead their index, some ordered, are grouped into the fewest indexes, each
 * group's requests pairwise sharing one.
 */
export const requestsAreGroupedIntoTheFewestIndexesEachGroupsSetsOneChain = property.explore(
	requestsGen,
	{
		needs: {},
		situations: [
			"a request of two sets",
			"two requests whose lower sets clash below a shared set",
			"a family needing more groups than its widest sets' chains",
			"a family needing more groups than its largest clash",
			"two ordered requests apart",
			"an ordered request whose sets are all an unordered one's"
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
				original: "\t\t\t\ta.sets.every((x) => b.sets.every((y) => comparable(x, y))) &&",
				replacement: "\t\t\t\tcomparable(lastNonEmpty(a.sets), lastNonEmpty(b.sets)) &&",
				why: "Two requests share an index wherever their widest sets are comparable, whatever their lower sets: two requests whose lower sets clash below a shared set are put on one index, which can lead with only one of them."
			},
			{
				file: "packages/engine/src/physical/indexes/chains.ts",
				original: "\tr.sets.every((x) => s.held.has(x)) && implied(r.constraint, s.constraint)",
				replacement: "\tr.sets.every((x) => s.held.has(x))",
				why: "An ordered request rides a request of its sets whatever their orders: a seek rides another of its sets ordered apart from it, or an unordered one beside a seek apart from it, and the two apart share a group."
			},
			{
				file: "packages/engine/src/physical/indexes/chains.ts",
				original: "\tif (transitive) {",
				replacement: "\tif (above.length >= 0) {",
				why: "Every component's fewest chains taken for its fewest groups, its orientation transitive or not: a component whose requests interleave, two lookups of one unit's prefixes or a whole rule's lookup beside a lookup of a set its unit is no part of, is cut into chains that are no groups, or into more groups than the fewest."
			}
		]
	}
)

/** The kept families' requests, by name, each as one case. */
const keptGen = finite(oneOf(Arr.map(keptFamilies, (family) => constant(family))))

/**
 * The kept families are grouped into their fewest, every group sharing, edullm's Node within the steps of its
 * polynomial stages' own bound.
 */
export const theKeptFamiliesAreGroupedIntoTheirFewestNodesWithinItsPolynomialStagesBound =
	property.exhaust(keptGen, {
		needs: {},
		situations: [
			"a cycle of seven over one unit",
			"a cycle of five over two prefixes of a unit's key",
			"edullm's Node"
		] satisfies ReadonlyArray<Reached<KeptName>>,
		check: (_, c: Case<KeptName>) => (family) =>
			Effect.sync(() => {
				c.note(family.name)
				const { groups, steps } = fewestSharingGroups(family.requests)
				assert.deepEqual(
					Arr.sort(Arr.flatten(groups), Order.Number),
					Arr.map(family.requests, (_, at) => at),
					"every request is in exactly one group"
				)
				assert.ok(groupsShare(family.requests, groups), "every group's requests share an index")
				assert.equal(groups.length, family.fewest, `${family.name} needs ${family.fewest} groups`)
				const n = family.requests.length
				const d = distinctRequests(family.requests)
				const bound = n + 2 * d * d + d * d * d
				assert.ok(
					steps <= bound,
					`${family.name}'s cover takes ${steps} steps, within its polynomial stages' bound n + 2d² + d³ = ${bound} (n ${n}, d ${d})`
				)
			}),
		oracle: {
			kind: "specification",
			name: "the fewest groups each family needs, every grouping of fewer leaving two requests that may not share in one group (the module's doc), and the bound of the cover's polynomial stages"
		},
		box: "the cycles of seven and five the module's doc names, and edullm's Node's 336 chained requests",
		kept: [],
		kills: [
			{
				...rawSearch,
				why: "The search run on the raw requests, none merged or riding: Node's 336 requests are searched whole, 114,632 steps where the cover takes 2,073, past its polynomial stages' bound of 62,697."
			}
		]
	})

/** A family grown by repeating its requests and the requests that ride them costs the cover one step a request. */
export const aFamilyGrownByRepeatingItsRequestsAndTheirRidersCostsTheCoverOneStepARequest =
	property.explore(requestsGen, {
		needs: {},
		situations: [],
		check: () => (family) =>
			Effect.sync(() => {
				incrementsDoNotGrow(
					(blocks) => grownSteps(family, blocks),
					1,
					"the cover's steps over the family's requests and their riders, repeated"
				)
			}),
		oracle: {
			kind: "universal",
			name: "a work that grows no faster than linearly increments no more over its second equal step than over its first (test/support/growth.ts)"
		},
		kept: [],
		kills: [
			{
				...rawSearch,
				why: "The search run on the raw requests: every repeated request is read against every other, the steps growing with the square of the requests."
			}
		]
	})
