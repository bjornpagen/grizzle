/**
 * A region that joins a fold by its grouping columns reads it per key (lower/conservative/match-region KeyedProbes,
 * lower/shapes/region keyedProbes): for each binding of the occurrences before it, the fold of that binding's keys
 * alone, LATERAL, the keys restricted below the aggregate, where the index the workload requests on them reads one
 * group's rows. On PostgreSQL 19, over learning-commons' crosswalk (fold-probe.fixtures.ts): the pairs of one standard, each
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
 *
 * Its budget, measured (fastcycle's cull):
 *
 * @limitKind measured
 * @owner test/pg/lower-shapes/fold-probe.test.ts, this property's search
 * @unit cases of the rotating stream; the floor stream runs a quarter of them, rounded up
 * @scope one search of this property in one run; the steered phase's cases, its cap, run only while a required
 *   situation is pending
 * @evidence `TEST_SEED=2219874524 pnpm exec toolchain-test kills test/pg/lower-shapes/fold-probe.test.ts` at its budget
 *   before, the runner's, runs 150 and steered 200, each kill's verdict printed with where its witnesses went red
 *   (judgedLine with the red's headline, a local print), in ~/.cache/grizzle-release/CULL-COMPUTE/kills-current.log;
 *   this budget run by path in run-budgets.log there
 * @observed 2026-11-23, 04:00 to 06:00 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB at load 440 to 530; PostgreSQL 19 in
 *   memory (the family grizzle-m-cull-compute); Node 26.13.1; grizzle at dbcb09929 with lane CULL-COMPUTE's cull,
 *   vendor/toolchain at 2cc4817
 * @workload each declared kill applied alone and judged on the property's witnesses: its kept cases, its floor stream
 *   and its steered phase, which no run seed moves
 * @result its 3 kills went red on case 0 of its floor stream, case 0 of its floor stream and case 1 of its floor
 *   stream, in the order it declares them
 * @decision the least runs whose floor stream, a quarter of them rounded up, holds its first 2 cases: 5; no headroom: a
 *   kill its witnesses stop killing fails the kill gate, which measures it again
 * @revalidate a change of its space, situations, kept cases or kills, of its label (the floor stream's seed), or of the
 *   runner's floor rule
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
		budget: { runs: 5, steered: 200 },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/lower/shapes/region/index.ts",
				original: "\t\tconst lowered = regionParts(node, cx, env, keyedProbes(facts, shared))",
				replacement: "\t\tconst lowered = regionParts(node, cx, env, undefined)",
				why: "The region reads every fold whole, joined by its keys beside its aggregate, so each count folds every standard's supports for the read, whatever pairs it delivers."
			},
			{
				file: "packages/engine/src/lower/optimize/cte-policy/index.ts",
				original: "\t\t\t(perKey.get(node) ?? 0) >= references\n",
				replacement: "\t\t\tfalse\n",
				why: "A fold two occurrences share is MATERIALIZED for the statement (rule 5, sharedExpensive), which the region's probe never reads per key: the CTE folds every standard's supports, and the read's scans of Supports read all of them."
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
