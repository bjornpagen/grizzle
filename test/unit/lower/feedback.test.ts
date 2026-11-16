/**
 * The admission of a recursion's feedback by every lowering: the conservative one (lower/conservative/recursive
 * requireAdmittedFeedback, and conservative/self-ref for a second scan) and the optimized recursion lowerer
 * (lower/shapes/recursion/index.ts), which refuses through the same walk before it lowers. The rule, as their headers
 * state it: a recursion lowers only when its feedback is positive and linear, so no path from the step to its SelfRef
 * passes through an input that is not monotone and distributive over the feedback (a fold's, a bound's, the negated
 * side of an anti-join or a difference, either side of an intersection), every state column has a hash operator class,
 * and the step scans the feedback once. Otherwise every lowering refuses it as UnsupportedOperation, alike: the two
 * artifacts of a template refuse alike. Without the refusal an aggregate or bound over the feedback would fold one
 * iteration instead of the fixed point, a wrong answer and not an error, and an unhashable state column would fail the
 * recursive CTE with 0A000.
 *
 * The checker never admits these steps, so the property is exhaustive over generated ones: every operator (a fold, a
 * bound, an anti-join, a difference, an intersection, a union) over every arrangement of the three relations a step
 * reads (the feedback itself, a transition hop over it, a fixed seed), as the step or joined by its start to a hop, each
 * reading the feedback at least once and the one feedback node at most once per operator, over a hashable state and
 * one with a money column.
 *
 * Oracle: the rule as a model of the step's sketch (a specification): how often the step scans the feedback, and whether
 * the feedback flows into an input that is not positive, decide lowered or refused; the two lowerings' refusals, reason
 * and place, are compared with each other (a differential).
 *
 * Features: each verdict: lowered, refused for a block, for an unhashable state, for a second scan.
 */

import { type Reached } from "@bjornpagen/testing/features"
import { element, finite } from "@bjornpagen/testing/gen"
import { type Case, property } from "@bjornpagen/testing/property"
import { Effect, Formatter } from "effect"
import { assert, refused, succeeded } from "#test/support/assert.ts"
import {
	closure,
	conservative,
	located,
	optimized,
	type State,
	states,
	stepGen,
	type Verdict,
	verdictOf
} from "#test/unit/lower/feedback.fixtures.ts"

/** Every lowering admits exactly positive linear feedback over a hashable state lowers or refuses each step alike in every lowering. */
export const everyLoweringAdmitsExactlyPositiveLinearFeedbackOverAHashableStateLowersOrRefusesEachStepAlikeInEveryLowering =
	property.exhaust(
		finite(
			(source) =>
				[source.draw(stepGen), source.draw(element<State>(["hashable", "money"]))] as const
		),
		{
			needs: {},
			situations: [
				"lowered",
				"refused for a block",
				"refused for an unhashable state",
				"refused for a second scan"
			] satisfies ReadonlyArray<Reached<Verdict>>,
			check:
				(_, c: Case<Verdict>) =>
				([step, state]) =>
					Effect.sync(() => {
						const verdict = verdictOf(step, state)
						const b = closure(step, states[state])
						const at = Formatter.format(step)
						const fromConservative = conservative(b)
						const fromOptimized = optimized(b)
						c.note(verdict)
						if (verdict === "lowered") {
							succeeded(fromConservative, at)
							succeeded(fromOptimized, at)
							return
						}
						const expected = refused(fromConservative, "UnsupportedOperation", at)
						const got = refused(fromOptimized, "UnsupportedOperation", at)
						assert.deepEqual(located(got), located(expected), at)
					}),
			oracle: {
				kind: "specification",
				name: "positive linear feedback over a hashable state, read off the step's sketch; the two lowerings' refusals compared with each other"
			},
			box: "every operator over every arrangement of the feedback, a hop and a seed, as the step or joined to a hop, over a hashable state and a money one",
			kept: [],
			kills: [
				{
					file: "packages/engine/src/lower/conservative/recursive/index.ts",
					original:
						'\t\t\treturn { inputs: [node.left, node.right], what: "an intersection with the feedback" }',
					replacement:
						'\t\t\treturn { inputs: [node.left], what: "an intersection with the feedback" }',
					why: "The feedback walk (conservative/recursive nonPositive) blocks only an intersection's left side, so feedback through its right side is admitted; the search fails."
				}
			]
		}
	)
