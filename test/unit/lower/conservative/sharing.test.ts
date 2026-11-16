/**
 * The conservative lowering lowers a node its statement reads more than once once (lower/conservative/dispatch.ts
 * sharedOf): a DAG whose paths double at every level, each level a region matching the level below it twice, lowers to
 * statements that grow at most linearly with its depth. Each statement passes both SQL audits, and the statements are
 * counted as AST nodes (a structural property, never printed text): one more level costs no more at depth 2d than at
 * depth d, where a lowering that unfolds the DAG into its paths pays 2^d for a level at depth d. Exhausted over where
 * the levels read their values from, and over d:
 *
 * - nothing outside them: each level is a CTE of the statement;
 * - a parent row, the levels being an attachment's child: each is a CTE of the child, evaluated per parent row;
 * - the region they are a source of, the levels reading its first occurrence: each is a CTE of the source the region
 *   reads LATERAL, evaluated per row of that occurrence.
 *
 * Oracle: at most linear growth stated as a checker (a specification): a level's marginal cost does not grow with the
 * depth it is added at. Features: each placement.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { assert } from "#test/support/assert.ts"
import {
	loweredSize,
	placed,
	type Placement,
	placements
} from "#test/unit/lower/conservative/sharing.fixtures.ts"

/** Shared nodes a DAG of 2^d paths lowers to statements that grow at most linearly with d, wherever its shared levels read from. */
export const sharedNodesADAGOf2DPathsLowersToStatementsThatGrowAtMostLinearlyWithDWhereverItsSharedLevelsReadFrom =
	property.exhaust(
		finite((source) => [source.draw(element(placements)), source.draw(int(3, 4))] as const),
		{
			needs: {},
			situations: placements satisfies ReadonlyArray<Reached<Placement>>,
			check:
				(_, c: Case<Placement>) =>
				([placement, depth]) =>
					Effect.sync(() => {
						const at = `${placement}, a level at depth ${depth} against one at ${2 * depth}`
						const levelCost = (level: number) =>
							loweredSize(placed(placement, level + 1), at) -
							loweredSize(placed(placement, level), at)
						const shallow = levelCost(depth)
						const deep = levelCost(2 * depth)
						assert.ok(
							deep <= shallow,
							`${at}: a level costs ${shallow} AST nodes at depth ${depth} and ${deep} at depth ${2 * depth}`
						)
						c.note(placement)
					}),
			oracle: {
				kind: "specification",
				name: "at most linear growth: one more level costs no more AST nodes at depth 2d than at depth d"
			},
			box: "each of three placements, a level added at depth 3 or 4 and at twice that depth",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/dispatch.ts",
					original: "\treturn shared",
					replacement: "\treturn new Set<RelNode>()",
					why: "A lowering that shares no node, so the DAG unfolds into its paths; the linear growth search fails."
				}
			]
		}
	)
