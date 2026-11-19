/**
 * Recursion admission factors several transition arms into one feedback scan, here over the arms that fix or repeat
 * a state column: the arm matching self with b fixed to a parameter, or with b repeating a, reads the current state
 * through equalities on it, beside the transitive arm, so the definition reads its feedback once and lowers. The
 * factoring of arms that read no self, of the reverse transition, of a negated fixed relation and of an importer's
 * parameters is unit/recursion/feedback-shape's; the state heading's casts are unit/recursion/state-heading's.
 *
 * Oracle: the factoring's statement (check/recursion/factor.ts) as a checker over every set of the two arms: one
 * feedback read, exactly the parameters the arms read, and a conservative lowering. Features: each arm, and both.
 */

import { assert } from "@bjornpagen/testing/assert"
import { type Reached } from "@bjornpagen/testing/features"
import { finite, subarray } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { succeeded } from "#test/support/assert.ts"
import { checkAuthored, checking, checkOptions } from "#test/support/policy.ts"
import { type Arm, pairs } from "#test/unit/recursion/admission.fixtures.ts"
import { Graph, lower, reads, theRecursive } from "#test/unit/recursion/fixtures.ts"

/** Factoring transition arms into one feedback scan factors arms that fix or repeat state columns as equalities on the current state, one feedback read, and lowers them. */
export const factoringTransitionArmsIntoOneFeedbackScanFactorsArmsThatFixOrRepeatStateColumnsAsEqualitiesOnTheCurrentStateOneFeedbackReadAndLowersThem =
	property.exhaust(finite(subarray<Arm>(["b repeating a", "b fixed to a parameter"])), {
		needs: {},
		situations: ["b repeating a", "b fixed to a parameter", "both"] satisfies ReadonlyArray<
			Reached<Arm | "both">
		>,
		check: (_, c: Case<Arm | "both">) => (arms) =>
			Effect.sync(() => {
				c.noteAll(arms)
				if (arms.length === 2) {
					c.note("both")
				}
				const q = succeeded(checkAuthored(checking(Graph), pairs(arms), checkOptions("query")))
				assert.equal(reads(q, theRecursive(q).self), 1, "one feedback read")
				assert.deepEqual(
					Arr.map(q.params, (p) => p.name),
					arms.includes("b fixed to a parameter") ? ["start"] : []
				)
				lower(q)
			}),
		oracle: {
			kind: "specification",
			name: "factor.ts: arms that fix or repeat a state column read the current state through equalities, one feedback read"
		},
		box: "every set of the two arms beside the transitive one: b repeating a, b fixed to a parameter",
		kept: [],
		kills: [
			{
				file: "packages/engine/src/check/recursion/factor.ts",
				original: "\t\t\t\t...substBindings(self.bindings, s),",
				replacement:
					'\t\t\t\t...Object.fromEntries(\n\t\t\t\t\tObject.entries(substBindings(self.bindings, s)).filter(([, e]) => e.kind === "var")\n\t\t\t\t),',
				why: "Factoring keeps only the self match's variable bindings, so an arm's state column fixed to a parameter is dropped from its current-state match; the factoring-equalities search fails."
			}
		]
	})
