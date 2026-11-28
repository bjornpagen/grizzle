/**
 * The work of every power the power suites draw, held to a measured limit: the oracle's port of numeric.c counts the
 * base-10000 digit operations it performs (test/support/oracle/evaluate/power.ts powerWork), the ones PostgreSQL's
 * power_var performs for the same power, and each power the proof admits, of the suites' edges, of the costliest power
 * the proof admits that they know, and of a batch of their generator (test/support/power-pairs.ts powerBatch), stays
 * within powerWorkLimit.
 *
 * The oracle: numeric.c's own truncations, mul_var's maxdigits and the series' working scales, bound the digits a
 * power's evaluation computes, and the limit is the costliest such power measured, with its margin; an evaluation that
 * computes past them, as an exact product would, passes it at the costliest power.
 *
 * Features: an admitted power evaluated, and a power next to exp(6000) evaluated.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { Numeric } from "#compiler/scalar/values/decimal.ts"
import { powerWork } from "#test/support/oracle/evaluate/power.ts"
import { costliest, edges, powerBatch, powerWorkLimit } from "#test/support/power-pairs.ts"
import { admitted, type WorkFeature } from "#test/unit/compute/power-work.fixtures.ts"

/** Numeric power's evaluation does no more digit work than numeric.c does, within the measured limit, for every power the suites draw. Its budget is its suite's before it was a property (test/unit/compute/power-work.test.ts at 4ca3036a): 4 runs and 8 steered cases. */
export const numericPowersEvaluationDoesNoMoreDigitWorkThanNumericCDoesWithinTheMeasuredLimitForEveryPowerTheSuitesDraw =
	property.explore(powerBatch, {
		needs: {},
		budget: { runs: 4, steered: 8 },
		situations: [
			"an admitted power evaluated",
			"a power next to exp(6000) evaluated"
		] satisfies ReadonlyArray<Reached<WorkFeature>>,
		check: (_, c: Case<WorkFeature>) => (batch) =>
			Effect.gen(function* () {
				const pairs = [
					...Arr.map([costliest, ...edges, ...batch.ordinary], (pair) => ({
						pair,
						near: false
					})),
					...Arr.map(batch.near, (pair) => ({ pair, near: true }))
				]
				for (const { pair, near } of pairs) {
					yield* Effect.yieldNow
					if (!admitted(pair)) {
						continue
					}
					const [a, b] = pair
					const { work } = powerWork(Numeric.of(a), Numeric.of(b))
					assert.ok(
						work <= powerWorkLimit,
						`power(${a}, ${b}) does ${work} digit operations, past ${powerWorkLimit}`
					)
					c.note("an admitted power evaluated")
					if (near) {
						c.note("a power next to exp(6000) evaluated")
					}
				}
			}),
		oracle: {
			kind: "specification",
			name: "numeric.c's truncations, which powerWorkLimit's measurement bounds"
		},
		kept: [],
		kills: [
			{
				file: "packages/engine/src/scalar/compute/builders.ts",
				original:
					'\tconst real: OpenExpr = { kind: "compute", fn, args: [a.real, ...others.map((o) => o.real)] }',
				replacement: '\tconst real: OpenExpr = { kind: "compute", fn, args: [a.real] }',
				why: "Operator mutant (element) at packages/engine/src/scalar/compute/builders.ts:536 in computeCall: `[a.real, ...others.map((o) => o.real)]` becomes `[a.real]`; the property fails (lane CATCH, grizzle 0baff5d6)."
			}
		]
	})
