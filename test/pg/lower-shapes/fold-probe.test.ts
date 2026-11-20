/**
 * A region that joins a fold by its grouping columns reads it per key (lower/conservative/match-region keyedFolds,
 * lower/shapes/region foldProbe): for each binding of the occurrences before it, the fold of that binding's keys alone,
 * LATERAL, the keys restricted below the aggregate, where the index the workload requests on them reads one group's
 * rows. On PostgreSQL 19, over learning-commons' crosswalk (fold-probe.fixtures.ts): the pairs of one standard, each
 * with how many components support each of its ends, two occurrences of one fold of Supports by its standard. A grouped
 * derived table is never flattened, so the join of a whole fold stays above its aggregate, which then folds every
 * standard's supports twice for each read (edullm materialized it: 100 ms counting against 0.1 to 1 ms stored).
 */
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	type FoldProbeFeature,
	foldProbeGen,
	foldProbeTemplate,
	runFoldProbe
} from "#test/pg/lower-shapes/fold-probe.fixtures.ts"
import { Substrate } from "#test/support/substrate/substrate.ts"

/**
 * A read that joins a fold by its keys reads each count from its own standard's supports, so its work is the pairs it
 * delivers, never every standard stored, with statistics or none.
 *
 * Its budget is the runner's: a new property, with no suite before it to carry a count from.
 */
export const aReadThatJoinsAFoldByItsKeysFoldsEachBindingsGroupAloneSoItsWorkIsThePairsItDeliversNotTheStandardsStored =
	property.explore(foldProbeGen, {
		needs: { stored: Substrate.rolledBack(foldProbeTemplate) },
		situations: [
			"a state asked",
			"a hub asked",
			"the counts matched first"
		] satisfies ReadonlyArray<FoldProbeFeature>,
		check:
			({ stored }, c) =>
			(drawn) =>
				Effect.flatMap(stored, ({ connection, value }) =>
					runFoldProbe(value, connection, drawn, c)
				),
		oracle: {
			kind: "universal",
			name: "the host's pairs of the asked standard with each end's count of supports, and bound: the read's scans of Supports read, over every loop, at most the supports of its delivered pairs' ends"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\tconst lowered = regionParts(node, cx, env, foldProbe(facts, shared))",
				replacement: "\t\tconst lowered = regionParts(node, cx, env, undefined)",
				why: "The region reads every fold whole, joined by its keys beside its aggregate, so each count folds every standard's supports for the read, whatever pairs it delivers."
			},
			{
				file: "packages/engine/src/lower/conservative/match-region/index.ts",
				original:
					"\t\t\tconst keysReady = keyed.get(o)?.keys.every((k) => value.has(k.variable)) ?? true",
				replacement: "\t\t\tconst keysReady = true",
				why: "A fold matched before the pair that binds its keys is placed first, its keys holding no value yet, so the read of the counts matched first dies compiling (`defined`)."
			}
		]
	})
