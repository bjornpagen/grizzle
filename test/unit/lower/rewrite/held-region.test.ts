/**
 * The shared restriction (lower/optimize/pushdown/shared.ts) reads the value every reader keeps a shared node at through
 * a region that dominates every reader, every path from a root to each passing through it (heldOf, grizzle-text
 * base/graph.ts immediateDominators), never through one whose subtree merely holds them: a reader another region reads
 * too is spelled outside the first, where the restriction's correlation would read a column of no node in scope. An
 * import two steps of a whole rule read at one key is such a reader: edullm's result installation, its imports of one
 * Description identity made one node, refused at conservative lowering, `a column n478.__unit0 of a node in scope`, a
 * step's channel slot.
 *
 * The box, exhausted: an outer region over Edge and one, two or three lateral regions correlated to its value, each
 * reading the two readers of one scan of Edge, each reader correlated to that value at the scan's key (held-region
 * .fixtures.ts caseOf).
 *
 * Property: the restriction leaves a DAG every column reference of which names a node in its scope (the tests' strict
 * re-reader), which the conservative lowering lowers, and restricts the scan at the one lateral region where it alone
 * dominates the readers, at none where two or three share them. Oracle: the box's own construction, its dominators
 * read off it. Kill: the region read as the outermost whose subtree holds every reader, as it was, which restricts at a
 * lateral region another lateral region's path passes by, and the re-reader refuses it.
 *
 * Features: one lateral region, several.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { lateralsGen, restricted } from "#test/unit/lower/rewrite/held-region.fixtures.ts"

type Situation = "one lateral region" | "several lateral regions"

/** The shared restriction reads its value through a region that dominates every reader, and leaves a valid DAG. */
export const theSharedRestrictionReadsItsValueThroughARegionThatDominatesEveryReader =
	property.exhaust(lateralsGen, {
		needs: {},
		situations: ["one lateral region", "several lateral regions"] satisfies ReadonlyArray<
			Reached<Situation>
		>,
		check: (_, c: Case<Situation>) => (laterals) =>
			Effect.sync(() => {
				c.note(laterals === 1 ? "one lateral region" : "several lateral regions")
				assert.equal(
					restricted(laterals),
					laterals === 1 ? 1 : 0,
					laterals === 1
						? "the scan restricted at the one lateral region, which dominates its readers"
						: "no region but the outer, whose value is bound, dominates the readers: the scan is left as it is"
				)
			}),
		oracle: {
			kind: "specification",
			name: "the box's construction: the lateral region dominates the readers only where it is the one"
		},
		box: "an outer region and one, two or three lateral regions correlated to its value, each reading the two readers of one scan",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/optimize/pushdown/shared.ts",
				original:
					'\tconst enclosing: Array<Cell> = []\n\tfor (let at = dominator(cell); at !== undefined; at = dominator(at)) {\n\t\tif (at.current.kind === "MatchRegion" && !rs.includes(at)) {\n\t\t\tenclosing.push(at)\n\t\t}\n\t}\n',
				replacement:
					'\tconst enclosing = order.filter((c) => {\n\t\tconst below = DagEditor.subtree(c)\n\t\treturn c.current.kind === "MatchRegion" && !rs.includes(c) && rs.every((r) => below.has(r))\n\t})\n',
				why: "A region whose subtree holds every reader stands for one that dominates them, as it did: with two lateral regions the scan is restricted at the first, which the second's path passes by, and the restriction's correlation names a column of no node in scope."
			}
		]
	})
