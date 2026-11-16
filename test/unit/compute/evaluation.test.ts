/**
 * The test oracle's classes of evaluation (test/support/oracle/evaluate/catalog.ts): which registry nodes the
 * reference evaluator claims exactly, estimates, or leaves to the database.
 *
 * - Power: numeric power's outcome is claimed only where both ends of the libm error model give it, and a base whose
 *   estimate straddles an integer is declined. Oracle: the libm error model's two ends, the platform's log and log10
 *   moved libmUlps units in the last place either way.
 * - IEEE exactness: a float node the oracle evaluates exactly is one IEEE 754 rounds correctly. Oracle: IEEE 754 §5.4's
 *   list of correctly rounded operations, over every node of the registry.
 *
 * Features: an outcome claimed at both ends, a declined one; an exact float node.
 */

import { word } from "@bjornpagen/testing/dictionary"
import type { Reached } from "@bjornpagen/testing/features"
import { finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { describeOp } from "#compiler/ir/expr.ts"
import { operandCarriers } from "#compiler/scalar/compute/registry.ts"
import { assert } from "#test/support/assert.ts"
import { evaluationOf } from "#test/support/oracle/evaluate/catalog.ts"
import { nativeOperations } from "#test/unit/compute/evaluation.dictionary.ts"
import {
	atLibmEnd,
	caseGen,
	evaluated,
	ieeeExact,
	isDeclined,
	isFloat,
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

/** The oracle's classes of evaluation evaluates exactly only the float operations IEEE 754 rounds correctly. */
export const theOraclesClassesOfEvaluationEvaluatesExactlyOnlyTheFloatOperationsIEEE754RoundsCorrectly =
	property.exhaust(finite(word(nativeOperations)), {
		needs: {},
		situations: ["an exact float node"] satisfies ReadonlyArray<Reached<"an exact float node">>,
		check: (_, c: Case<"an exact float node">) => (op) =>
			Effect.sync(() => {
				if (
					evaluationOf(op) !== "exact" ||
					!Arr.some([...operandCarriers(op.operands), op.result], isFloat)
				) {
					return
				}
				c.note("an exact float node")
				assert.ok(
					ieeeExact.has(op.fn),
					`${describeOp(op.id)} is evaluated exactly, but IEEE 754 rounds no ${op.fn}`
				)
			}),
		oracle: { kind: "specification", name: "IEEE 754's correctly rounded operations" },
		box: "every node of the registry",
		kept: [],
		kills: []
	})
