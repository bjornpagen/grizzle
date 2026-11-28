/**
 * Injective representation through a cast: which native casts keep a key, judged by evaluating them.
 *
 * castInjective (ir/injective.ts) decides, without values, whether a native cast maps values that are
 * distinct under native equality to distinct values. The oracle evaluates the cast: every value of a dictionary of the
 * values the casts branch on (integer range edges, the integers binary32 and binary64 round onto their neighbours,
 * halves and ties, scales that round onto each other, the signed zeros, NaN and the infinities) is cast into each
 * source type by the test kernel's evaluator of the scalar catalogue (oracle/evaluate/catalog.ts), then into each target
 * type.
 *
 * - Soundness: a cast castInjective admits merges no two values of its source that native equality tells apart.
 *   A value the cast refuses (an overflow) is no merge: the cast fails rather than conflates.
 * - Precision, over the casts castInjective decides by rule (within a carrier, from an integer into an integer, a float
 *   or a numeric, and from a float into a float or an integer): a cast it refuses merges two values of the dictionary.
 *   The casts out of a numeric into another carrier and from a float into a numeric are outside the admitted set by
 *   design (some are exact at a typmod: numeric(5,0) into integer, any float into numeric), so they are judged for
 *   soundness only.
 *
 * Features: each family pair admitted or refused with a merge witnessed, and a value the cast refuses.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect, Formatter, Result } from "effect"
import { castInjective } from "#compiler/ir/injective.ts"
import type { ModelValue } from "#test/support/oracle/evaluate/catalog.ts"
import {
	castable,
	castChain,
	decided,
	dictionary,
	equalValues,
	family,
	type InjectiveFeature,
	types
} from "#test/unit/analysis/physical/injective.fixtures.ts"

/** CastInjective admits only casts that merge no two values of their source, and every refusal it decides has a merge. */
export const castInjectiveAdmitsOnlyCastsThatMergeNoTwoValuesOfTheirSourceAndEveryRefusalItDecidesHasAMerge =
	property.exhaust(
		finite((source) => [source.draw(element(types)), source.draw(element(types))] as const),
		{
			needs: {},
			situations: [
				"int4->int4 admitted",
				"int4->float admitted",
				"int4->float refused, a merge witnessed",
				"float->float admitted",
				"float->float refused, a merge witnessed",
				"float->int4 refused, a merge witnessed",
				"int4->numeric admitted",
				"int4->numeric refused, a merge witnessed",
				"numeric->numeric admitted",
				"numeric->numeric refused, a merge witnessed",
				"a value the cast refuses"
			] satisfies ReadonlyArray<Reached<InjectiveFeature>>,
			check:
				(_, c: Case<InjectiveFeature>) =>
				([from, to]) =>
					Effect.sync(() => {
						if (!castable(from.type, to.type)) {
							return
						}
						/** The source's values, distinct under its native equality, each with its image or the cast's refusal. */
						const values: Array<{
							readonly value: ModelValue
							readonly image: ModelValue | undefined
						}> = []
						for (const d of dictionary) {
							if (!castable(d.type, from.type)) {
								continue
							}
							const cast = castChain(d.literal, d.type, from.type, to.type)
							if (Result.isFailure(cast.source)) {
								continue
							}
							const value = cast.source.success
							if (Arr.some(values, (v) => equalValues(v.value, value, from.type))) {
								continue
							}
							if (Result.isFailure(cast.target) && cast.target.failure.kind === "unsupported") {
								throw new Error(
									`the evaluator cannot cast ${from.name} to ${to.name}: ${cast.target.failure.what}`
								)
							}
							if (Result.isFailure(cast.target)) {
								c.note("a value the cast refuses")
							}
							values.push({
								value,
								image: Result.isSuccess(cast.target) ? cast.target.success : undefined
							})
						}
						const merge = Arr.flatMap(values, (a, i) =>
							Arr.flatMap(values.slice(i + 1), (b) =>
								a.image !== undefined &&
								b.image !== undefined &&
								equalValues(a.image, b.image, to.type)
									? [[a.value, b.value] as const]
									: []
							)
						)
						const admitted = castInjective(from.type, to.type)
						const pairName = `${family(from.type)}->${family(to.type)}` as const
						if (admitted) {
							c.note(`${pairName} admitted`)
							const [witness] = merge
							if (witness !== undefined) {
								throw new Error(
									`castInjective admits ${from.name} -> ${to.name}, which merges ${Formatter.format(witness[0])} and ${Formatter.format(witness[1])}`
								)
							}
						} else if (decided(from.type, to.type)) {
							if (merge.length === 0) {
								throw new Error(
									`castInjective refuses ${from.name} -> ${to.name}, and no two values of the dictionary merge`
								)
							}
							c.note(`${pairName} refused, a merge witnessed`)
						}
					}),
			oracle: {
				kind: "second-implementation",
				name: "the scalar catalogue's evaluator casting every value of the dictionary into the source, then the target"
			},
			box: "every ordered pair of the integer, floating and exact numeric types",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/ir/injective.ts",
					original:
						"\t\t\t\treturn target === undefined || (source !== undefined && target >= source)",
					replacement: "\t\t\t\treturn target === undefined || source !== undefined",
					why: "A numeric cast to a smaller scale admitted as injective (ir/injective.ts castInjective); the soundness property fails."
				}
			]
		}
	)
