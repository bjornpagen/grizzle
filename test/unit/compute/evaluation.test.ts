/**
 * The test oracle's class of evaluation for numeric power (test/support/oracle/evaluate/catalog.ts): its outcome is
 * claimed only where both ends of the libm error model give it, and a base whose estimate straddles an integer is
 * declined. Oracle: the libm error model's two ends, the platform's log and log10 moved libmUlps units in the last place
 * either way.
 *
 * Features: an outcome claimed at both ends, a declined one.
 */

import { assert } from "@bjornpagen/testing/assert"
import type { Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeOp } from "#compiler/ir/expr.ts"
import {
	atLibmEnd,
	caseGen,
	evaluated,
	isDeclined,
	libmUlps,
	numericPower,
	outcome,
	type PowerFeature
} from "#test/unit/compute/evaluation.fixtures.ts"

/** The oracle's classes of evaluation claims numeric power's outcome only where both ends of the libm error model give it. Its budget is its suite's before it was a property (test/unit/compute/evaluation.test.ts at 4ca3036a): 300 runs and 300 steered cases. */
export const theOraclesClassesOfEvaluationClaimsNumericPowersOutcomeOnlyWhereBothEndsOfTheLibmErrorModelGiveIt =
	property.explore(caseGen, {
		needs: {},
		budget: { runs: 300, steered: 300 },
		situations: ["outcome claimed at both ends", "declined"] satisfies ReadonlyArray<
			Reached<PowerFeature>
		>,
		check: (_, c: Case<PowerFeature>) => (power) =>
			Effect.sync(() => {
				const result = evaluated(power)
				const at = describeOp(numericPower.id)
				if (power.planted) {
					assert.equal(outcome(result), `declined ${at}`)
				}
				assert.ok(
					result._tag === "Success" || result.failure.kind !== "unsupported",
					`${at}: ${outcome(result)}`
				)
				if (isDeclined(result)) {
					c.note("declined")
					return
				}
				/**
				 * A claimed outcome is every libm's within the model: at each end, the same, or declined where that end's
				 * own estimate leaves the model.
				 */
				const ends = Arr.map([-libmUlps, libmUlps], (n) => atLibmEnd(n, () => evaluated(power)))
				for (const end of ends) {
					if (!isDeclined(end)) {
						assert.equal(outcome(end), outcome(result), `${at} at a libm end`)
					}
				}
				if (!Arr.some(ends, isDeclined)) {
					c.note("outcome claimed at both ends")
				}
			}),
		oracle: { kind: "specification", name: "the libm error model's two ends" },
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/values/decimal.ts",
				original:
					'\t\tif (typeof negative !== "boolean" || typeof coefficient !== "bigint" || coefficient < 0n) {',
				replacement:
					'\t\tif (typeof negative === "boolean" || typeof coefficient !== "bigint" || coefficient < 0n) {',
				why: "Operator mutant (comparison) at packages/engine/src/scalar/values/decimal.ts:201 in <module>: `!==` becomes `===`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
