import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { defined, succeeded } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { type Point, productOf, sites } from "#test/unit/analysis/logical/join-cost.fixtures.ts"

/** The analysis of k joined relations of two keys each computes linearly many closures and key searches in k, never 2^k. */
export const theAnalysisOfKJoinedRelationsOfTwoKeysEachComputesLinearlyManyClosuresAndKeySearchesInKNever2K =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["from k = 4", "from k = 6"] satisfies ReadonlyArray<Reached<Point>>,
		check: (_, c: Case<Point>) => (half) =>
			Effect.gen(function* () {
				c.note(half === 2 ? "from k = 4" : "from k = 6")
				const counted = new Map<number, Readonly<Record<keyof typeof sites, number>>>()
				for (const k of [2 * half, 4 * half, 6 * half]) {
					const [, counts] = yield* callCounts(
						Effect.sync(() => succeeded(analyzeLogical(productOf(k), checkerEvidence))),
						sites
					)
					counted.set(k, counts)
				}
				for (const site of ["closure", "minimalKeys"] as const) {
					incrementsDoNotGrow(
						(k) => defined(counted.get(k), `the counts at k = ${k}`)[site],
						half,
						`${site} calls`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "k relations at 2h, 4h and 6h, h at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tconst delivered = intersect(factor, heading)",
				replacement:
					"\t\t\tconst delivered = intersect(factor, heading)\n\t\t\tfor (const _ of factors) {\n\t\t\t\tminimalKeys(delivered, [delivered], () => undefined, [])\n\t\t\t}",
				why: "A key search run for each factor once per factor, k² of them (logical/props.ts finish); the property fails."
			}
		]
	})
