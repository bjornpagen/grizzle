/**
 * The page runtime on generated ordered queries, through the optimized artifact, which the page compiler builds and the runtime runs (generated.ts states the properties).
 *
 * Oracle: the conservative lowering's complete sorted distinct result D, which the windows of each walk cut, each
 * window's attachments D's children of its delivered rows.
 *
 * Features: generated.ts's PageFeature, every required one.
 */
import { ReplayToken } from "@bjornpagen/testing/property"
import { generatedProperty } from "#test/pg/page/generated.ts"

/**
 * The page runtime cuts generated ordered queries into windows through the optimized artifact at a drawn size per
 * direction, each case in its one rolled-back transaction on the worker's own clone (oracleProperty).
 *
 * Its pre-conversion budget: runs 2,000, coverage cases 2,000 (test/pg/page/generated.ts at fa10bca50).
 */
export const thePageRuntimeCutsGeneratedOrderedQueriesIntoWindowsThroughTheOptimizedArtifact =
	generatedProperty("optimized", [
		{
			token: ReplayToken(
				"test/pg/page/generated-optimized.test.ts#thePageRuntimeCutsGeneratedOrderedQueriesIntoWindowsThroughTheOptimizedArtifact:-:1"
			),
			reason:
				"page/generated-optimized, TEST_SEED=28094260: a nested key set over children keyed within one parent only, read without DISTINCT (generated.ts recordedPageCases)",
			since: "2026-11-11"
		}
	])
