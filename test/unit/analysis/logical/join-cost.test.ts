import { indices } from "@bjornpagen/grizzle-text/base/array"
import { assert, defined } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, int } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { keyFactors } from "#compiler/ir/keys.ts"
import { analyzeLogical, checkerEvidence } from "#compiler/logical/annotate.ts"
import { succeeded } from "#test/support/assert.ts"
import { incrementsDoNotGrow } from "#test/support/growth.ts"
import { callCounts } from "#test/support/kernel/calls.ts"
import { KeyKernel } from "#test/support/keys/kernel.ts"
import {
	type ClassPoint,
	classesOf,
	type Point,
	productOf,
	sites
} from "#test/unit/analysis/logical/join-cost.fixtures.ts"

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

/**
 * The analysis of k classes of s columns that determine one another and are never equal, tied into one factor of a
 * region's keys, computes linearly many closures and key searches in k, never s^k: each class is a factor of its own,
 * its first column its key and each other column alone an alternative (logical/props.ts finish, determinationClasses),
 * so the proof states every one of the s^k minimal keys as k factors of s - 1 alternatives each, and the key kernel
 * accepts it.
 */
export const theAnalysisOfKClassesOfSColumnsThatDetermineOneAnotherInOneFactorComputesLinearlyManyClosuresInKNeverSToTheK =
	property.exhaust(finite(int(2, 3)), {
		needs: {},
		situations: ["classes of two columns", "classes of three columns"] satisfies ReadonlyArray<
			Reached<ClassPoint>
		>,
		check: (_, c: Case<ClassPoint>) => (s) =>
			Effect.gen(function* () {
				c.note(s === 2 ? "classes of two columns" : "classes of three columns")
				const counted = new Map<number, Readonly<Record<keyof typeof sites, number>>>()
				for (const k of [2, 4, 6]) {
					const [analysis, counts] = yield* callCounts(
						Effect.sync(() => succeeded(analyzeLogical(classesOf(k, s), checkerEvidence))),
						sites
					)
					counted.set(k, counts)
					const region = defined(analysis.dag.roots[0], "the region")
					const { props } = analysis.of(region)
					const proof = defined(props.keys[0], "the region's key")
					assert.equal(props.keys.length, 1, "one proof of the region's keys")
					assert.deepEqual(
						proof.key,
						Arr.map(indices(k), (i) => `a${i}`),
						"the key is each class's first column"
					)
					assert.deepEqual(
						Arr.map(
							proof.factors,
							(f) =>
								`${Arr.join(f.key, ",")}: ${Arr.join(
									Arr.map(f.alternatives, (a) => Arr.join(a.columns, ",")),
									" "
								)}`
						),
						Arr.map(
							indices(k),
							(i) =>
								`a${i}: ${Arr.join(
									Arr.map(indices(s - 1), (j) => `y${i}_${j}`),
									" "
								)}`
						),
						"each class a factor of its own, each other column alone an alternative"
					)
					assert.equal(
						Arr.reduce(keyFactors(proof), 1, (n, choice) => n * choice.length),
						s ** k,
						"the factors state every choice of one column per class"
					)
					assert.deepEqual(
						new KeyKernel(analysis.dag, { keyedViews: false }).check(proof, region),
						[],
						"the key kernel accepts the proof"
					)
				}
				for (const site of ["closure", "minimalKeys"] as const) {
					incrementsDoNotGrow(
						(k) => defined(counted.get(k), `the counts at k = ${k}`)[site],
						1,
						`${site} calls`
					)
				}
			}),
		oracle: {
			kind: "universal",
			name: "a count that grows no faster than linearly increments no more over its second equal step than over its first"
		},
		box: "k classes at 2, 4 and 6, of s columns at 2 and 3",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/logical/props.ts",
				original: "\t\t\tif (at.length < 2) {",
				replacement: "\t\t\tif (at.length > 0) {",
				why: "No class is found, so the factor is searched whole, s^k minimal keys each found (logical/props.ts finish); the property fails."
			}
		]
	})
